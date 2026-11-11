FROM python:3.12-slim
WORKDIR /srv
ENV PYTHONUNBUFFERED=1
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# 話者(声紋)照合モデル。ビルド時に取得して同梱する
ARG SPK_MODEL=3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx
RUN mkdir -p /models && python -c "import urllib.request,sys; urllib.request.urlretrieve('https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/${SPK_MODEL}', '/models/speaker.onnx')" \
 && ls -la /models
# 音声認識(Whisper small, sherpa-onnx形式)。ビルド時に取得して同梱する
ARG WHISPER_MODEL=sherpa-onnx-whisper-small
RUN python -c "import urllib.request; urllib.request.urlretrieve('https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${WHISPER_MODEL}.tar.bz2', '/tmp/w.tar.bz2')" \
 && mkdir -p /models/whisper && python -c "import tarfile; t=tarfile.open('/tmp/w.tar.bz2','r:bz2'); ms=t.getmembers(); [setattr(m,'name',m.name.split('/',1)[1]) for m in ms if '/' in m.name]; t.extractall('/models/whisper', members=[m for m in ms if '/' in m.name or m.isfile()])" && rm /tmp/w.tar.bz2 \
 && ls -la /models/whisper
COPY app ./app
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
