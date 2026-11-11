"""話者(声紋)照合。登録した声の持ち主だけを通す。
sherpa-onnx + 3D-Speaker CAM++ で 192次元の話者埋め込みを作り、cosine類似度で照合する。
音声は 16kHz mono / int16 PCM(ブラウザが送る)。"""
import json
import os
import time

import numpy as np

MODEL = os.environ.get("SPEAKER_MODEL", "/models/speaker.onnx")
MIN_SEC = 1.2          # これより短い音声は埋め込みが不安定なので判定不能とする
MAX_SEC = 12.0
_ex = None


def extractor():
    global _ex
    if _ex is None:
        import sherpa_onnx
        _ex = sherpa_onnx.SpeakerEmbeddingExtractor(
            sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=MODEL, num_threads=2))
    return _ex


def ready() -> bool:
    return os.path.exists(MODEL)


def pcm_to_float(raw: bytes) -> np.ndarray:
    return np.frombuffer(raw[: len(raw) // 2 * 2], dtype="<i2").astype(np.float32) / 32768.0


def embed(x: np.ndarray) -> np.ndarray:
    ex = extractor()
    s = ex.create_stream()
    s.accept_waveform(16000, x[: int(MAX_SEC * 16000)])
    s.input_finished()
    e = np.array(ex.compute(s), dtype=np.float32)
    return e / (np.linalg.norm(e) + 1e-9)


def analyze(raw: bytes) -> dict:
    x = pcm_to_float(raw)
    sec = len(x) / 16000
    rms = float(np.sqrt(np.mean(x ** 2))) if len(x) else 0.0
    return {"x": x, "sec": sec, "rms": rms}


def centroid(samples: list) -> np.ndarray:
    c = np.mean(np.array(samples, dtype=np.float32), axis=0)
    return c / (np.linalg.norm(c) + 1e-9)


def score(profiles: list, e: np.ndarray) -> tuple[float, dict | None]:
    """登録(有効)プロファイルのうち最も近いものの類似度"""
    best, who = -1.0, None
    for p in profiles:
        s = json.loads(p["samples"])
        if not s:
            continue
        v = float(centroid(s) @ e)
        if v > best:
            best, who = v, p
    return best, who
