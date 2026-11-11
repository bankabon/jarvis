"""音声認識(Whisper small, sherpa-onnx)。16kHz mono int16 PCM を受け取り、文字起こしを返す。"""
import os
import threading

import numpy as np

MODEL_DIR = os.environ.get("WHISPER_MODEL_DIR", "/models/whisper")
LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "ja")
_rec = None
_lock = threading.Lock()   # 認識器は同時利用しない


def _find(suffix: str) -> str:
    for f in sorted(os.listdir(MODEL_DIR)):
        if f.endswith(suffix) and "int8" in f:
            return os.path.join(MODEL_DIR, f)
    for f in sorted(os.listdir(MODEL_DIR)):
        if f.endswith(suffix):
            return os.path.join(MODEL_DIR, f)
    raise FileNotFoundError(f"{suffix} not found in {MODEL_DIR}")


def ready() -> bool:
    try:
        _find("encoder.onnx"); _find("decoder.onnx")
        return True
    except Exception:
        return False


def recognizer():
    global _rec
    if _rec is None:
        import sherpa_onnx
        tokens = next(os.path.join(MODEL_DIR, f) for f in os.listdir(MODEL_DIR) if f.endswith("tokens.txt"))
        _rec = sherpa_onnx.OfflineRecognizer.from_whisper(
            encoder=_find("encoder.onnx"), decoder=_find("decoder.onnx"), tokens=tokens,
            language=LANGUAGE, task="transcribe", num_threads=4)
    return _rec


def transcribe(x: np.ndarray) -> str:
    with _lock:
        r = recognizer()
        s = r.create_stream()
        s.accept_waveform(16000, x)
        r.decode_stream(s)
        return s.result.text.strip()
