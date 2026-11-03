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
# Whisper small.en as CTranslate2 (MIT), pinned to a commit and by checksum.
ARG WHISPER=https://huggingface.co/Systran/faster-whisper-small.en/resolve/d1d751a5f8271d482d14ca55d9e2deeebbae577f
ADD --chmod=644 --checksum=sha256:666a9605530ac1f61fa8177f3702b4dacec9966749e42610839fcc32661d5fae $WHISPER/config.json models/faster-whisper-small.en/
ADD --chmod=644 --checksum=sha256:62b2a45b05ee59acb4a5341b33ee35e041395d378d418a18acfe4c9e768ee37a $WHISPER/model.bin models/faster-whisper-small.en/
ADD --chmod=644 --checksum=sha256:929c5252409436dce1b38a75d1abbcb5e132d170d8e324e4e04ed915fa2d22df $WHISPER/tokenizer.json models/faster-whisper-small.en/
ADD --chmod=644 --checksum=sha256:ff77588746d3a2595d32ab5b69ffd7b95ce2441ac57533cb66fc3eb575a115cf $WHISPER/vocabulary.txt models/faster-whisper-small.en/
# Beat This! checkpoint (MIT).
ADD --chmod=644 --checksum=sha256:8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331 \
    https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/final0.ckpt models/beat_this-final0.ckpt
COPY contract.py audio.py models.py vocals.py rhythm.py words.py speech.py beat_grid.py server.py selfcheck.py ./
CMD ["python", "server.py"]
