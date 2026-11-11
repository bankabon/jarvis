"""Kiro CLI 常駐エージェント (ACP: Agent Client Protocol)。

`kiro-cli chat --no-interactive` は毎回の起動に約4秒かかる(MCP初期化+終了処理)。
`kiro-cli acp` を常駐させ、**空のセッションを先に作って温めておく(プール)**ことで、
依頼が来た時は温まったセッションにプロンプトを送るだけ(約2秒)にする。

- 履歴はこれまでどおり毎回プロンプトに含める(セッションは使い捨て)ので、AI間の引き継ぎ設計は変わらない
- 権限は ACP の許可要求(session/request_permission)に bridge が答える方式。依頼ごとのモードで判定できる:
    safe : 読み取り/検索のみ許可
    edit : + ファイルの作成・編集(kind=edit)。削除/移動/シェル実行/外部取得は拒否
    full : 全て許可
- 使えない時(起動失敗・クラッシュ等)は AcpUnavailable を投げ、呼び出し側が従来のCLI起動へフォールバックする
"""
import json
import os
import queue
import subprocess
import threading
import time

READ_KINDS = {"read", "search", "think"}
EDIT_KINDS = {"edit"}


class AcpUnavailable(Exception):
    pass


class _Ctx:
    def __init__(self, mode):
        self.mode = mode
        self.q: queue.Queue = queue.Queue()
        self.kinds: dict = {}      # toolCallId -> kind
        self.titles: dict = {}


class AcpKiro:
    def __init__(self, cwd: str, pool_size: int = 2):
        self.cwd = cwd
        self.pool_size = pool_size
        self.proc = None
        self.alive = False
        self.ready = False
        self._wlock = threading.Lock()
        self._id = 0
        self._pending: dict = {}      # id -> [Event, response]
        self._ctx: dict = {}          # sessionId -> _Ctx
        self._idle: list = []
        self._cv = threading.Condition()
        self._creating = 0
        self._active = 0           # 処理中の依頼数。処理中はセッション補充(重い)を止める
        self._stop = False
        self._failures = 0

    # ---------- プロセス管理 ----------
    def start(self):
        threading.Thread(target=self._supervisor, daemon=True).start()

    def stop(self):
        self._stop = True
        try:
            if self.proc:
                self.proc.terminate()
        except Exception:
            pass

    def available(self) -> bool:
        return self.alive and self.ready and not self._stop

    def _supervisor(self):
        while not self._stop:
            try:
                self._launch()
                self._failures = 0
                self._replenish_loop()           # プロセスが死ぬまで戻らない
            except Exception as e:  # noqa
                self._failures += 1
                print(f"[acp] 起動失敗({self._failures}): {e}", flush=True)
            self.alive = self.ready = False
            with self._cv:
                self._idle.clear(); self._creating = 0
            for slot in list(self._pending.values()):
                slot[1] = {"error": {"message": "acp process exited"}}; slot[0].set()
            for c in list(self._ctx.values()):
                c.q.put(("dead", None))
            if self._stop:
                return
            if self._failures >= 5:
                print("[acp] 連続失敗のため常駐を断念(従来のCLI起動で動作します)", flush=True)
                return
            time.sleep(min(30, 2 ** self._failures))

    def _launch(self):
        env = dict(os.environ)
        env["NO_COLOR"] = "1"
        self.proc = subprocess.Popen(["kiro-cli", "acp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, cwd=self.cwd, env=env)
        self.alive = True
        threading.Thread(target=self._reader, args=(self.proc,), daemon=True).start()
        threading.Thread(target=lambda p=self.proc: [None for _ in iter(p.stderr.readline, b"")], daemon=True).start()
        r = self._call("initialize", {"protocolVersion": 1, "clientCapabilities": {}}, timeout=30)
        if not r or "error" in r:
            raise RuntimeError(f"initialize failed: {r}")
        self.ready = True
        print("[acp] kiro-cli acp 常駐を開始しました", flush=True)

    def _replenish_loop(self):
        """空きセッションを pool_size 個に保つ。プロセスが死んだら戻る。"""
        while not self._stop and self.proc.poll() is None:
            with self._cv:
                need = self.pool_size - len(self._idle) - self._creating
                # 依頼の処理中に session/new(MCP初期化で数秒かかる)を走らせると、同じエージェント内で競合して遅くなる
                if need <= 0 or self._active > 0:
                    self._cv.wait(timeout=0.5)
                    continue
                need = 1                      # 1つずつ作り、毎回「処理中でないか」を確認する
                self._creating += need
            for _ in range(need):
                sid = None
                try:
                    r = self._call("session/new", {"cwd": self.cwd, "mcpServers": []}, timeout=60)
                    sid = (r or {}).get("result", {}).get("sessionId")
                except Exception:
                    pass
                with self._cv:
                    self._creating -= 1
                    if sid:
                        self._idle.append(sid)
                    self._cv.notify_all()
                if not sid:
                    time.sleep(2)

    # ---------- JSON-RPC ----------
    def _send(self, obj):
        data = (json.dumps(obj, ensure_ascii=False) + "\n").encode()
        with self._wlock:
            self.proc.stdin.write(data)
            self.proc.stdin.flush()

    def _call(self, method, params, timeout=60):
        with self._wlock:
            self._id += 1
            i = self._id
        slot = [threading.Event(), None]
        self._pending[i] = slot
        self._send({"jsonrpc": "2.0", "method": method, "params": params, "id": i})
        if not slot[0].wait(timeout):
            self._pending.pop(i, None)
            return None
        self._pending.pop(i, None)
        return slot[1]

    def _reader(self, proc):
        for raw in iter(proc.stdout.readline, b""):
            try:
                m = json.loads(raw)
            except Exception:
                continue
            if "id" in m and "method" not in m:                    # 応答
                slot = self._pending.get(m["id"])
                if slot:
                    slot[1] = m
                    slot[0].set()
            elif m.get("method") == "session/request_permission":  # 許可要求(こちらが答える)
                threading.Thread(target=self._on_permission, args=(m,), daemon=True).start()
            elif m.get("method") == "session/update":
                p = m.get("params") or {}
                c = self._ctx.get(p.get("sessionId"))
                if c:
                    c.q.put(("update", p.get("update") or {}))
        self.alive = False

    def _on_permission(self, m):
        p = m.get("params") or {}
        c = self._ctx.get(p.get("sessionId"))
        tc = p.get("toolCall") or {}
        tid = tc.get("toolCallId")
        raw = tc.get("rawInput") or {}
        kind = tc.get("kind") or (c.kinds.get(tid) if c else None)
        if kind is None:  # kind が無い場合の保守的な推定: path 付きのファイル作成/編集コマンドだけ edit 扱い
            if raw.get("path") and raw.get("command") in ("create", "str_replace", "insert", "append"):
                kind = "edit"
            elif str(tc.get("title", "")).startswith("Running"):
                kind = "execute"
        mode = c.mode if c else "safe"
        allow = mode == "full" or kind in READ_KINDS or (mode == "edit" and kind in EDIT_KINDS)
        opts = p.get("options") or []
        want = "allow_once" if allow else "reject_once"
        pick = next((o for o in opts if o.get("kind") == want), None)
        try:
            self._send({"jsonrpc": "2.0", "id": m["id"],
                        "result": {"outcome": {"outcome": "selected", "optionId": pick["optionId"]} if pick else {"outcome": "cancelled"}}})
        except Exception:
            pass
        if c:
            title = tc.get("title") or kind or "操作"
            c.q.put(("perm", (allow, title, kind)))

    # ---------- 1依頼の実行 ----------
    def _take_session(self, wait=25.0):
        end = time.time() + wait
        with self._cv:
            while not self._idle:
                if not self.available():
                    raise AcpUnavailable("agent not available")
                left = end - time.time()
                if left <= 0:
                    raise AcpUnavailable("no warm session")
                self._cv.wait(timeout=min(left, 0.5))
            sid = self._idle.pop(0)
            self._cv.notify_all()      # 補充スレッドを起こす
            return sid

    def run(self, prompt: str, mode: str, write, timeout: int = 900) -> int:
        if not self.available():
            raise AcpUnavailable("agent not available")
        t_wait = time.time()
        sid = self._take_session()
        waited = time.time() - t_wait
        if waited > 0.3:
            write({"t": "log", "level": "debug", "text": f"温まったセッションの待ち {waited:.1f}s"})
        with self._cv:
            self._active += 1
        ctx = _Ctx(mode)
        self._ctx[sid] = ctx
        write({"t": "log", "level": "debug", "text": f"ACP常駐エージェントで実行 (mode={mode})"})

        # session/prompt は完了まで応答が返らないので別スレッドで待つ
        done: dict = {}
        def prompt_call():
            try:
                done["r"] = self._call("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": prompt}]}, timeout=timeout)
            except Exception as e:  # noqa
                done["r"] = {"error": {"message": str(e)}}
            ctx.q.put(("finished", None))
        threading.Thread(target=prompt_call, daemon=True).start()

        buf, final_parts, status = [], [], {}
        def flush():
            t = "".join(buf).strip()
            if t:
                write({"t": "log", "level": "info", "text": t})
                final_parts.append(t)
            buf.clear()

        deadline = time.time() + timeout
        try:
            while True:
                if time.time() > deadline:
                    write({"t": "log", "level": "error", "text": f"タイムアウト({timeout}s)"})
                    self._send({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": sid}})
                    return 124
                try:
                    kind, val = ctx.q.get(timeout=0.5)
                except queue.Empty:
                    write({"t": "ping"})            # 切断検知(BrokenPipe)
                    continue
                if kind == "dead":
                    write({"t": "log", "level": "error", "text": "常駐エージェントが終了しました"})
                    return 1
                if kind == "finished":
                    break
                if kind == "perm":
                    allow, title, k = val
                    if allow:
                        write({"t": "log", "level": "debug", "text": f"✔ 許可: {title}"})
                    else:
                        write({"t": "log", "level": "tool", "text": f"🚫 実行せず(mode={mode}、種類={k}): {title}"})
                    continue
                u = val
                su = u.get("sessionUpdate")
                if su == "agent_message_chunk":
                    buf.append((u.get("content") or {}).get("text", ""))
                elif su == "tool_call":
                    flush()
                    tid = u.get("toolCallId")
                    ctx.kinds[tid] = u.get("kind")
                    ctx.titles[tid] = u.get("title")
                    write({"t": "log", "level": "tool", "text": f"🔧 [{u.get('kind')}] {u.get('title')}"})
                elif su == "tool_call_update":
                    tid = u.get("toolCallId")
                    if u.get("kind"):
                        ctx.kinds[tid] = u["kind"]
                    st = u.get("status")
                    if st and status.get(tid) != st and st in ("completed", "failed"):
                        write({"t": "log", "level": "error" if st == "failed" else "debug",
                               "text": f"↳ {ctx.titles.get(tid) or ''} {st}"})
                    status[tid] = st
            flush()
        except (BrokenPipeError, ConnectionResetError):
            try:
                self._send({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": sid}})
            except Exception:
                pass
            raise
        finally:
            self._ctx.pop(sid, None)
            with self._cv:
                self._active -= 1
                self._cv.notify_all()

        r = done.get("r") or {}
        stop = (r.get("result") or {}).get("stopReason")
        # 最後のメッセージ(ツール実行後の報告)を最終回答とする。無ければ全文
        final = final_parts[-1] if final_parts else ""
        if stop == "end_turn" and final:
            write({"t": "final", "text": final})
            return 0
        if stop == "cancelled":
            return 130
        write({"t": "log", "level": "error", "text": f"ACP応答エラー: {json.dumps(r, ensure_ascii=False)[:200]}"})
        return 1
