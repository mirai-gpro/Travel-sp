FROM python:3.11-slim

WORKDIR /app

# 依存関係をインストール
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# アプリケーションファイルをコピー（3ファイル構成 + 長期記憶）
COPY app_customer_support.py .
COPY support_core.py .
COPY api_integrations.py .
COPY long_term_memory.py .
COPY templates/ templates/
COPY prompts/ prompts/

# ポートを公開
EXPOSE 8080

# Gunicornで実行
CMD exec gunicorn --bind :$PORT --workers 1 --threads 8 --timeout 0 app_customer_support:app
