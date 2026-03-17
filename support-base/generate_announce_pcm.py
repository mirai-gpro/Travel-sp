#!/usr/bin/env python3
"""
定型アナウンス音声のPCMファイル生成スクリプト

GCP Text-to-Speech API で LINEAR16 (24kHz, mono) の raw PCM を生成する。
LiveAPI出力と同一フォーマットのため、A2Eパイプラインにそのまま流せる。

使い方:
    python generate_announce_pcm.py

環境変数:
    GOOGLE_APPLICATION_CREDENTIALS: GCPサービスアカウントキーのパス
"""

import os
import sys

from google.cloud import texttospeech

# 生成する音声ファイルの定義
ANNOUNCEMENTS = {
    # 検索中フォロー（5秒経過時に再生）
    "search_wait_1": "只今、お店の情報を確認中です。もう少々お待ちください。",
    "search_wait_2": "お店を探しております。少々お待ちくださいませ。",
    "search_wait_3": "ご希望に合うお店を探しています。もう少しお待ちください。",
    # ショップ紹介つなぎ（検索結果表示後に再生）
    "shop_intro_1": "お待たせしました。お店をご紹介しますね。",
    "shop_intro_2": "お待たせいたしました。おすすめのお店をご紹介します。",
    "shop_intro_3": "お店が見つかりました。早速ご紹介させていただきます。",
}

# LiveAPI出力と同一の音声設定
VOICE_NAME = "ja-JP-Chirp3-HD-Leda"
SAMPLE_RATE = 24000


def main():
    client = texttospeech.TextToSpeechClient()
    output_dir = os.path.join(os.path.dirname(__file__), "audio")
    os.makedirs(output_dir, exist_ok=True)

    voice = texttospeech.VoiceSelectionParams(
        language_code="ja-JP",
        name=VOICE_NAME,
    )
    audio_config = texttospeech.AudioConfig(
        audio_encoding=texttospeech.AudioEncoding.LINEAR16,
        sample_rate_hertz=SAMPLE_RATE,
    )

    for name, text in ANNOUNCEMENTS.items():
        synthesis_input = texttospeech.SynthesisInput(text=text)
        response = client.synthesize_speech(
            input=synthesis_input, voice=voice, audio_config=audio_config
        )

        # LINEAR16レスポンスはWAVヘッダ(44bytes)付きなので除去してraw PCMにする
        raw_pcm = response.audio_content[44:]

        output_path = os.path.join(output_dir, f"{name}.pcm")
        with open(output_path, "wb") as f:
            f.write(raw_pcm)

        duration_sec = len(raw_pcm) / (SAMPLE_RATE * 2)  # 16bit = 2 bytes/sample
        print(f"  {name}.pcm: {len(raw_pcm)} bytes ({duration_sec:.1f}s)")

    print(f"\n全{len(ANNOUNCEMENTS)}ファイルを {output_dir}/ に生成しました。")


if __name__ == "__main__":
    main()
