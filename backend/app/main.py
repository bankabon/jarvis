import asyncio
import json
import os
import re
import time

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from contextlib import asynccontextmanager

from . import asr, db, speaker, tts

BRIDGE_URL = os.environ.get("BRIDGE_URL", "http://host.docker.internal:8765").rstrip("/")
BRIDGE_TOKEN = os.environ.get("BRIDGE_TOKEN", "")
HEADERS = {"Authorization": f"Bearer {BRIDGE_TOKEN}"}

async def _purge_loop():
    while True:
        try:
            n = db.purge_expired_archives()
            if n:
                print(f"[archive] 保持期間を過ぎた会話を {n} 件削除しました", flush=True)
        except Exception as e:  # noqa
            print(f"[archive] purge error: {e}", flush=True)
        await asyncio.sleep(3600)


@asynccontextmanager
async def lifespan(_app):
    t = asyncio.create_task(_purge_loop())   # 起動時 + 1時間ごとに期限切れアーカイブを削除
    yield
    t.cancel()


app = FastAPI(title="JARVIS backend", lifespan=lifespan)
RUNNING: dict[int, asyncio.Task] = {}


# ---------- settings ----------
@app.get("/api/settings")
def get_settings():
    return db.get_settings()


@app.put("/api/settings")
def put_settings(patch: dict):
    return db.put_settings(patch)


# ---------- providers ----------
@app.get("/api/providers")
async def providers():
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(BRIDGE_URL + "/providers", headers=HEADERS)
        if r.status_code == 401:
            return {"bridge": False, "error": "bridge のトークンが一致しません", "providers": []}
        r.raise_for_status()
        return {"bridge": True, **r.json()}
    except Exception as e:
        return {"bridge": False, "error": f"bridge に接続できません ({BRIDGE_URL}): {e}", "providers": []}


# ---------- conversations ----------
@app.get("/api/conversations")
def list_conversations(archived: bool = False):
    rows = db.q(f"""SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) AS message_count,
                   (SELECT GROUP_CONCAT(DISTINCT provider) FROM messages m WHERE m.conversation_id=c.id AND provider IS NOT NULL) AS providers
                   FROM conversations c WHERE c.archived_at IS {'NOT NULL' if archived else 'NULL'}
                   ORDER BY {'c.archived_at' if archived else 'c.updated_at'} DESC LIMIT 500""")
    if archived:
        days = int(db.get_settings().get("archive_retention_days") or 180)
        for r in rows:
            r["expires_at"] = r["archived_at"] + days * 86400
            r["days_left"] = max(0, int((r["expires_at"] - time.time()) // 86400))
    return rows


@app.post("/api/conversations/{cid}/archive")
def archive_conversation(cid: int):
    if not db.one("SELECT id FROM conversations WHERE id=?", (cid,)):
        raise HTTPException(404)
    db.x("UPDATE conversations SET archived_at=? WHERE id=?", (time.time(), cid))
    return {"ok": True}


@app.post("/api/conversations/{cid}/unarchive")
def unarchive_conversation(cid: int):
    db.x("UPDATE conversations SET archived_at=NULL WHERE id=?", (cid,))
    return {"ok": True}


@app.post("/api/conversations")
def create_conversation():
    now = time.time()
    cid = db.x("INSERT INTO conversations(title,created_at,updated_at) VALUES(?,?,?)", ("新しい会話", now, now))
    return db.one("SELECT * FROM conversations WHERE id=?", (cid,))


@app.get("/api/conversations/{cid}")
def get_conversation(cid: int):
    c = db.one("SELECT * FROM conversations WHERE id=?", (cid,))
    if not c:
        raise HTTPException(404)
    c["messages"] = db.q("""SELECT m.*, t.status AS task_status FROM messages m
                           LEFT JOIN tasks t ON t.id=m.task_id WHERE m.conversation_id=? ORDER BY m.id""", (cid,))
    return c


@app.delete("/api/conversations/{cid}")
def delete_conversation(cid: int):
    db.x("DELETE FROM messages WHERE conversation_id=?", (cid,))
    db.x("DELETE FROM conversations WHERE id=?", (cid,))
    return {"ok": True}


# ---------- messaging / tasks ----------
CONFIRM_MARK = "[[CONFIRM]]"


class SendBody(BaseModel):
    text: str
    provider: str | None = None
    model: str | None = None


def build_prompt(cid: int, new_text: str, settings: dict, provider: str, confirm_rule: bool = True, note: str = "") -> str:
    """どのAIでも同じ形式で履歴を渡す = AIを切り替えても会話が引き継がれる。"""
    limit = int(settings.get("history_limit") or 20)
    hist = db.q("SELECT role, content, provider FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT ?",
                (cid, limit + 1))[::-1]
    hist = hist[:-1]  # 直前に保存した今回のユーザー発言は末尾で別扱い
    lines = []
    for m in hist:
        who = "ユーザー" if m["role"] == "user" else f"ジャービス(担当AI: {m['provider'] or '不明'})"
        c = m["content"]
        lines.append(f"[{who}] {c if len(c) <= 1500 else c[:1500] + '…'}")
    parts = [settings["persona"].strip()]
    if confirm_rule:
        parts.append(db.CONFIRM_RULE)
    if lines:
        parts.append("以下はこれまでの会話履歴です。担当AIが違う発言も、あなたが続きを引き継ぐ前提の同じ会話です。\n" + "\n".join(lines))
    parts.append(f"[ユーザー] {new_text}\n\n上記の最新のユーザー発言に対して、ジャービスとして返答してください。")
    if note:
        parts.append(note)
    return "\n\n".join(parts)


def add_event(task_id: int, level: str, text: str):
    db.x("INSERT INTO task_events(task_id,ts,level,text) VALUES(?,?,?,?)", (task_id, time.time(), level, text))


def finish(task_id: int, status: str, error: str | None = None):
    db.x("UPDATE tasks SET status=?, error=?, finished_at=? WHERE id=?", (status, error, time.time(), task_id))


async def run_task(task_id: int, cid: int, provider: str, prompt: str, mode: str, model: str | None, gated: bool = True):
    # mode: safe / edit / full
    final, code, last_info = "", None, ""
    try:
        add_event(task_id, "info", f"{provider} に依頼を送信しました" + (f"（モデル: {model}）" if model else "（モデル: 既定）"))
        async with httpx.AsyncClient(timeout=httpx.Timeout(None, connect=10)) as c:
            async with c.stream("POST", BRIDGE_URL + "/run", headers=HEADERS,
                                json={"provider": provider, "prompt": prompt, "mode": mode, "model": model}) as r:
                if r.status_code != 200:
                    raise RuntimeError(f"bridge HTTP {r.status_code}")
                async for line in r.aiter_lines():
                    if not line.strip():
                        continue
                    ev = json.loads(line)
                    t = ev.get("t")
                    if t == "log":
                        add_event(task_id, ev.get("level", "info"), ev.get("text", ""))
                        if ev.get("level") in ("info", "error") and ev.get("text", "").strip():
                            last_info = ev["text"].strip()
                    elif t == "final":
                        final = ev.get("text", "")
                    elif t == "done":
                        code = ev.get("code")
        if code == 0 and CONFIRM_MARK in final and gated:
            ask = final.split(CONFIRM_MARK, 1)[1].strip() or "この操作を実行してよいですか"
            msg = f"確認です。{ask} 実行してよろしいですか？"
            db.x("INSERT INTO messages(conversation_id,role,content,provider,task_id,created_at) VALUES(?,?,?,?,?,?)",
                 (cid, "assistant", msg, provider, task_id, time.time()))
            db.x("UPDATE conversations SET updated_at=? WHERE id=?", (time.time(), cid))
            db.x("UPDATE tasks SET confirm_text=? WHERE id=?", (ask, task_id))
            add_event(task_id, "tool", f"⚠ 確認待ち: {ask}")
            finish(task_id, "confirm")
        elif code == 0 and final.strip():
            final = final.replace(CONFIRM_MARK, "").strip() or final
            db.x("INSERT INTO messages(conversation_id,role,content,provider,task_id,created_at) VALUES(?,?,?,?,?,?)",
                 (cid, "assistant", final.strip(), provider, task_id, time.time()))
            db.x("UPDATE conversations SET updated_at=? WHERE id=?", (time.time(), cid))
            add_event(task_id, "info", "完了")
            finish(task_id, "done")
        else:
            msg = f"{provider} が失敗しました (exit={code})" + (f": {last_info[:200]}" if last_info else "")
            add_event(task_id, "error", msg)
            finish(task_id, "error", msg)
    except asyncio.CancelledError:
        add_event(task_id, "info", "ユーザー操作でキャンセルしました")
        finish(task_id, "cancelled")
    except Exception as e:
        add_event(task_id, "error", f"{type(e).__name__}: {e}")
        finish(task_id, "error", str(e))
    finally:
        RUNNING.pop(task_id, None)


ALLOW_ALL_RE = re.compile(r"(全部|全て|すべて|ぜんぶ|全件).{0,6}(許可|オーケー|OK|ok|任せ|いいよ)|全許可")
NEGATE_RE = re.compile(r"しない|しません|ないで|やめ|取り消|解除|戻")
REVOKE_RE = re.compile(r"許可.{0,3}(戻|取り消|解除)|全許可.{0,4}(解除|やめ|終了)|確認(して|する)ように")


def effective_mode(settings: dict, allow_all: bool) -> str:
    """全許可は『この会話でユーザーが全部許可と言った』か、設定で常時fullを明示選択した時だけ。"""
    if allow_all or settings["permission_mode"] == "full":
        return "full"
    return "safe" if settings["permission_mode"] == "safe" else "edit"


def start_task(cid: int, text: str, provider: str, note: str = "", user_text: str | None = None, once_full: bool = False, model: str | None = None) -> dict:
    s = db.get_settings()
    conv = db.one("SELECT * FROM conversations WHERE id=?", (cid,))
    model = (model or (s.get("default_models") or {}).get(provider) or "").strip() or None
    mode = effective_mode(s, bool(conv["allow_all"]))
    gated = mode != "full"          # 確認ルールを適用するか(全許可でない限り常に適用)
    if once_full and mode != "safe":
        mode = "full"               # 許可された1回だけ実行権限を上げる(次のタスクは元に戻る)
    now = time.time()
    shown = user_text if user_text is not None else text
    if conv["title"] == "新しい会話":
        db.x("UPDATE conversations SET title=? WHERE id=?", (shown[:30], cid))
    mid = db.x("INSERT INTO messages(conversation_id,role,content,provider,created_at) VALUES(?,?,?,?,?)",
               (cid, "user", shown, None, now))
    prompt = build_prompt(cid, text, s, provider, confirm_rule=gated, note=note)
    task_id = db.x("INSERT INTO tasks(conversation_id,provider,title,prompt,status,created_at,model) VALUES(?,?,?,?,?,?,?)",
                   (cid, provider, shown[:60], prompt, "running", now, model))
    db.x("UPDATE messages SET task_id=? WHERE id=?", (task_id, mid))
    db.x("UPDATE conversations SET updated_at=? WHERE id=?", (now, cid))
    RUNNING[task_id] = asyncio.create_task(run_task(task_id, cid, provider, prompt, mode, model, gated))
    return {"task_id": task_id, "message_id": mid, "provider": provider, "mode": mode, "model": model}


def pick_provider(requested: str | None) -> str:
    provider = requested or db.get_settings()["default_provider"]
    if not provider:
        raise HTTPException(400, "AIが選択されていません。設定で既定のAIを選んでください")
    return provider


@app.post("/api/conversations/{cid}/messages")
async def send_message(cid: int, body: SendBody):
    if not db.one("SELECT id FROM conversations WHERE id=?", (cid,)):
        raise HTTPException(404, "conversation not found")
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "empty")
    provider = pick_provider(body.provider)
    db.x("UPDATE conversations SET archived_at=NULL WHERE id=?", (cid,))  # アーカイブ済みの会話に発言したら自動で復元
    # ユーザー本人の発言でのみ全許可/解除が切り替わる(AIの出力では切り替わらない)
    if REVOKE_RE.search(text):
        db.x("UPDATE conversations SET allow_all=0 WHERE id=?", (cid,))
    elif ALLOW_ALL_RE.search(text) and not NEGATE_RE.search(text):
        db.x("UPDATE conversations SET allow_all=1 WHERE id=?", (cid,))
    return start_task(cid, text, provider, model=body.model)


class ApproveBody(BaseModel):
    all: bool = False


@app.post("/api/tasks/{tid}/approve")
async def approve(tid: int, body: ApproveBody):
    """確認待ちの操作を、ユーザーが許可した1回だけ full で実行する。all=True ならこの会話を全許可にする。"""
    t = db.one("SELECT * FROM tasks WHERE id=?", (tid,))
    if not t or t["status"] != "confirm":
        raise HTTPException(409, "確認待ちのタスクではありません")
    cid = t["conversation_id"]
    db.x("UPDATE tasks SET status='approved' WHERE id=?", (tid,))
    if body.all:
        db.x("UPDATE conversations SET allow_all=1 WHERE id=?", (cid,))
    ask = t["confirm_text"] or ""
    note = (f"【許可済み】ユーザーは次の操作の実行を明示的に許可しました: {ask}\n"
            "この操作のみ実行し、結果を簡潔に報告してください。それ以外の削除・実行は引き続き確認してください。")
    return start_task(cid, "はい、許可します。実行してください。", t["provider"], note=note, user_text="はい、許可します", once_full=True, model=t.get("model"))


@app.post("/api/tasks/{tid}/decline")
def decline(tid: int):
    t = db.one("SELECT * FROM tasks WHERE id=?", (tid,))
    if not t or t["status"] != "confirm":
        raise HTTPException(409, "確認待ちのタスクではありません")
    db.x("UPDATE tasks SET status='declined' WHERE id=?", (tid,))
    now = time.time()
    db.x("INSERT INTO messages(conversation_id,role,content,provider,created_at) VALUES(?,?,?,?,?)",
         (t["conversation_id"], "user", "やめてください（実行しないでください）", None, now))
    db.x("INSERT INTO messages(conversation_id,role,content,provider,created_at) VALUES(?,?,?,?,?)",
         (t["conversation_id"], "assistant", "承知しました。実行しません。", t["provider"], now + 0.001))
    return {"ok": True}


class AllowBody(BaseModel):
    value: bool


@app.put("/api/conversations/{cid}/allow_all")
def set_allow_all(cid: int, body: AllowBody):
    db.x("UPDATE conversations SET allow_all=? WHERE id=?", (1 if body.value else 0, cid))
    return {"allow_all": body.value}


@app.get("/api/tasks")
def list_tasks():
    return db.q("SELECT id,conversation_id,provider,model,title,status,error,created_at,finished_at FROM tasks ORDER BY id DESC LIMIT 200")


@app.get("/api/tasks/{tid}")
def get_task(tid: int):
    t = db.one("SELECT * FROM tasks WHERE id=?", (tid,))
    if not t:
        raise HTTPException(404)
    t["answer"] = (db.one("SELECT content FROM messages WHERE task_id=? AND role='assistant'", (tid,)) or {}).get("content")
    return t


@app.post("/api/tasks/{tid}/cancel")
def cancel_task(tid: int):
    t = RUNNING.get(tid)
    if t:
        t.cancel()
    return {"ok": bool(t)}


@app.delete("/api/tasks/{tid}")
def delete_task(tid: int):
    if tid in RUNNING:
        raise HTTPException(409, "実行中のタスクは先にキャンセルしてください")
    db.x("DELETE FROM task_events WHERE task_id=?", (tid,))
    db.x("DELETE FROM tasks WHERE id=?", (tid,))
    return {"ok": True}


@app.get("/api/tasks/{tid}/events")
async def task_events(tid: int, after: int = 0):
    """SSE: 過去ログを再生し、実行中ならライブで追従する。"""
    if not db.one("SELECT id FROM tasks WHERE id=?", (tid,)):
        raise HTTPException(404)

    async def gen():
        last = after
        while True:
            rows = db.q("SELECT id,ts,level,text FROM task_events WHERE task_id=? AND id>? ORDER BY id LIMIT 200", (tid, last))
            for r in rows:
                last = r["id"]
                yield f"data: {json.dumps(r, ensure_ascii=False)}\n\n"
            if not rows:
                st = db.one("SELECT status FROM tasks WHERE id=?", (tid,))
                if not st or st["status"] != "running":
                    yield f"event: end\ndata: {json.dumps({'status': st['status'] if st else 'gone'})}\n\n"
                    return
                yield ": keepalive\n\n"
                await asyncio.sleep(0.4)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------- TTS ----------
class TTSBody(BaseModel):
    text: str
    engine: str | None = None
    voice: str | None = None
    rate: int | None = None
    pitch: int | None = None


@app.get("/api/voices")
async def voices():
    s = db.get_settings()
    out = {"edge": await tts.edge_voices()}
    for eng, label in (("voicevox", "VOICEVOX"), ("aivis", "AivisSpeech")):
        out[eng], out[eng + "_error"] = [], None
        try:
            out[eng] = await tts.vv_speakers(s[eng + "_url"])
        except Exception as e:
            out[eng + "_error"] = f"{label} に接続できません ({s[eng + '_url']}): {type(e).__name__}"
    return out


@app.post("/api/tts")
async def synth(body: TTSBody):
    s = db.get_settings()
    engine = body.engine or s["tts_engine"]
    voice = body.voice or s["tts_voice"]
    rate = s["tts_rate"] if body.rate is None else body.rate
    pitch = s["tts_pitch"] if body.pitch is None else body.pitch
    text = tts.clean_text(body.text)[:800]
    if not text:
        raise HTTPException(400, "empty")
    try:
        if engine in ("voicevox", "aivis"):
            audio = await asyncio.wait_for(tts.vv_synth(text, voice, s[engine + "_url"], rate, pitch), 45)
            return Response(audio, media_type="audio/wav")
        audio = await asyncio.wait_for(tts.edge_synth(text, voice, rate, pitch), 25)
        return Response(audio, media_type="audio/mpeg")
    except Exception as e:
        # フロント側がブラウザ標準音声へフォールバックする
        raise HTTPException(502, f"tts failed: {type(e).__name__}: {e}")


@app.get("/api/health")
def health():
    return {"ok": True}


# ---------- 声の登録(話者認証) ----------
def _profiles(only_enabled=False):
    rows = db.q("SELECT * FROM speaker_profiles" + (" WHERE enabled=1" if only_enabled else "") + " ORDER BY id")
    return rows


@app.get("/api/speaker/profiles")
def speaker_profiles():
    out = []
    for p in _profiles():
        n = len(json.loads(p["samples"]))
        out.append({"id": p["id"], "name": p["name"], "enabled": bool(p["enabled"]), "n_samples": n, "created_at": p["created_at"]})
    return {"model_ready": speaker.ready(), "profiles": out}


class ProfileBody(BaseModel):
    name: str


@app.post("/api/speaker/profiles")
def speaker_create(body: ProfileBody):
    name = body.name.strip()[:30]
    if not name:
        raise HTTPException(400, "名前を入力してください")
    pid = db.x("INSERT INTO speaker_profiles(name,samples,enabled,created_at) VALUES(?,?,?,?)", (name, "[]", 1, time.time()))
    return {"id": pid, "name": name}


@app.delete("/api/speaker/profiles/{pid}")
def speaker_delete(pid: int):
    db.x("DELETE FROM speaker_profiles WHERE id=?", (pid,))
    return {"ok": True}


class EnabledBody(BaseModel):
    enabled: bool


@app.put("/api/speaker/profiles/{pid}/enabled")
def speaker_enable(pid: int, body: EnabledBody):
    db.x("UPDATE speaker_profiles SET enabled=? WHERE id=?", (1 if body.enabled else 0, pid))
    return {"ok": True}


@app.post("/api/speaker/profiles/{pid}/reset")
def speaker_reset(pid: int):
    db.x("UPDATE speaker_profiles SET samples='[]' WHERE id=?", (pid,))
    return {"ok": True}


@app.post("/api/speaker/profiles/{pid}/samples")
async def speaker_add_sample(pid: int, request: Request):
    """登録用の音声(16kHz mono int16 PCM)を1つ追加。品質(既存サンプルとの一貫性)を返す。"""
    p = db.one("SELECT * FROM speaker_profiles WHERE id=?", (pid,))
    if not p:
        raise HTTPException(404)
    a = speaker.analyze(await request.body())
    if a["sec"] < 2.0:
        raise HTTPException(422, f"録音が短すぎます({a['sec']:.1f}秒)。もう少し長く話してください")
    if a["rms"] < 0.005:
        raise HTTPException(422, "声が小さすぎます。マイクに近づいて話してください")
    e = await asyncio.to_thread(speaker.embed, a["x"])
    samples = json.loads(p["samples"])
    consistency = None
    if samples:
        consistency = float(speaker.centroid(samples) @ e)
        if consistency < 0.35:
            raise HTTPException(422, f"これまでの録音と声質が大きく違います(類似度{consistency:.2f})。同じ人が同じマイクで、周囲の音を減らして録り直してください")
    samples.append([round(float(v), 5) for v in e])
    db.x("UPDATE speaker_profiles SET samples=? WHERE id=?", (json.dumps(samples), pid))
    return {"n_samples": len(samples), "consistency": consistency, "seconds": round(a["sec"], 1)}


# ---------- 音声認識(Whisper) ----------
@app.post("/api/stt")
async def stt(request: Request):
    """16kHz mono int16 PCM を Whisper で文字起こしする。モデルが無い/失敗時は 503(フロントはブラウザ認識にフォールバック)。"""
    if not asr.ready():
        raise HTTPException(503, "whisper model not ready")
    a = speaker.analyze(await request.body())
    if a["sec"] < 0.3 or a["rms"] < 0.002:
        return {"text": "", "seconds": round(a["sec"], 2)}
    try:
        text = await asyncio.wait_for(asyncio.to_thread(asr.transcribe, a["x"]), 60)
    except Exception as e:
        raise HTTPException(503, f"stt failed: {type(e).__name__}: {e}")
    return {"text": text, "seconds": round(a["sec"], 2)}


@app.post("/api/speaker/verify")
async def speaker_verify(request: Request):
    """音声が登録した声の持ち主か判定する。登録が無ければ match=True(判定しない)。"""
    s = db.get_settings()
    profs = [p for p in _profiles(True) if json.loads(p["samples"])]
    if not profs:
        return {"match": True, "score": None, "reason": "no_profile"}
    a = speaker.analyze(await request.body())
    th = float(s["speaker_threshold"])
    if a["sec"] < speaker.MIN_SEC:
        return {"match": None, "score": None, "threshold": th, "seconds": round(a["sec"], 2), "reason": "too_short"}
    e = await asyncio.to_thread(speaker.embed, a["x"])
    best, who = speaker.score(profs, e)
    return {"match": best >= th, "score": round(best, 3), "threshold": th, "who": who["name"] if who else None, "seconds": round(a["sec"], 2)}
