# -*- coding: utf-8 -*-
"""
API キーの漏えい防止（修正3）。
- 登録した秘密値（API キー）と、URL の key= パラメータを伏せ字にする。
- requests の例外メッセージは URL（key= を含む）を含むことがあるため、エラー文字列は必ず redact() を通す。
"""
import re
import threading

_SECRETS = set()
_LOCK = threading.Lock()
_KEY_PARAM = re.compile(r'((?:[?&]|%3F|%26)key(?:=|%3D))[^&\s\'"<>)]+', re.IGNORECASE)
MASK = '***REDACTED***'


def register_secret(value):
    if value and len(value) >= 8:
        with _LOCK:
            _SECRETS.add(value)


def redact(text):
    if text is None:
        return text
    s = str(text)
    with _LOCK:
        secrets = list(_SECRETS)
    for v in secrets:
        s = s.replace(v, MASK)
    return _KEY_PARAM.sub(r'\1' + MASK, s)


def find_leaks(text):
    """伏せ字化されていない秘密値・key= パラメータが残っていれば、その種類を返す（値そのものは返さない）"""
    s = str(text)
    found = []
    with _LOCK:
        secrets = list(_SECRETS)
    if any(v in s for v in secrets):
        found.append('registered_secret')
    for m in _KEY_PARAM.finditer(s):
        if not s[m.end(1):].startswith(MASK):
            found.append('key_param')
            break
    return found
