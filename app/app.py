from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import re
import shutil
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from flask import Flask, Response, jsonify, request, send_file, send_from_directory

APP_VERSION = "v8"
BACKUP_FORMAT = "maker-inventar-backup"
BACKUP_VERSION = 2
SCHEMA_VERSION = 2
BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR / "frontend"
DATA_DIR = Path(os.environ.get("DATA_DIR", "/app/data"))
DB_PATH = DATA_DIR / "app.sqlite"
BACKUP_DIR = DATA_DIR / "backups"
UPLOAD_DIR = DATA_DIR / "uploads"
ITEM_IMAGE_DIR = UPLOAD_DIR / "items"

app = Flask(__name__, static_folder=None)
app.config["JSON_SORT_KEYS"] = False
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "change-me")


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def new_id() -> str:
    return str(uuid.uuid4())


def env_bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def public_app_url() -> str:
    return os.environ.get("APP_URL", "").strip().rstrip("/")


def allowed_origin() -> str:
    return os.environ.get("PWA_ALLOWED_ORIGIN", "").strip().rstrip("/")


def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    ITEM_IMAGE_DIR.mkdir(parents=True, exist_ok=True)


def connect_db() -> sqlite3.Connection:
    ensure_dirs()
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=FULL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def backup_database(reason: str = "manual") -> Path | None:
    if not DB_PATH.exists():
        return None
    ensure_dirs()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    safe_reason = re.sub(r"[^a-zA-Z0-9_-]+", "-", reason).strip("-") or "backup"
    target = BACKUP_DIR / f"app-{stamp}-{safe_reason}.sqlite"
    src = sqlite3.connect(DB_PATH)
    dst = sqlite3.connect(target)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    if ITEM_IMAGE_DIR.exists() and any(ITEM_IMAGE_DIR.iterdir()):
        archive_base = BACKUP_DIR / f"uploads-{stamp}-{safe_reason}"
        shutil.make_archive(str(archive_base), "zip", root_dir=UPLOAD_DIR)
    prune_backups()
    return target


def prune_backups() -> None:
    keep = max(1, int(os.environ.get("BACKUP_KEEP", "50")))
    backups = sorted(BACKUP_DIR.glob("app-*.sqlite"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in backups[keep:]:
        old.unlink(missing_ok=True)
    upload_backups = sorted(BACKUP_DIR.glob("uploads-*.zip"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in upload_backups[keep:]:
        old.unlink(missing_ok=True)


def migrate() -> None:
    ensure_dirs()
    with connect_db() as conn:
        current = int(conn.execute("PRAGMA user_version").fetchone()[0])
        if current > SCHEMA_VERSION:
            raise RuntimeError(f"Database schema {current} is newer than supported {SCHEMA_VERSION}")
        if current and current < SCHEMA_VERSION:
            backup_database(f"pre-migration-{current}-to-{SCHEMA_VERSION}")
        if current < 1:
            conn.executescript(
                """
                CREATE TABLE categories (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE locations (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE items (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
                    location_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
                    quantity REAL NOT NULL DEFAULT 0 CHECK(quantity >= 0),
                    min_quantity REAL NOT NULL DEFAULT 0 CHECK(min_quantity >= 0),
                    unit TEXT NOT NULL DEFAULT 'Stk',
                    value_text TEXT NOT NULL DEFAULT '',
                    manufacturer TEXT NOT NULL DEFAULT '',
                    part_number TEXT NOT NULL DEFAULT '',
                    package TEXT NOT NULL DEFAULT '',
                    tags TEXT NOT NULL DEFAULT '',
                    source_url TEXT NOT NULL DEFAULT '',
                    notes TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX idx_items_name ON items(name COLLATE NOCASE);
                CREATE INDEX idx_items_category ON items(category_id);
                CREATE INDEX idx_items_location ON items(location_id);
                CREATE TABLE projects (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'planned',
                    notes TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE project_items (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                    required_quantity REAL NOT NULL DEFAULT 1 CHECK(required_quantity >= 0),
                    notes TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(project_id, item_id)
                );
                """
            )
            ts = now_iso()
            for name in ["Mikrocontroller", "Sensoren", "Module", "Widerstände", "Kondensatoren", "Mechanik", "Sonstiges"]:
                conn.execute(
                    "INSERT INTO categories(id,name,created_at,updated_at) VALUES(?,?,?,?)",
                    (new_id(), name, ts, ts),
                )
            for name in ["Werkbank", "Schublade 1", "Schublade 2"]:
                conn.execute(
                    "INSERT INTO locations(id,name,created_at,updated_at) VALUES(?,?,?,?)",
                    (new_id(), name, ts, ts),
                )
            conn.execute("PRAGMA user_version=1")
            current = 1
        if current < 2:
            conn.execute("ALTER TABLE items ADD COLUMN image_mime_type TEXT NOT NULL DEFAULT ''")
            conn.execute("ALTER TABLE items ADD COLUMN image_updated_at TEXT NOT NULL DEFAULT ''")
            conn.execute("PRAGMA user_version=2")
        conn.commit()


def row_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {k: row[k] for k in row.keys()}


def fetch_all(conn: sqlite3.Connection, table: str) -> list[dict[str, Any]]:
    return [row_dict(r) for r in conn.execute(f"SELECT * FROM {table} ORDER BY updated_at DESC")]


def public_item(record: dict[str, Any]) -> dict[str, Any]:
    clean = dict(record)
    clean.pop("tags", None)
    return clean


def fetch_public_items(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    return [public_item(row) for row in fetch_all(conn, "items")]


def payload_json() -> dict[str, Any]:
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ValueError("JSON-Objekt erwartet")
    return data


def require_name(data: dict[str, Any]) -> str:
    name = str(data.get("name", "")).strip()
    if not name:
        raise ValueError("Name ist erforderlich")
    if len(name) > 180:
        raise ValueError("Name ist zu lang")
    return name


def clean_text(value: Any, max_len: int = 2000) -> str:
    text = str(value or "").strip()
    return text[:max_len]


def clean_nonnegative_number(value: Any, field: str) -> float:
    try:
        number = float(value if value not in (None, "") else 0)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} muss eine Zahl sein") from exc
    if number < 0:
        raise ValueError(f"{field} darf nicht negativ sein")
    return number


def valid_fk(conn: sqlite3.Connection, table: str, value: Any) -> str | None:
    if value in (None, ""):
        return None
    value = str(value)
    exists = conn.execute(f"SELECT 1 FROM {table} WHERE id=?", (value,)).fetchone()
    if not exists:
        raise ValueError(f"Ungültige Referenz für {table}")
    return value


def check_optional_app_auth() -> Response | None:
    if not env_bool("AUTH_ENABLED", False):
        return None
    expected = os.environ.get("APP_API_TOKEN", "")
    auth = request.headers.get("Authorization", "")
    if not expected or auth != f"Bearer {expected}":
        return jsonify({"error": "Authentifizierung fehlgeschlagen"}), 401
    return None


@app.before_request
def before_request():
    if request.method == "OPTIONS" and request.path.startswith("/api/"):
        return Response(status=204)
    if request.path.startswith("/api/"):
        auth_response = check_optional_app_auth()
        if auth_response:
            return auth_response
    return None


@app.after_request
def add_headers(response: Response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("Permissions-Policy", "camera=(self), microphone=(), geolocation=()")
    if request.path == "/" or request.path.endswith((".html", ".js", ".css", ".webmanifest")):
        response.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; "
            "connect-src 'self' https:; manifest-src 'self'; worker-src 'self'; object-src 'none'; "
            "base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
        )
    origin = request.headers.get("Origin", "").rstrip("/")
    configured = allowed_origin()
    if request.path.startswith("/api/") and configured and origin == configured:
        response.headers["Access-Control-Allow-Origin"] = configured
        response.headers["Vary"] = "Origin"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = (
            "Content-Type, Authorization, CF-Access-Client-Id, CF-Access-Client-Secret"
        )
        response.headers["Access-Control-Max-Age"] = "600"
    return response


@app.errorhandler(ValueError)
def handle_value_error(exc: ValueError):
    return jsonify({"error": str(exc)}), 400


@app.errorhandler(sqlite3.IntegrityError)
def handle_integrity_error(exc: sqlite3.IntegrityError):
    return jsonify({"error": "Datensatz kollidiert mit bestehenden Daten", "detail": str(exc)}), 409


@app.errorhandler(404)
def handle_404(_exc):
    if request.path.startswith("/api/"):
        return jsonify({"error": "Nicht gefunden"}), 404
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.get("/health")
def health():
    try:
        with connect_db() as conn:
            conn.execute("SELECT 1").fetchone()
        return jsonify({"status": "ok", "version": APP_VERSION})
    except Exception:
        return jsonify({"status": "error"}), 503


@app.get("/config.json")
def runtime_config():
    app_url = public_app_url()
    return jsonify(
        {
            "appName": os.environ.get("APP_TITLE", "Maker Inventar"),
            "version": APP_VERSION,
            "buildTarget": "docker",
            "defaultMode": "server",
            "defaultServerUrl": app_url,
            "dockerWebUrl": os.environ.get("DOCKER_WEB_URL", app_url).strip().rstrip("/"),
            "authEnabled": env_bool("AUTH_ENABLED", False),
        }
    )


@app.get("/api/config")
def api_config():
    return jsonify(
        {
            "appName": os.environ.get("APP_TITLE", "Maker Inventar"),
            "version": APP_VERSION,
            "backupFormat": BACKUP_FORMAT,
            "backupVersion": BACKUP_VERSION,
            "schemaVersion": SCHEMA_VERSION,
        }
    )


@app.get("/api/bootstrap")
def bootstrap():
    with connect_db() as conn:
        return jsonify(
            {
                "categories": fetch_all(conn, "categories"),
                "locations": fetch_all(conn, "locations"),
                "items": fetch_public_items(conn),
                "projects": fetch_all(conn, "projects"),
                "project_items": fetch_all(conn, "project_items"),
            }
        )


def list_resource(table: str):
    with connect_db() as conn:
        return jsonify(fetch_all(conn, table))


@app.get("/api/categories")
def list_categories():
    return list_resource("categories")


@app.post("/api/categories")
def create_category():
    data = payload_json()
    name = require_name(data)
    ts = now_iso()
    record = {"id": new_id(), "name": name, "created_at": ts, "updated_at": ts}
    with connect_db() as conn:
        conn.execute("INSERT INTO categories(id,name,created_at,updated_at) VALUES(:id,:name,:created_at,:updated_at)", record)
        conn.commit()
    return jsonify(record), 201


@app.delete("/api/categories/<record_id>")
def delete_category(record_id: str):
    with connect_db() as conn:
        result = conn.execute("DELETE FROM categories WHERE id=?", (record_id,))
        conn.commit()
    if not result.rowcount:
        return jsonify({"error": "Nicht gefunden"}), 404
    return Response(status=204)


@app.get("/api/locations")
def list_locations():
    return list_resource("locations")


@app.post("/api/locations")
def create_location():
    data = payload_json()
    name = require_name(data)
    ts = now_iso()
    record = {"id": new_id(), "name": name, "created_at": ts, "updated_at": ts}
    with connect_db() as conn:
        conn.execute("INSERT INTO locations(id,name,created_at,updated_at) VALUES(:id,:name,:created_at,:updated_at)", record)
        conn.commit()
    return jsonify(record), 201


@app.delete("/api/locations/<record_id>")
def delete_location(record_id: str):
    with connect_db() as conn:
        result = conn.execute("DELETE FROM locations WHERE id=?", (record_id,))
        conn.commit()
    if not result.rowcount:
        return jsonify({"error": "Nicht gefunden"}), 404
    return Response(status=204)


@app.get("/api/items")
def list_items():
    with connect_db() as conn:
        return jsonify(fetch_public_items(conn))


@app.get("/api/items/<record_id>")
def get_item(record_id: str):
    with connect_db() as conn:
        row = conn.execute("SELECT * FROM items WHERE id=?", (record_id,)).fetchone()
    if not row:
        return jsonify({"error": "Nicht gefunden"}), 404
    return jsonify(public_item(row_dict(row)))


def item_values(conn: sqlite3.Connection, data: dict[str, Any], existing: sqlite3.Row | None = None) -> dict[str, Any]:
    current = row_dict(existing) if existing else {}
    return {
        "name": require_name(data if "name" in data or not existing else current),
        "category_id": valid_fk(conn, "categories", data.get("category_id", current.get("category_id"))),
        "location_id": valid_fk(conn, "locations", data.get("location_id", current.get("location_id"))),
        "quantity": clean_nonnegative_number(data.get("quantity", current.get("quantity", 0)), "Bestand"),
        "min_quantity": clean_nonnegative_number(data.get("min_quantity", current.get("min_quantity", 0)), "Mindestbestand"),
        "unit": clean_text(data.get("unit", current.get("unit", "Stk")), 20) or "Stk",
        "value_text": clean_text(data.get("value_text", current.get("value_text", "")), 120),
        "manufacturer": clean_text(data.get("manufacturer", current.get("manufacturer", "")), 180),
        "part_number": clean_text(data.get("part_number", current.get("part_number", "")), 180),
        "package": clean_text(data.get("package", current.get("package", "")), 80),
        "source_url": clean_text(data.get("source_url", current.get("source_url", "")), 1000),
        "notes": clean_text(data.get("notes", current.get("notes", "")), 5000),
        "image_mime_type": clean_text(current.get("image_mime_type", ""), 60),
        "image_updated_at": clean_text(current.get("image_updated_at", ""), 40),
    }


@app.post("/api/items")
def create_item():
    data = payload_json()
    with connect_db() as conn:
        values = item_values(conn, data)
        ts = now_iso()
        record = {"id": new_id(), **values, "created_at": ts, "updated_at": ts}
        columns = ",".join(record.keys())
        placeholders = ",".join(f":{k}" for k in record.keys())
        conn.execute(f"INSERT INTO items({columns}) VALUES({placeholders})", record)
        conn.commit()
    return jsonify(record), 201


@app.route("/api/items/<record_id>", methods=["PUT", "PATCH"])
def update_item(record_id: str):
    data = payload_json()
    with connect_db() as conn:
        existing = conn.execute("SELECT * FROM items WHERE id=?", (record_id,)).fetchone()
        if not existing:
            return jsonify({"error": "Nicht gefunden"}), 404
        values = item_values(conn, data, existing)
        values["updated_at"] = now_iso()
        values["id"] = record_id
        assignments = ",".join(f"{k}=:{k}" for k in values.keys() if k != "id")
        conn.execute(f"UPDATE items SET {assignments} WHERE id=:id", values)
        conn.commit()
        row = conn.execute("SELECT * FROM items WHERE id=?", (record_id,)).fetchone()
    return jsonify(public_item(row_dict(row)))


@app.delete("/api/items/<record_id>")
def delete_item(record_id: str):
    with connect_db() as conn:
        result = conn.execute("DELETE FROM items WHERE id=?", (record_id,))
        conn.commit()
    if not result.rowcount:
        return jsonify({"error": "Nicht gefunden"}), 404
    delete_item_image_files(record_id)
    return Response(status=204)


IMAGE_MIME_SUFFIX = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}

def image_file_stem(record_id: str) -> str:
    return hashlib.sha256(record_id.encode("utf-8")).hexdigest()

def image_path(record_id: str, mime_type: str) -> Path:
    suffix = IMAGE_MIME_SUFFIX.get(mime_type)
    if not suffix:
        raise ValueError("Nicht unterstütztes Bildformat")
    return ITEM_IMAGE_DIR / f"{image_file_stem(record_id)}{suffix}"

def delete_item_image_files(record_id: str) -> None:
    stem = image_file_stem(record_id)
    for candidate in ITEM_IMAGE_DIR.glob(f"{stem}.*"):
        if candidate.is_file():
            candidate.unlink(missing_ok=True)

def sniff_image_mime(data: bytes) -> str | None:
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None

@app.get("/api/items/<record_id>/image")
def get_item_image(record_id: str):
    with connect_db() as conn:
        item = conn.execute("SELECT image_mime_type,image_updated_at FROM items WHERE id=?", (record_id,)).fetchone()
    if not item or not item["image_mime_type"]:
        return jsonify({"error": "Kein Bild hinterlegt"}), 404
    path = image_path(record_id, item["image_mime_type"])
    if not path.exists():
        return jsonify({"error": "Bilddatei fehlt"}), 404
    response = send_file(path, mimetype=item["image_mime_type"], conditional=True, max_age=0)
    response.headers["Cache-Control"] = "private, no-store"
    return response

@app.post("/api/items/<record_id>/image")
def upload_item_image(record_id: str):
    max_bytes = max(200_000, int(os.environ.get("IMAGE_MAX_BYTES", str(4 * 1024 * 1024))))
    if request.content_length and request.content_length > max_bytes + 512_000:
        raise ValueError("Bilddatei ist zu groß")
    upload = request.files.get("image")
    if not upload:
        raise ValueError("Bilddatei fehlt")
    data = upload.stream.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise ValueError("Bilddatei ist zu groß")
    mime_type = sniff_image_mime(data)
    if not mime_type:
        raise ValueError("Nur JPEG, PNG oder WebP sind erlaubt")
    with connect_db() as conn:
        exists = conn.execute("SELECT 1 FROM items WHERE id=?", (record_id,)).fetchone()
        if not exists:
            return jsonify({"error": "Nicht gefunden"}), 404
        delete_item_image_files(record_id)
        target = image_path(record_id, mime_type)
        temp = target.with_suffix(target.suffix + ".tmp")
        temp.write_bytes(data)
        temp.replace(target)
        updated_at = now_iso()
        conn.execute("UPDATE items SET image_mime_type=?,image_updated_at=?,updated_at=? WHERE id=?", (mime_type, updated_at, updated_at, record_id))
        conn.commit()
    return jsonify({"ok": True, "item_id": record_id, "mime_type": mime_type, "updated_at": updated_at})

@app.delete("/api/items/<record_id>/image")
def delete_item_image(record_id: str):
    with connect_db() as conn:
        exists = conn.execute("SELECT 1 FROM items WHERE id=?", (record_id,)).fetchone()
        if not exists:
            return jsonify({"error": "Nicht gefunden"}), 404
        delete_item_image_files(record_id)
        updated_at = now_iso()
        conn.execute("UPDATE items SET image_mime_type='',image_updated_at='',updated_at=? WHERE id=?", (updated_at, record_id))
        conn.commit()
    return Response(status=204)


@app.get("/api/projects")
def list_projects():
    return list_resource("projects")


@app.post("/api/projects")
def create_project():
    data = payload_json()
    ts = now_iso()
    record = {
        "id": new_id(),
        "name": require_name(data),
        "status": clean_text(data.get("status", "planned"), 30) or "planned",
        "notes": clean_text(data.get("notes", ""), 5000),
        "created_at": ts,
        "updated_at": ts,
    }
    with connect_db() as conn:
        conn.execute(
            "INSERT INTO projects(id,name,status,notes,created_at,updated_at) VALUES(:id,:name,:status,:notes,:created_at,:updated_at)",
            record,
        )
        conn.commit()
    return jsonify(record), 201


@app.route("/api/projects/<record_id>", methods=["PUT", "PATCH"])
def update_project(record_id: str):
    data = payload_json()
    with connect_db() as conn:
        existing = conn.execute("SELECT * FROM projects WHERE id=?", (record_id,)).fetchone()
        if not existing:
            return jsonify({"error": "Nicht gefunden"}), 404
        record = {
            "id": record_id,
            "name": require_name({"name": data.get("name", existing["name"])}),
            "status": clean_text(data.get("status", existing["status"]), 30) or "planned",
            "notes": clean_text(data.get("notes", existing["notes"]), 5000),
            "updated_at": now_iso(),
        }
        conn.execute(
            "UPDATE projects SET name=:name,status=:status,notes=:notes,updated_at=:updated_at WHERE id=:id",
            record,
        )
        conn.commit()
        row = conn.execute("SELECT * FROM projects WHERE id=?", (record_id,)).fetchone()
    return jsonify(row_dict(row))


@app.delete("/api/projects/<record_id>")
def delete_project(record_id: str):
    with connect_db() as conn:
        result = conn.execute("DELETE FROM projects WHERE id=?", (record_id,))
        conn.commit()
    if not result.rowcount:
        return jsonify({"error": "Nicht gefunden"}), 404
    return Response(status=204)


@app.get("/api/project-items")
def list_project_items():
    return list_resource("project_items")


@app.post("/api/project-items")
def create_project_item():
    data = payload_json()
    with connect_db() as conn:
        project_id = valid_fk(conn, "projects", data.get("project_id"))
        item_id = valid_fk(conn, "items", data.get("item_id"))
        if not project_id or not item_id:
            raise ValueError("Projekt und Bauteil sind erforderlich")
        ts = now_iso()
        record = {
            "id": new_id(),
            "project_id": project_id,
            "item_id": item_id,
            "required_quantity": clean_nonnegative_number(data.get("required_quantity", 1), "Benötigte Menge"),
            "notes": clean_text(data.get("notes", ""), 1000),
            "created_at": ts,
            "updated_at": ts,
        }
        conn.execute(
            "INSERT INTO project_items(id,project_id,item_id,required_quantity,notes,created_at,updated_at) "
            "VALUES(:id,:project_id,:item_id,:required_quantity,:notes,:created_at,:updated_at)",
            record,
        )
        conn.commit()
    return jsonify(record), 201


@app.route("/api/project-items/<record_id>", methods=["PUT", "PATCH"])
def update_project_item(record_id: str):
    data = payload_json()
    with connect_db() as conn:
        existing = conn.execute("SELECT * FROM project_items WHERE id=?", (record_id,)).fetchone()
        if not existing:
            return jsonify({"error": "Nicht gefunden"}), 404
        record = {
            "id": record_id,
            "required_quantity": clean_nonnegative_number(
                data.get("required_quantity", existing["required_quantity"]), "Benötigte Menge"
            ),
            "notes": clean_text(data.get("notes", existing["notes"]), 1000),
            "updated_at": now_iso(),
        }
        conn.execute(
            "UPDATE project_items SET required_quantity=:required_quantity,notes=:notes,updated_at=:updated_at WHERE id=:id",
            record,
        )
        conn.commit()
        row = conn.execute("SELECT * FROM project_items WHERE id=?", (record_id,)).fetchone()
    return jsonify(row_dict(row))


@app.delete("/api/project-items/<record_id>")
def delete_project_item(record_id: str):
    with connect_db() as conn:
        result = conn.execute("DELETE FROM project_items WHERE id=?", (record_id,))
        conn.commit()
    if not result.rowcount:
        return jsonify({"error": "Nicht gefunden"}), 404
    return Response(status=204)


def build_backup(conn: sqlite3.Connection) -> dict[str, Any]:
    items = fetch_all(conn, "items")
    for item in items:
        item.pop("tags", None)
        item["image_mime_type"] = ""
        item["image_updated_at"] = ""
    return {
        "format": BACKUP_FORMAT,
        "version": BACKUP_VERSION,
        "exported_at": now_iso(),
        "app_version": APP_VERSION,
        "includes_images": False,
        "data": {
            "categories": fetch_all(conn, "categories"),
            "locations": fetch_all(conn, "locations"),
            "items": items,
            "projects": fetch_all(conn, "projects"),
            "project_items": fetch_all(conn, "project_items"),
        },
    }


@app.get("/api/export/backup")
def export_backup():
    with connect_db() as conn:
        payload = build_backup(conn)
    body = json.dumps(payload, ensure_ascii=False, indent=2)
    filename = f"maker-inventar-backup-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.json"
    return Response(
        body,
        mimetype="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/export/items.csv")
def export_items_csv():
    with connect_db() as conn:
        rows = conn.execute(
            """
            SELECT i.name, i.quantity, i.unit, i.min_quantity, c.name AS category,
                   l.name AS location, i.value_text, i.manufacturer, i.part_number,
                   i.package, i.notes
            FROM items i
            LEFT JOIN categories c ON c.id=i.category_id
            LEFT JOIN locations l ON l.id=i.location_id
            ORDER BY i.name COLLATE NOCASE
            """
        ).fetchall()
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Name", "Bestand", "Einheit", "Mindestbestand", "Kategorie", "Lagerort", "Wert", "Hersteller", "Teilenummer", "Gehäuse", "Notizen"])
    for row in rows:
        writer.writerow(list(row))
    return Response(
        output.getvalue(),
        mimetype="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="maker-inventar.csv"'},
    )


def validate_backup(payload: dict[str, Any]) -> dict[str, Any]:
    if payload.get("format") != BACKUP_FORMAT:
        raise ValueError("Unbekanntes Backup-Format")
    if int(payload.get("version", -1)) not in {1, BACKUP_VERSION}:
        raise ValueError("Nicht unterstützte Backup-Version")
    data = payload.get("data")
    if not isinstance(data, dict):
        raise ValueError("Backup enthält keine gültigen Daten")
    required = ["categories", "locations", "items", "projects", "project_items"]
    for key in required:
        if not isinstance(data.get(key), list):
            raise ValueError(f"Backup-Bereich {key} fehlt oder ist ungültig")
    return {
        "categories": len(data["categories"]),
        "locations": len(data["locations"]),
        "items": len(data["items"]),
        "projects": len(data["projects"]),
        "project_items": len(data["project_items"]),
    }


def detect_import_conflicts(conn: sqlite3.Connection, data: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    overwrites = {}
    hard: list[dict[str, str]] = []
    for table in ["categories", "locations", "items", "projects", "project_items"]:
        ids = [str(row.get("id", "")) for row in data.get(table, []) if row.get("id")]
        if ids:
            placeholders = ",".join("?" for _ in ids)
            overwrites[table] = int(conn.execute(f"SELECT COUNT(*) FROM {table} WHERE id IN ({placeholders})", ids).fetchone()[0])
        else:
            overwrites[table] = 0
    for table in ["categories", "locations"]:
        for row in data.get(table, []):
            name = str(row.get("name", "")).strip()
            record_id = str(row.get("id", ""))
            if not name:
                continue
            existing = conn.execute(f"SELECT id FROM {table} WHERE lower(name)=lower(?)", (name,)).fetchone()
            if existing and existing["id"] != record_id:
                hard.append({"table": table, "type": "name", "message": f"{table}: Name '{name}' existiert mit anderer ID"})
    for row in data.get("project_items", []):
        project_id = str(row.get("project_id", ""))
        item_id = str(row.get("item_id", ""))
        record_id = str(row.get("id", ""))
        if project_id and item_id:
            existing = conn.execute("SELECT id FROM project_items WHERE project_id=? AND item_id=?", (project_id, item_id)).fetchone()
            if existing and existing["id"] != record_id:
                hard.append({"table": "project_items", "type": "pair", "message": "Projekt/Bauteil-Kombination existiert mit anderer ID"})
    return {"overwrites": overwrites, "hard": hard, "hard_count": len(hard), "overwrite_count": sum(overwrites.values())}


@app.post("/api/import/preview")
def import_preview():
    payload = payload_json()
    counts = validate_backup(payload)
    with connect_db() as conn:
        conflicts = detect_import_conflicts(conn, payload["data"])
    return jsonify({"valid": True, "counts": counts, "conflicts": conflicts, "format": BACKUP_FORMAT, "version": BACKUP_VERSION})


def normalize_import_record(record: dict[str, Any], table: str) -> dict[str, Any]:
    if not isinstance(record, dict):
        raise ValueError(f"Ungültiger Datensatz in {table}")
    result = dict(record)
    result["id"] = clean_text(result.get("id"), 80) or new_id()
    result["created_at"] = clean_text(result.get("created_at"), 40) or now_iso()
    result["updated_at"] = clean_text(result.get("updated_at"), 40) or now_iso()
    return result


def restore_replace(conn: sqlite3.Connection, data: dict[str, list[dict[str, Any]]]) -> None:
    for table in ["project_items", "projects", "items", "locations", "categories"]:
        conn.execute(f"DELETE FROM {table}")
    insert_all(conn, data, replace=False)


def insert_all(conn: sqlite3.Connection, data: dict[str, list[dict[str, Any]]], replace: bool) -> None:
    allowed_columns = {
        "categories": ["id", "name", "created_at", "updated_at"],
        "locations": ["id", "name", "created_at", "updated_at"],
        "items": ["id", "name", "category_id", "location_id", "quantity", "min_quantity", "unit", "value_text", "manufacturer", "part_number", "package", "source_url", "notes", "image_mime_type", "image_updated_at", "created_at", "updated_at"],
        "projects": ["id", "name", "status", "notes", "created_at", "updated_at"],
        "project_items": ["id", "project_id", "item_id", "required_quantity", "notes", "created_at", "updated_at"],
    }
    defaults = {
        "items": {"quantity": 0, "min_quantity": 0, "unit": "Stk", "value_text": "", "manufacturer": "", "part_number": "", "package": "", "source_url": "", "notes": "", "image_mime_type": "", "image_updated_at": "", "category_id": None, "location_id": None},
        "projects": {"status": "planned", "notes": ""},
        "project_items": {"required_quantity": 1, "notes": ""},
    }
    for table in ["categories", "locations", "items", "projects", "project_items"]:
        columns = allowed_columns[table]
        for raw in data[table]:
            rec = normalize_import_record(raw, table)
            for key, value in defaults.get(table, {}).items():
                rec.setdefault(key, value)
            if table in {"categories", "locations", "items", "projects"}:
                rec["name"] = require_name(rec)
            values = {k: rec.get(k) for k in columns}
            placeholders = ",".join(f":{k}" for k in columns)
            if replace:
                update_parts = []
                for k in columns:
                    if k == "id":
                        continue
                    if table == "items" and k in {"image_mime_type", "image_updated_at"}:
                        update_parts.append(f"{k}=CASE WHEN excluded.{k}='' THEN items.{k} ELSE excluded.{k} END")
                    else:
                        update_parts.append(f"{k}=excluded.{k}")
                updates = ",".join(update_parts)
                sql = f"INSERT INTO {table}({','.join(columns)}) VALUES({placeholders}) ON CONFLICT(id) DO UPDATE SET {updates}"
            else:
                sql = f"INSERT INTO {table}({','.join(columns)}) VALUES({placeholders})"
            conn.execute(sql, values)


@app.post("/api/import/restore")
def import_restore():
    wrapper = payload_json()
    strategy = wrapper.get("strategy", "replace") if wrapper.get("format") != BACKUP_FORMAT else "replace"
    payload = wrapper.get("backup") if "backup" in wrapper else wrapper
    if not isinstance(payload, dict):
        raise ValueError("Backup fehlt")
    counts = validate_backup(payload)
    if strategy not in {"replace", "merge"}:
        raise ValueError("Strategie muss replace oder merge sein")
    data = payload["data"]
    if strategy == "merge":
        with connect_db() as preview_conn:
            conflicts = detect_import_conflicts(preview_conn, data)
        if conflicts["hard_count"]:
            raise ValueError(f"Merge abgebrochen: {conflicts['hard_count']} ID-/Eindeutigkeitskonflikt(e) müssen zuerst gelöst werden")
    backup_database(f"pre-import-{strategy}")
    with connect_db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            if strategy == "replace":
                restore_replace(conn, data)
            else:
                insert_all(conn, data, replace=True)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    if strategy == "replace":
        for path in ITEM_IMAGE_DIR.glob("*"):
            if path.is_file():
                path.unlink(missing_ok=True)
    return jsonify({"ok": True, "strategy": strategy, "counts": counts})


@app.get("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.get("/<path:path>")
def frontend_files(path: str):
    candidate = FRONTEND_DIR / path
    if candidate.exists() and candidate.is_file():
        return send_from_directory(FRONTEND_DIR, path)
    return send_from_directory(FRONTEND_DIR, "index.html")


migrate()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")), debug=False)
