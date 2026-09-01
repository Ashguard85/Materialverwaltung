FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    DATA_DIR=/app/data

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
RUN mkdir -p /app/data/backups && useradd --system --uid 10001 --create-home appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8080
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD python -c "import json,urllib.request; d=json.load(urllib.request.urlopen('http://127.0.0.1:8080/health',timeout=3)); raise SystemExit(0 if d.get('status')=='ok' else 1)"
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "1", "--threads", "4", "--timeout", "60", "app.app:app"]
