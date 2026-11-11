"""SQLite 永続化層。会話・メッセージ・タスク・タスクログ・設定。

メッセージには「どのAIが答えたか(provider)」を保存するので、
途中でAIを切り替えても履歴をそのまま次のAIに引き継げる。
"""
import json
import os
import sqlite3
import threading
import time

DB_PATH = os.environ.get("DB_PATH", "/data/jarvis.db")
_lock = threading.RLock()
_conn: sqlite3.Connection | None = None

DEFAULT_PERSONA = (
    "あなたは私専属の音声AI執事「ジャービス」です。返事は声で読み上げられるので、日本語の自然な話し言葉で、とにかく短く答えてください。\n"
    "・基本は1〜2文、60文字以内。結論から先に言う。\n"
    "・了解、確認、簡単な質問への返事は一言でよい（例：「はい、確認します」「完了しました」「東京です」）。\n"
    "・作業をしたら、結果を一言で報告する。経緯や詳細は、聞かれた時だけ話す。\n"
    "・長く話してよいのは次の場合だけ：私が「詳しく」「説明して」と頼んだ時／エラーや危険など重要な知らせ／削除などの確認で内容を正確に伝える必要がある時。その場合も要点を先に言い、最大5文まで。\n"
    "・Markdown記法、箇条書き、コードブロック、URLの読み上げは避ける。\n"
    "・ただしコードの作成や修正を頼まれた時は、上記の短縮ルールを適用せず、依頼内容を正確に満たす完全なコードを書く。コード本体は省略や要約をしない。作業後の報告だけ一言で短く話す。"
)
OLD_PERSONA_PREFIX = "あなたは私専属の音声AI執事「ジャービス」です。日本語で、簡潔に"   # 旧い既定(更新時に置き換える)

# システムが強制する確認ルール(persona の編集で消えないよう別管理)。全許可でない時だけ付与する
CONFIRM_RULE = (
    "【確認ルール】ファイルの削除・上書きによる破壊・移動、シェルコマンドの実行、メール送信や外部投稿など"
    "取り消せない操作が必要な場合は、絶対に自分で実行せず、最終回答を次の1行だけにしてください:\n"
    "[[CONFIRM]] (これから行う操作を、対象を明示して一文で説明)\n"
    "ユーザーが許可した後の依頼でのみ実行できます。ファイルの新規作成や編集、読み取りは確認なしで進めてかまいません。"
)

DEFAULT_SETTINGS = {
    "setup_done": False,
    "default_provider": "",          # 初期設定で選ぶ
    "permission_mode": "confirm",    # confirm(標準:作成/編集は可・削除/実行は都度確認) | safe(読み取りのみ) | full(常に全許可・非推奨)
    "persona": DEFAULT_PERSONA,
    "history_limit": 20,
    "archive_retention_days": 180,   # アーカイブした会話を自動削除するまでの日数(半年)
    "default_models": {},             # {"kiro": "claude-sonnet-5.5", ...} 空=そのAIの既定モデル
    "tts_engine": "edge",            # edge | voicevox | aivis | browser
    "tts_voice": "ja-JP-NanamiNeural",
    "tts_rate": 0,                   # -50..+50 (%)
    "tts_pitch": 0,                  # -50..+50 (Hz)
    "voicevox_url": "http://voicevox:50021",   # docker-compose の voicevox サービス。PCのアプリ版なら http://host.docker.internal:50021
    "aivis_url": "http://host.docker.internal:10101",
    "browser_voice": "",
    "auto_speak": True,
    "speak_limit": 140,              # 読み上げる最大文字数(超えたら先頭の数文だけ読み、続きは画面表示)。0=全文
    "quick_ack": True,               # 声で依頼した時、返事が遅ければ先に「はい、確認します」と一言返す
    "stage_enabled": True,           # ハンズフリー中はジャービスが話している専用画面にする
    "mic_gate": True,                # 周囲より十分大きい声だけ採用する
    "mic_margin_db": 12,             # 周囲音(学習値)より何dB大きければ「声」とみなすか。大きいほど荒い(近くの大きな声だけ拾う)
    "mic_min_db": -55,               # これ未満は常に無視(絶対下限)
    "speaker_verify": True,          # 登録した声の人だけ採用する(登録が1件以上ある時のみ有効)
    "speaker_threshold": 0.6,        # 類似度(cosine)がこれ以上で本人とみなす
    "speaker_check_push": False,     # 🎤(押して話す)でも声紋を照合するか
    "mic_min_conf": 0.4,             # 認識の確信度がこれ未満は無視(0=無効)
    "wake_enabled": False,
    "wake_word": "ジャービス",
    "followup_seconds": 45,
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
  created_at REAL NOT NULL, updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,            -- user | assistant | system
  content TEXT NOT NULL,
  provider TEXT,                 -- assistant を生成したAI
  task_id INTEGER, created_at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  provider TEXT NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL,
  status TEXT NOT NULL,          -- running | done | error | cancelled
  error TEXT, created_at REAL NOT NULL, finished_at REAL);
CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  ts REAL NOT NULL, level TEXT NOT NULL, text TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_ev_task ON task_events(task_id, id);
CREATE TABLE IF NOT EXISTS speaker_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  samples TEXT NOT NULL DEFAULT '[]',     -- 登録サンプルの埋め込み(JSON: 配列の配列)
  enabled INTEGER NOT NULL DEFAULT 1, created_at REAL NOT NULL);
"""


def conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute("PRAGMA foreign_keys=ON")
        _conn.executescript(SCHEMA)
        # 軽量マイグレーション
        def has(table, col):
            return any(r[1] == col for r in _conn.execute(f"PRAGMA table_info({table})"))
        if not has("conversations", "allow_all"):
            _conn.execute("ALTER TABLE conversations ADD COLUMN allow_all INTEGER NOT NULL DEFAULT 0")
        if not has("conversations", "archived_at"):
            _conn.execute("ALTER TABLE conversations ADD COLUMN archived_at REAL")
        if not has("tasks", "model"):
            _conn.execute("ALTER TABLE tasks ADD COLUMN model TEXT")
        if not has("tasks", "confirm_text"):
            _conn.execute("ALTER TABLE tasks ADD COLUMN confirm_text TEXT")
        # 前回異常終了で running のまま残ったタスクを回収
        _conn.execute("UPDATE tasks SET status='error', error='サーバー再起動で中断', finished_at=? WHERE status='running'", (time.time(),))
        # 旧い既定の persona のままなら、短く答える新しい既定に更新(編集済みのものは触らない)
        row = _conn.execute("SELECT value FROM settings WHERE key='persona'").fetchone()
        if row:
            try:
                old = json.loads(row[0])
                if old.startswith(OLD_PERSONA_PREFIX) and "60文字" not in old:
                    _conn.execute("DELETE FROM settings WHERE key='persona'")
            except Exception:
                pass
        _conn.commit()
    return _conn


def q(sql: str, params=()) -> list[dict]:
    with _lock:
        return [dict(r) for r in conn().execute(sql, params).fetchall()]


def one(sql: str, params=()) -> dict | None:
    rows = q(sql, params)
    return rows[0] if rows else None


def x(sql: str, params=()) -> int:
    with _lock:
        c = conn().execute(sql, params)
        conn().commit()
        return c.lastrowid


def get_settings() -> dict:
    s = dict(DEFAULT_SETTINGS)
    for r in q("SELECT key, value FROM settings"):
        try:
            s[r["key"]] = json.loads(r["value"])
        except Exception:
            pass
    return s


def put_settings(patch: dict) -> dict:
    for k, v in patch.items():
        if k in DEFAULT_SETTINGS:
            x("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
              (k, json.dumps(v, ensure_ascii=False)))
    return get_settings()


def purge_expired_archives() -> int:
    """アーカイブから保持期間(既定180日)を過ぎた会話を、メッセージ・タスク・ログごと完全削除する。"""
    days = int(get_settings().get("archive_retention_days") or 180)
    cutoff = time.time() - days * 86400
    ids = [r["id"] for r in q("SELECT id FROM conversations WHERE archived_at IS NOT NULL AND archived_at < ?", (cutoff,))]
    for cid in ids:
        x("DELETE FROM tasks WHERE conversation_id=? AND status!='running'", (cid,))  # task_events は CASCADE
        x("DELETE FROM messages WHERE conversation_id=?", (cid,))
        x("DELETE FROM conversations WHERE id=?", (cid,))
    return len(ids)
