"""Local Studio history and opaque uploads; no client-provided filesystem paths."""
from datetime import datetime, timezone
from contextlib import contextmanager
from pathlib import Path
from threading import RLock
import json
import mimetypes
import re
import shutil
import sqlite3
import uuid
from urllib.parse import unquote


class StudioError(ValueError):
    pass


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def opaque_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{32}", value):
        raise StudioError("会话或素材 ID 无效。")
    return value


EXTENSIONS = {
    "image": {"png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "avif"},
    "video": {"mp4", "mov", "mkv", "webm", "avi", "m4v", "mpg", "mpeg"},
    "audio": {"wav", "mp3", "flac", "m4a", "aac", "ogg", "opus", "aiff", "aif"},
    "model": {"obj", "glb", "gltf", "fbx", "stl", "ply", "usdz", "spz", "splat", "ksplat"},
    "text": {"txt", "md", "json", "csv", "srt", "vtt"},
}
MAX_UPLOAD_BYTES = 256 * 1024 * 1024
MAX_ATTACHMENTS = 32


def file_kind(name):
    ext = Path(name).suffix.lower().lstrip(".")
    kind = next((kind for kind, extensions in EXTENSIONS.items() if ext in extensions), None)
    if kind is None:
        raise StudioError("此文件类型暂不支持，请上传图片、视频、音频、3D模型或文本。")
    return kind, ext


class Store:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.upload_root = self.root / "uploads"
        self.upload_root.mkdir(parents=True, exist_ok=True)
        self._lock = RLock()
        self.database = self.root / "studio.sqlite3"
        with self._connection() as db:
            db.executescript("""
              CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,title TEXT,created_at TEXT,updated_at TEXT);
              CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,conversation_id TEXT,data TEXT,created_at TEXT);
              CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY,name TEXT,kind TEXT,mime TEXT,size INTEGER,file TEXT,created_at TEXT,metadata TEXT);
              CREATE TABLE IF NOT EXISTS skills(id TEXT PRIMARY KEY,data TEXT);
            """)

    @contextmanager
    def _connection(self):
        db = sqlite3.connect(self.database, timeout=30)
        try:
            with db:
                yield db
        finally:
            db.close()

    def create_conversation(self, title="新会话"):
        cid, now = uuid.uuid4().hex, timestamp()
        title = str(title or "新会话").strip()[:120] or "新会话"
        with self._lock, self._connection() as db:
            db.execute("INSERT INTO conversations VALUES(?,?,?,?)", (cid, title, now, now))
        return self.conversation(cid)

    def list_conversations(self):
        with self._lock, self._connection() as db:
            rows = db.execute("SELECT c.id,c.title,c.created_at,c.updated_at,COUNT(m.id) FROM conversations c LEFT JOIN messages m ON c.id=m.conversation_id GROUP BY c.id ORDER BY c.updated_at DESC").fetchall()
        return [dict(zip(("id", "title", "created_at", "updated_at", "message_count"), row)) for row in rows]

    def conversation(self, cid):
        opaque_id(cid)
        with self._lock, self._connection() as db:
            row = db.execute("SELECT id,title,created_at,updated_at FROM conversations WHERE id=?", (cid,)).fetchone()
            messages = db.execute("SELECT data FROM messages WHERE conversation_id=? ORDER BY created_at,rowid", (cid,)).fetchall()
        if row is None:
            raise StudioError("会话不存在。")
        result = dict(zip(("id", "title", "created_at", "updated_at"), row))
        result["messages"] = [json.loads(message[0]) for message in messages]
        return result

    def add_message(self, cid, role, content, **extra):
        self.conversation(cid)
        if role not in {"user", "assistant"}:
            raise StudioError("消息角色无效。")
        now = timestamp()
        message = {"id": uuid.uuid4().hex, "role": role, "content": str(content), "created_at": now, "attachments": [], **extra}
        with self._lock, self._connection() as db:
            db.execute("INSERT INTO messages VALUES(?,?,?,?)", (message["id"], cid, json.dumps(message, ensure_ascii=False), now))
            db.execute("UPDATE conversations SET updated_at=? WHERE id=?", (now, cid))
            if role == "user" and db.execute("SELECT title FROM conversations WHERE id=?", (cid,)).fetchone()[0] in {"新会话", "新对话"}:
                title = str(content).strip().splitlines()[0][:36] if str(content).strip() else "素材分析"
                db.execute("UPDATE conversations SET title=? WHERE id=?", (title, cid))
        return message

    def save_message_timing(self, cid, message_id, elapsed_ms):
        import math
        opaque_id(cid)
        opaque_id(message_id)
        if isinstance(elapsed_ms, bool) or not isinstance(elapsed_ms, (int, float)) or not math.isfinite(elapsed_ms) or elapsed_ms < 0:
            raise StudioError("回复耗时必须是有效的非负数值。")
        with self._lock, self._connection() as db:
            row = db.execute("SELECT data FROM messages WHERE id=? AND conversation_id=?", (message_id, cid)).fetchone()
            if row is None:
                raise StudioError("回复不存在。")
            message = json.loads(row[0])
            if message["role"] != "assistant":
                raise StudioError("仅模型回复可以记录耗时。")
            message["elapsed_ms"] = round(elapsed_ms)
            db.execute("UPDATE messages SET data=? WHERE id=?", (json.dumps(message, ensure_ascii=False), message_id))
        return message

    def delete_conversation(self, cid):
        self.conversation(cid)
        with self._lock, self._connection() as db:
            db.execute("DELETE FROM messages WHERE conversation_id=?", (cid,))
            db.execute("DELETE FROM conversations WHERE id=?", (cid,))

    def rename_conversation(self, cid, title):
        self.conversation(cid)
        if not isinstance(title, str) or not title.strip() or len(title.strip()) > 120:
            raise StudioError("对话标题需要 1–120 个字符。")
        with self._lock, self._connection() as db:
            db.execute("UPDATE conversations SET title=? WHERE id=?", (title.strip(), cid))
        return self.conversation(cid)

    def begin_upload(self, filename):
        name = Path(unquote(str(filename)).replace("\\", "/")).name[:240]
        if not name or "\x00" in name:
            raise StudioError("上传文件名无效。")
        kind, ext = file_kind(name)
        aid = uuid.uuid4().hex
        directory = self.upload_root / aid
        directory.mkdir()
        return aid, name, kind, directory / ("source." + ext)

    def finish_upload(self, aid, name, kind, path, metadata=None):
        opaque_id(aid)
        path = Path(path).resolve()
        if not path.is_relative_to(self.upload_root / aid) or not path.is_file():
            raise StudioError("上传素材路径无效。")
        size = path.stat().st_size
        if size <= 0 or size > MAX_UPLOAD_BYTES:
            raise StudioError("上传文件必须非空且不超过 256 MB。")
        mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
        with self._lock, self._connection() as db:
            db.execute("INSERT INTO uploads VALUES(?,?,?,?,?,?,?,?)", (aid, name, kind, mime, size,
                       path.relative_to(self.upload_root).as_posix(), timestamp(), json.dumps(metadata or {}, ensure_ascii=False)))
        return self.attachment(aid)

    def import_file(self, source, metadata=None):
        source = Path(source).resolve()
        if not source.is_file() or source.stat().st_size > MAX_UPLOAD_BYTES:
            raise StudioError("Eagle 引用文件不可读取或超过 256 MB。")
        aid, name, kind, target = self.begin_upload(source.name)
        try:
            shutil.copyfile(source, target)
            return self.finish_upload(aid, name, kind, target, metadata)
        except Exception:
            self.discard_upload(aid)
            raise

    def discard_upload(self, aid):
        opaque_id(aid)
        directory = self.upload_root / aid
        if directory.is_relative_to(self.upload_root):
            shutil.rmtree(directory, ignore_errors=True)

    def attachment(self, aid):
        opaque_id(aid)
        with self._lock, self._connection() as db:
            row = db.execute("SELECT id,name,kind,mime,size,file,created_at,metadata FROM uploads WHERE id=?", (aid,)).fetchone()
        if row is None:
            raise StudioError("上传素材不存在。")
        data = dict(zip(("id", "name", "kind", "mime", "size", "file", "created_at", "metadata"), row))
        path = (self.upload_root / data.pop("file")).resolve()
        if not path.is_relative_to(self.upload_root / aid) or not path.is_file():
            raise StudioError("上传素材已缺失。")
        data["metadata"] = json.loads(data["metadata"])
        data["preview_url"] = "/ollama_studio/media/" + aid
        data["_path"] = str(path)
        return data

    def public_attachment(self, aid):
        return {key: value for key, value in self.attachment(aid).items() if not key.startswith("_")}

    def list_skills(self):
        with self._lock, self._connection() as db:
            rows = db.execute("SELECT data FROM skills ORDER BY rowid").fetchall()
        return [json.loads(row[0]) for row in rows]

    def save_skill(self, values, sid=None):
        if not isinstance(values, dict):
            raise StudioError("技能内容无效。")
        name, prompt = str(values.get("name", "")).strip(), str(values.get("prompt", "")).strip()
        if not name or not prompt or len(name) > 120 or len(prompt) > 50000:
            raise StudioError("请填写技能名称及系统提示词（最多 50000 字符）。")
        sid = opaque_id(sid) if sid else uuid.uuid4().hex
        data = {"id": sid, "name": name, "description": str(values.get("description", ""))[:2000], "prompt": prompt,
                "language": values.get("language", "auto"), "builtin": False}
        if data["language"] not in {"auto", "en", "zh"}:
            raise StudioError("技能语言必须为 auto、en 或 zh。")
        with self._lock, self._connection() as db:
            db.execute("INSERT OR REPLACE INTO skills VALUES(?,?)", (sid, json.dumps(data, ensure_ascii=False)))
        return data

    def delete_skill(self, sid):
        opaque_id(sid)
        with self._lock, self._connection() as db:
            if not db.execute("DELETE FROM skills WHERE id=?", (sid,)).rowcount:
                raise StudioError("自定义技能不存在。")

    def config(self):
        path = self.root / "config.json"
        if not path.is_file():
            return {}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}


_stores = {}
_store_mutex = RLock()


def get_store():
    import folder_paths
    root = str(Path(folder_paths.get_user_directory()).resolve() / "ollama_studio")
    with _store_mutex:
        if root not in _stores:
            _stores[root] = Store(root)
        return _stores[root]
