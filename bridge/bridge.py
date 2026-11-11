#!/usr/bin/env python3
"""JARVIS host bridge.

Docker 内のバックエンドから、ホスト(あなたのPC)にログイン済みの
AI CLI (kiro-cli / claude / codex) を安全に呼び出すための中継サーバー。

- 標準ライブラリのみ。ホストで直接起動する (start.sh が起動する)
- 既定は 127.0.0.1 バインド + Bearer トークン認証
- 実行結果は NDJSON でストリーミング返却する
    {"t":"log","level":"info|tool|error|debug","text":"..."}
    {"t":"final","text":"最終回答"}
    {"t":"done","code":0}
- クライアントが切断したら CLI プロセスグループごと kill する
"""
import json
import os
import queue
import re
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from acp_kiro import AcpKiro, AcpUnavailable

HOST = os.environ.get("BRIDGE_HOST", "127.0.0.1")
PORT = int(os.environ.get("BRIDGE_PORT", "8765"))
TOKEN = os.environ.get("BRIDGE_TOKEN", "")
TIMEOUT = int(os.environ.get("BRIDGE_TIMEOUT", "900"))
# "full"(全ツール自動許可)をバックエンドから要求できるか。既定は不可 = 安全側
ALLOW_FULL = os.environ.get("BRIDGE_ALLOW_FULL", "0") == "1"
# Kiro を常駐(ACP)で動かして高速化する。0 で無効(毎回CLIを起動)
KIRO_ACP = os.environ.get("BRIDGE_KIRO_ACP", "1") == "1"
WORKDIR = Path(os.environ.get("BRIDGE_WORKDIR", str(Path.home() / "jarvis-workspace"))).expanduser()

ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07")

PROVIDERS = {
    "kiro": {"label": "Kiro CLI", "bin": "kiro-cli"},
    "claude": {"label": "Claude Code", "bin": "claude"},
    "codex": {"label": "ChatGPT (Codex CLI)", "bin": "codex"},
}

ACP: AcpKiro | None = None
_version_cache: dict = {}
_models_cache: dict = {}
MODEL_OK = re.compile(r"^[A-Za-z0-9._:/\-\[\]]{1,80}$")

# 一覧取得コマンドが無いAIの候補(自由入力も可)
STATIC_MODELS = {
    "claude": [
        {"id": "opus", "label": "opus（最新Opus・高性能）"},
        {"id": "sonnet", "label": "sonnet（最新Sonnet・バランス）"},
        {"id": "haiku", "label": "haiku（最新Haiku・高速）"},
    ],
    "codex": [
        {"id": "gpt-5-codex", "label": "gpt-5-codex"},
        {"id": "gpt-5", "label": "gpt-5"},
    ],
}


def list_models(provider: str) -> list:
    """モデル候補。kiro は CLI から動的取得(5分キャッシュ)、他は定番候補。いずれも自由入力可。"""
    if provider == "kiro" and shutil.which("kiro-cli"):
        hit = _models_cache.get("kiro")
        if hit and time.time() - hit[0] < 300:
            return hit[1]
        try:
            r = subprocess.run(["kiro-cli", "chat", "--list-models", "--format", "json"], capture_output=True,
                               text=True, timeout=30, stdin=subprocess.DEVNULL)
            data = json.loads(r.stdout)
            out = [{"id": m["model_id"], "label": f"{m['model_id']}（{m.get('rate_multiplier', '?')}x）"} for m in data.get("models", [])]
            if out:
                _models_cache["kiro"] = (time.time(), out)
                return out
        except Exception:
            pass
        return []
    return STATIC_MODELS.get(provider, [])


def clean(s: str) -> str:
    return ANSI.sub("", s).replace("\r", "")


def provider_info() -> list:
    out = []
    for key, p in PROVIDERS.items():
        path = shutil.which(p["bin"])
        ver = None
        if path:
            if path not in _version_cache:
                try:
                    r = subprocess.run([path, "--version"], capture_output=True, text=True,
                                       timeout=8, stdin=subprocess.DEVNULL)
                    _version_cache[path] = clean((r.stdout or r.stderr).strip().splitlines()[0]) if (r.stdout or r.stderr).strip() else ""
                except Exception:
                    _version_cache[path] = ""
            ver = _version_cache[path]
        out.append({"id": key, "label": p["label"], "installed": bool(path), "version": ver,
                    "models": list_models(key) if path else []})
    return out


def effective_mode(mode: str) -> str:
    if mode == "full" and not ALLOW_FULL:
        return "edit"
    return mode if mode in ("safe", "edit", "full") else "safe"


def build_cmd(provider: str, mode: str, model: str | None) -> list:
    """プロンプトは常に stdin で渡す(長さ・先頭ハイフン問題を避ける)。"""
    # mode: safe(読み取りのみ) / edit(ファイル作成・編集のみ。削除とシェル実行は不可) / full(全許可)
    mode = effective_mode(mode)
    if model and not MODEL_OK.match(model):
        raise ValueError(f"不正なモデル名: {model!r}")
    if provider == "claude":
        cmd = ["claude", "-p", "--output-format", "stream-json", "--verbose"]
        if model:
            cmd += ["--model", model]
        if mode == "full":
            cmd += ["--dangerously-skip-permissions"]
        elif mode == "edit":
            # acceptEdits は rm/mv 等の Bash も自動許可するので Bash 自体を禁止する
            cmd += ["--permission-mode", "acceptEdits", "--disallowedTools", "Bash", "--add-dir", str(WORKDIR)]
        return cmd
    if provider == "kiro":
        cmd = ["kiro-cli", "chat", "--no-interactive", "--trust-workspace"]
        if mode == "full":
            cmd += ["--trust-all-tools"]
        elif mode == "edit":
            cmd += ["--trust-tools=fs_read,fs_write"]   # シェル/delete_file は未信頼=実行されない
        else:
            cmd += ["--trust-tools="]
        if model:
            cmd += ["--model", model]
        return cmd
    if provider == "codex":
        cmd = ["codex", "exec", "--skip-git-repo-check"]
        # 注意: codex の workspace-write は作業フォルダ内の rm を防げない(persona の確認ルールに依存)
        cmd += {"full": ["--full-auto"], "edit": ["--sandbox", "workspace-write"]}.get(mode, ["--sandbox", "read-only"])
        if model:
            cmd += ["--model", model]
        cmd += ["-"]
        return cmd
    raise ValueError(f"unknown provider: {provider}")


def summarize_tool_input(inp) -> str:
    try:
        s = json.dumps(inp, ensure_ascii=False)
    except Exception:
        s = str(inp)
    return s if len(s) <= 300 else s[:300] + "…"


def handle_claude_line(line: str, emit, state: dict):
    """claude の stream-json を人が読めるログと最終回答に変換する。"""
    try:
        ev = json.loads(line)
    except Exception:
        emit("log", text=line, level="debug")
        return
    t = ev.get("type")
    if t == "system" and ev.get("subtype") == "init":
        emit("log", text=f"セッション開始 model={ev.get('model')}", level="info")
    elif t == "assistant":
        for b in ev.get("message", {}).get("content", []):
            if b.get("type") == "text" and b.get("text", "").strip():
                state["last_text"] = b["text"]
                emit("log", text=b["text"], level="info")
            elif b.get("type") == "tool_use":
                emit("log", text=f"🔧 {b.get('name')} {summarize_tool_input(b.get('input'))}", level="tool")
    elif t == "user":
        content = ev.get("message", {}).get("content", [])
        if isinstance(content, list):
            for b in content:
                if b.get("type") == "tool_result":
                    c = b.get("content")
                    if isinstance(c, list):
                        c = " ".join(x.get("text", "") for x in c if isinstance(x, dict))
                    c = str(c or "")
                    emit("log", text="↳ " + (c if len(c) <= 400 else c[:400] + "…"),
                         level="error" if b.get("is_error") else "debug")
    elif t == "result":
        state["result"] = ev.get("result") or state.get("last_text") or ""
        state["is_error"] = bool(ev.get("is_error"))
        if ev.get("total_cost_usd") is not None:
            emit("log", text=f"完了 cost=${ev.get('total_cost_usd')} turns={ev.get('num_turns')}", level="debug")


NOISE = re.compile(r"^\[(INFO|DEBUG)\]")


def run_provider(req: dict, write) -> int:
    provider = req.get("provider")
    prompt = req.get("prompt") or ""
    mode = req.get("mode") or "safe"
    model = req.get("model") or None
    if provider not in PROVIDERS:
        write({"t": "log", "level": "error", "text": f"未対応のAI: {provider}"})
        return 2
    if not shutil.which(PROVIDERS[provider]["bin"]):
        write({"t": "log", "level": "error",
               "text": f"{PROVIDERS[provider]['bin']} がこのPCに見つかりません (PATH を確認)"})
        return 127
    WORKDIR.mkdir(parents=True, exist_ok=True)
    # Kiro は常駐エージェント(ACP)で高速実行。モデル指定がある時・使えない時は従来のCLI起動
    if provider == "kiro" and not model and ACP is not None and ACP.available():
        try:
            return ACP.run(prompt, effective_mode(mode), write)
        except AcpUnavailable as e:
            write({"t": "log", "level": "debug", "text": f"常駐エージェントを使えないため通常起動に切替: {e}"})
    try:
        cmd = build_cmd(provider, mode, model)
    except ValueError as e:
        write({"t": "log", "level": "error", "text": str(e)})
        return 2
    write({"t": "log", "level": "debug", "text": "$ " + " ".join(cmd) + f"   (cwd={WORKDIR}, mode={effective_mode(mode)})"})
    if mode == "full" and not ALLOW_FULL:
        write({"t": "log", "level": "info", "text": "full モードは BRIDGE_ALLOW_FULL=1 で起動した時のみ有効。edit で実行します"})

    env = dict(os.environ)
    env["NO_COLOR"] = "1"
    env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "1"
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            cwd=str(WORKDIR), env=env, start_new_session=True)

    def kill():
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            time.sleep(1.0)
            os.killpg(proc.pid, signal.SIGKILL)
        except Exception:
            pass

    q: queue.Queue = queue.Queue()

    def pump(stream, tag):
        for raw in iter(stream.readline, b""):
            q.put((tag, raw.decode("utf-8", "replace")))
        q.put((tag, None))

    threading.Thread(target=pump, args=(proc.stdout, "out"), daemon=True).start()
    threading.Thread(target=pump, args=(proc.stderr, "err"), daemon=True).start()
    try:
        proc.stdin.write(prompt.encode("utf-8"))
        proc.stdin.close()
    except Exception:
        pass

    state: dict = {}
    plain_out: list = []
    open_streams = 2
    deadline = time.time() + TIMEOUT
    try:
        while open_streams:
            if time.time() > deadline:
                write({"t": "log", "level": "error", "text": f"タイムアウト({TIMEOUT}s)"})
                kill()
                return 124
            try:
                tag, line = q.get(timeout=0.5)
            except queue.Empty:
                write({"t": "ping"})  # 切断検知(BrokenPipe)用
                continue
            if line is None:
                open_streams -= 1
                continue
            line = clean(line).rstrip("\n")
            if tag == "err":
                if line.strip() and not NOISE.match(line):
                    write({"t": "log", "level": "debug", "text": line})
                continue
            if provider == "claude":
                if line.strip():
                    handle_claude_line(line, lambda k, **kw: write({"t": k, **kw}), state)
            else:
                plain_out.append(line)
                if line.strip():
                    write({"t": "log", "level": "info", "text": line})
        code = proc.wait(timeout=10)
    except (BrokenPipeError, ConnectionResetError):
        kill()
        raise
    except Exception:
        kill()
        raise

    if provider == "claude":
        final = state.get("result") or state.get("last_text") or ""
        if state.get("is_error") and code == 0:
            code = 1
    else:
        final = "\n".join(plain_out).strip()
    write({"t": "final", "text": final})
    return code


class Handler(BaseHTTPRequestHandler):
    server_version = "JarvisBridge/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[bridge] " + (fmt % args) + "\n")

    def _auth(self) -> bool:
        got = self.headers.get("Authorization", "")
        if TOKEN and secrets.compare_digest(got, f"Bearer {TOKEN}"):
            return True
        self.send_response(401)
        self.end_headers()
        self.wfile.write(b"unauthorized")
        return False

    def do_GET(self):
        if not self._auth():
            return
        if self.path == "/providers":
            body = json.dumps({"providers": provider_info(), "allow_full": ALLOW_FULL,
                               "workdir": str(WORKDIR)}, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if not self._auth():
            return
        if self.path != "/run":
            self.send_response(404)
            self.end_headers()
            return
        try:
            n = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            self.send_response(400)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        def write(obj):
            self.wfile.write((json.dumps(obj, ensure_ascii=False) + "\n").encode())
            self.wfile.flush()

        try:
            code = run_provider(req, write)
            write({"t": "done", "code": code})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # noqa
            try:
                write({"t": "log", "level": "error", "text": f"bridge error: {e}"})
                write({"t": "done", "code": 1})
            except Exception:
                pass


def main():
    if not TOKEN:
        print("BRIDGE_TOKEN が未設定です。start.sh から起動するか .env を設定してください。", file=sys.stderr)
        sys.exit(1)
    if HOST not in ("127.0.0.1", "localhost"):
        print(f"[bridge] 注意: {HOST} にバインド中。トークン必須。ファイアウォールで外部公開しないこと。", file=sys.stderr)
    global ACP
    WORKDIR.mkdir(parents=True, exist_ok=True)
    if KIRO_ACP and shutil.which("kiro-cli"):
        ACP = AcpKiro(str(WORKDIR))
        ACP.start()

    def _bye(*_):
        if ACP:
            ACP.stop()
        os._exit(0)
    signal.signal(signal.SIGTERM, _bye)
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    print(f"[bridge] listening on http://{HOST}:{PORT}  workdir={WORKDIR}  allow_full={ALLOW_FULL}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if ACP:
            ACP.stop()


if __name__ == "__main__":
    main()
