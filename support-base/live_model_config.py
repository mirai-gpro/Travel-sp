# -*- coding: utf-8 -*-
"""
LLM モデル設定（モデル ID とモデルごとの値をこのファイル 1 か所に集約）

- Live API のモデル ID は環境変数 LIVE_API_MODEL で上書きできる。未設定ならコードの既定値を使う。
- 文章生成（REST）のモデル ID は環境変数 GEMINI_TEXT_MODEL で上書きできる。未設定ならコードの既定値を使う。
- モデルごとに違い得る値（再接続の閾値など）は LIVE_MODEL_PROFILES に置く。
- LIVE_MODEL_PROFILES に無いモデル ID が指定されたら起動時に止める
  （別モデルの値のまま黙って動かさない）。
- 新しいモデルを試すときは、LIVE_MODEL_PROFILES に 1 行足してから、
  検証用 revision の環境変数 LIVE_API_MODEL だけを変える。
"""

import os
from dataclasses import dataclass

DEFAULT_LIVE_API_MODEL = "gemini-3.1-flash-live-preview"
DEFAULT_TEXT_MODEL = "gemini-2.5-flash"


@dataclass(frozen=True)
class LiveModelProfile:
    """Live API のモデルごとの値"""
    max_ai_chars_before_reconnect: int  # 1 接続内の AI 発話の累積文字数がこれ以上で再接続
    long_speech_threshold: int          # 1 回の AI 発話がこの文字数以上で再接続


LIVE_MODEL_PROFILES = {
    # 値は stt_stream.py から転記（変更禁止）
    "gemini-3.1-flash-live-preview": LiveModelProfile(
        max_ai_chars_before_reconnect=800,
        long_speech_threshold=500,
    ),
}


def _model_id_from_env(env_name: str, default: str) -> str:
    value = os.getenv(env_name)
    if value is None:
        return default
    value = value.strip()
    if not value:
        raise RuntimeError(f"環境変数 {env_name} が空です。モデル ID を指定するか、変数を削除してください")
    return value


LIVE_API_MODEL = _model_id_from_env("LIVE_API_MODEL", DEFAULT_LIVE_API_MODEL)
if LIVE_API_MODEL not in LIVE_MODEL_PROFILES:
    raise RuntimeError(
        f"LIVE_API_MODEL={LIVE_API_MODEL!r} は LIVE_MODEL_PROFILES に登録されていません。"
        f"登録済み: {sorted(LIVE_MODEL_PROFILES)}"
    )
LIVE_MODEL_PROFILE = LIVE_MODEL_PROFILES[LIVE_API_MODEL]

TEXT_MODEL = _model_id_from_env("GEMINI_TEXT_MODEL", DEFAULT_TEXT_MODEL)


def model_info() -> dict:
    """ログ・/health 表示用"""
    return {
        "live": LIVE_API_MODEL,
        "live_source": "env" if os.getenv("LIVE_API_MODEL") is not None else "default",
        "live_profile": {
            "max_ai_chars_before_reconnect": LIVE_MODEL_PROFILE.max_ai_chars_before_reconnect,
            "long_speech_threshold": LIVE_MODEL_PROFILE.long_speech_threshold,
        },
        "text": TEXT_MODEL,
        "text_source": "env" if os.getenv("GEMINI_TEXT_MODEL") is not None else "default",
    }
