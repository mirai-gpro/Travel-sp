# -*- coding: utf-8 -*-
"""
Interactions API の SSE 受信と、推薦 JSON の逐次トラッカー（Gate M1 の計測用から製品コードへ昇格。poc 版は M1〜M3 再現用に残す）

- SseReader: バイト列のチャンクを受け取り、行単位（UTF-8 の途中で切れても安全）に `event:` / `data:` を組み立てる
- CandidateStreamTracker: 文字単位の JSON トークナイザー（文字列・エスケープ・入れ子を追跡）。
  ルートの "candidates" 配列の各要素について
    * early: rank（整数）・name（空でない文字列）・area_hint（文字列）の値が確定した時刻
    * full : その店舗オブジェクトが閉じ、json.loads で独立に解析でき、必須項目と型の検証に通った時刻
  を記録する。正規表現や部分一致の文字列検索では確定扱いしない。
"""
import json

REQUIRED_STR = ('name', 'area_hint', 'specialty', 'reason')


class SseReader:
    def __init__(self):
        self._buf = b''
        self._event = None
        self._data = []

    def feed(self, chunk: bytes):
        """完成したイベント [(event_name, data_str)] を返す"""
        out = []
        self._buf += chunk
        while b'\n' in self._buf:
            line, self._buf = self._buf.split(b'\n', 1)
            line = line.rstrip(b'\r').decode('utf-8')
            if line == '':
                if self._event is not None or self._data:
                    out.append((self._event, '\n'.join(self._data)))
                self._event, self._data = None, []
            elif line.startswith(':'):
                continue
            elif line.startswith('event:'):
                self._event = line[6:].strip()
            elif line.startswith('data:'):
                self._data.append(line[5:].lstrip(' '))
        return out

    def flush(self):
        out = []
        if self._buf:
            rest, self._buf = self._buf, b''
            out = self.feed(rest + b'\n\n')
        elif self._event is not None or self._data:
            out.append((self._event, '\n'.join(self._data)))
            self._event, self._data = None, []
        return out


class _Frame:
    __slots__ = ('kind', 'parent_key', 'key', 'expect', 'start', 'fields', 'index')

    def __init__(self, kind, parent_key, start):
        self.kind, self.parent_key, self.start = kind, parent_key, start
        self.key, self.expect, self.fields, self.index = None, 'key' if kind == 'obj' else 'value', {}, -1


class CandidateStreamTracker:
    def __init__(self, required_str=REQUIRED_STR):
        self.required_str = tuple(required_str)   # 店舗オブジェクトの必須文字列項目（既定は推薦 LLM 一括版と同じ）
        self.buf = []            # 受信テキスト（文字のリスト）
        self.pos = 0
        self.stack = []
        self.in_str = False
        self.esc = False
        self.str_start = None
        self.str_is_key = False
        self.prim_start = None
        self.root_closed = False
        self.root_fields = {}
        self.candidates = []     # [{'index','early_t','full_t','obj','fields','error'}]
        self.errors = []         # 構文上の異常（想定外の文字など）

    # ---------------------------------------------------------------- 内部
    def _at_candidate(self):
        """現在のフレームが ルート.candidates[i] のオブジェクトか（構造だけで判定）"""
        return len(self.stack) == 3 and self.stack[2].kind == 'obj' and self.stack[1].kind == 'arr' \
            and self.stack[1].parent_key == 'candidates' and self.stack[0].kind == 'obj'

    def _cand_frame(self):
        """現在のフレームが ルート.candidates[i] のオブジェクトなら (frame, cand) を返す"""
        if self._at_candidate():
            return self.stack[2], self.candidates[self.stack[1].index]
        return None, None

    def _value_done(self, raw: str, t: float):
        frame = self.stack[-1] if self.stack else None
        if frame is None:
            return
        try:
            val = json.loads(raw)
        except ValueError:
            self.errors.append(f'invalid_value_at_{self.pos}')
            return
        if frame.kind == 'obj':
            frame.fields[frame.key] = val
            frame.expect = 'comma'
            if len(self.stack) == 1:
                self.root_fields[frame.key] = val
            f, cand = self._cand_frame()
            if f is not None:
                cand['fields'][frame.key] = val
                cand['field_t'].setdefault(frame.key, t)
                self._check_early(cand, t)
        else:
            frame.expect = 'comma'

    def _check_early(self, cand, t):
        fl = cand['fields']
        if cand['early_t'] is None and isinstance(fl.get('rank'), int) and not isinstance(fl.get('rank'), bool) \
                and isinstance(fl.get('name'), str) and fl['name'].strip() and isinstance(fl.get('area_hint'), str):
            cand['early_t'] = t

    def _end_primitive(self, t):
        if self.prim_start is not None:
            raw = ''.join(self.buf[self.prim_start:self.pos]).strip()
            self.prim_start = None
            self._value_done(raw, t)

    def _open(self, kind, t):
        parent = self.stack[-1] if self.stack else None
        pkey = parent.key if parent is not None and parent.kind == 'obj' else None
        fr = _Frame(kind, pkey, self.pos)
        if parent is not None and parent.kind == 'arr':
            parent.index += 1
            parent.expect = 'comma'
        elif parent is not None:
            parent.expect = 'comma'
        self.stack.append(fr)
        if self._at_candidate():
            self.candidates.append({'index': self.stack[1].index + 1, 'start_t': t, 'early_t': None, 'full_t': None,
                                    'fields': {}, 'field_t': {}, 'obj': None, 'error': None})

    def _close(self, kind, t):
        if not self.stack or self.stack[-1].kind != kind:
            self.errors.append(f'unexpected_close_at_{self.pos}')
            return
        f, cand = self._cand_frame()
        fr = self.stack.pop()
        if f is fr:
            raw = ''.join(self.buf[fr.start:self.pos + 1])
            try:
                obj = json.loads(raw)
            except ValueError:
                cand['error'] = 'invalid_json'
                return
            cand['obj'] = obj
            cand['error'] = validate_item(obj, cand['index'], self.required_str)
            if cand['error'] is None:
                cand['full_t'] = t
        if not self.stack:
            self.root_closed = True

    # ---------------------------------------------------------------- 公開
    def feed(self, text: str, t: float):
        for ch in text:
            self.buf.append(ch)
            if self.in_str:
                if self.esc:
                    self.esc = False
                elif ch == '\\':
                    self.esc = True
                elif ch == '"':
                    self.in_str = False
                    raw = ''.join(self.buf[self.str_start:self.pos + 1])
                    if self.str_is_key:
                        try:
                            self.stack[-1].key = json.loads(raw)
                        except ValueError:
                            self.errors.append(f'invalid_key_at_{self.pos}')
                        self.stack[-1].expect = 'colon'
                    else:
                        self._value_done(raw, t)
                self.pos += 1
                continue
            if self.prim_start is not None and ch in ',}] \t\r\n':
                self._end_primitive(t)
            if ch == '"':
                self.in_str = True
                self.str_start = self.pos
                top = self.stack[-1] if self.stack else None
                self.str_is_key = top is not None and top.kind == 'obj' and top.expect == 'key'
            elif ch == '{':
                self._open('obj', t)
            elif ch == '[':
                self._open('arr', t)
            elif ch == '}':
                self._close('obj', t)
            elif ch == ']':
                self._close('arr', t)
            elif ch == ':':
                if self.stack and self.stack[-1].kind == 'obj':
                    self.stack[-1].expect = 'value'
            elif ch == ',':
                if self.stack:
                    self.stack[-1].expect = 'key' if self.stack[-1].kind == 'obj' else 'value'
            elif ch in ' \t\r\n':
                pass
            elif self.prim_start is None and self.stack:
                self.prim_start = self.pos
            self.pos += 1

    def text(self) -> str:
        return ''.join(self.buf)

    def summary(self):
        return {'root_closed': self.root_closed, 'in_string_at_end': self.in_str, 'open_depth': len(self.stack),
                'n_started': len(self.candidates), 'n_full': sum(1 for c in self.candidates if c['full_t'] is not None),
                'syntax_errors': list(self.errors)}


def validate_item(obj, index, required_str=REQUIRED_STR):
    """recommender.parse_and_validate の 1 件分と同じ規則（重複は全体検証側で判定）"""
    if not isinstance(obj, dict):
        return 'invalid_output_schema'
    for k in required_str:
        if not isinstance(obj.get(k), str):
            return 'invalid_output_schema'
    rank = obj.get('rank')
    if not isinstance(rank, int) or isinstance(rank, bool):
        return 'invalid_output_schema'
    if rank != index:
        return 'invalid_output_rank'
    if not obj['name'].strip():
        return 'invalid_output_empty_name'
    return None
