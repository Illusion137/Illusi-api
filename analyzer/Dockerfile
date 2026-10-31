# syntax=docker/dockerfile:1.7
FROM python:3.12-slim
# ffmpeg decodes every input (.m4a/AAC, .webm/.ogg Opus+Vorbis, mp3, flac, ...) to WAV before analysis (audio.py).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg git libsndfile1 && rm -rf /var/lib/apt/lists/* \
    && for c in aac opus vorbis mp3 flac; do ffmpeg -hide_banner -decoders | grep -qE "^ A.{5} $c " || { echo "ffmpeg lacks $c decoder"; exit 1; }; done
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Essentia's vocal models (CC BY-NC-SA 4.0), pinned by checksum.
ADD --chmod=644 --checksum=sha256:a280825b334797cf677939db8cd5762c0392aedd0ca6415dbc1cd083f045e43c \
    https://essentia.upf.edu/models/feature-extractors/discogs-effnet/discogs-effnet-bsdynamic-1.onnx models/
ADD --chmod=644 --checksum=sha256:20155e4c439714b0c45c08644b73c8e12d9dccb173bd4ab9934bf1e5aee837ca \
    https://essentia.upf.edu/models/classification-heads/voice_instrumental/voice_instrumental-discogs-effnet-1.onnx models/
COPY contract.py audio.py models.py vocals.py server.py selfcheck.py ./
CMD ["python", "server.py"]
