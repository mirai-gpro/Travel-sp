# -*- coding: utf-8 -*-
"""秘密情報（API キー）をログ・エラー・応答に出さないための伏せ字処理"""
import re
import threading

_SECRETS = set()
_LOCK = threading.Lock()
_KEY_PARAM = re.compile(r'((?:[?&]|%3F|%26)key(?:=|%3D))[^&\s\'"<>)]+', re.IGNORECASE)
MASK = '***'


def register_secret(value):
    if value and len(value) >= 8:
        with _LOCK:
            _SECRETS.add(value)


def redact(text):
    if text is None:
        return None
    s = str(text)
    with _LOCK:
        secrets = list(_SECRETS)
    for v in secrets:
        s = s.replace(v, MASK)
    return _KEY_PARAM.sub(r'\1' + MASK, s)


def contains_secret(text):
    s = str(text)
    with _LOCK:
        secrets = list(_SECRETS)
    return any(v in s for v in secrets)
