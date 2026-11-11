"""音声合成。edge-tts(無料・自然な日本語) / AivisSpeech(VOICEVOX互換, ローカル)。
失敗した場合はフロントがブラウザ標準音声へフォールバックする。"""
import re

import edge_tts
import httpx

_voices_cache: list | None = None

FALLBACK_EDGE = [
    {"id": "ja-JP-NanamiNeural", "name": "Nanami (女性・自然)", "gender": "Female"},
    {"id": "ja-JP-KeitaNeural", "name": "Keita (男性・自然)", "gender": "Male"},
]


def clean_text(t: str) -> str:
    t = re.sub(r"```.*?```", "。コードは画面をご覧ください。", t, flags=re.S)
    t = re.sub(r"https?://\S+", "リンク", t)
    t = re.sub(r"[`*_#>|]+", "", t)
    t = re.sub(r"^\s*[-・]\s*", "", t, flags=re.M)
    return re.sub(r"\s+", " ", t).strip()


async def edge_voices() -> list:
    global _voices_cache
    if _voices_cache is None:
        try:
            vs = await edge_tts.list_voices()
            _voices_cache = [
                {"id": v["ShortName"], "name": f"{v['ShortName'].split('-', 2)[-1].replace('Neural', '')} ({'女性' if v['Gender'] == 'Female' else '男性'})",
                 "gender": v["Gender"]}
                for v in vs if v.get("Locale") == "ja-JP"
            ] or FALLBACK_EDGE
        except Exception:
            return FALLBACK_EDGE
    return _voices_cache


async def edge_synth(text: str, voice: str, rate: int, pitch: int) -> bytes:
    comm = edge_tts.Communicate(text, voice, rate=f"{rate:+d}%", pitch=f"{pitch:+d}Hz")
    buf = bytearray()
    async for ch in comm.stream():
        if ch["type"] == "audio":
            buf += ch["data"]
    if not buf:
        raise RuntimeError("edge-tts returned no audio")
    return bytes(buf)


async def vv_speakers(url: str) -> list:
    """VOICEVOX / AivisSpeech (VOICEVOX互換API) の話者一覧"""
    async with httpx.AsyncClient(timeout=4) as c:
        r = await c.get(url.rstrip("/") + "/speakers")
        r.raise_for_status()
    out = []
    for sp in r.json():
        for st in sp.get("styles", []):
            out.append({"id": str(st["id"]), "name": f"{sp['name']} / {st['name']}"})
    return out


async def vv_synth(text: str, speaker: str, url: str, rate: int, pitch: int = 0) -> bytes:
    base = url.rstrip("/")
    async with httpx.AsyncClient(timeout=40) as c:
        r = await c.post(base + "/audio_query", params={"text": text, "speaker": speaker})
        r.raise_for_status()
        query = r.json()
        query["speedScale"] = max(0.5, min(2.0, 1 + rate / 100))
        query["pitchScale"] = max(-0.15, min(0.15, pitch / 200))   # 画面の ±30 → ±0.15
        r2 = await c.post(base + "/synthesis", params={"speaker": speaker}, json=query)
        r2.raise_for_status()
        return r2.content
