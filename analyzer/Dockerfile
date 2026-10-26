FROM python:3.12-slim
# ffmpeg decodes every input (.m4a/AAC, .webm/.ogg Opus+Vorbis, mp3, flac, ...) to WAV before analysis (audio.py).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg git libsndfile1 && rm -rf /var/lib/apt/lists/* \
    && for c in aac opus vorbis mp3 flac; do ffmpeg -hide_banner -decoders | grep -qE "^ A.{5} $c " || { echo "ffmpeg lacks $c decoder"; exit 1; }; done
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY contract.py audio.py models.py server.py selfcheck.py ./
CMD ["python", "server.py"]
