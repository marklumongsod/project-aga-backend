# Internal model service. The raw data is mounted read-only at /data; it is never copied into the image.
FROM python:3.11-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

ENV NEW_CENTER_DATA_DIR=/data
ENV NEW_CENTER_MODEL_DIR=/app/models
EXPOSE 8010
CMD ["uvicorn", "service:app", "--host", "0.0.0.0", "--port", "8010"]
