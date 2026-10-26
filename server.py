"""APW Hours Log — a tiny hours-logging app for an advanced programming class.

Standard library only. Run:  python3 server.py  (then open http://localhost:8000)
The first account that signs up becomes an admin.
"""

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlencode, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("APWLOG_DB", os.path.join(ROOT, "apwlog.db"))
STATIC_DIR = os.path.join(ROOT, "static")
SESSION_DAYS = 14
COOKIE = "apwlog_session"


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                name TEXT NOT NULL,
                salt TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                is_admin INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS weeks (
                id INTEGER PRIMARY KEY,
                label TEXT NOT NULL DEFAULT '',
                start_date TEXT NOT NULL,
                end_date TEXT NOT NULL,
                auto INTEGER NOT NULL DEFAULT 0  -- created by ensure_current_week, not an admin
            );
            CREATE TABLE IF NOT EXISTS entries (
                id INTEGER PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                week_id INTEGER NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
                hours REAL NOT NULL,
                description TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE (user_id, week_id)
            );
            """
        )


def hash_password(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 200_000)
    return salt, digest.hex()


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def parse_date(value):
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError):
        return None


def public_user(row):
    return {"id": row["id"], "username": row["username"], "name": row["name"], "is_admin": bool(row["is_admin"])}


def week_dict(row):
    return {"id": row["id"], "label": row["label"], "start": row["start_date"], "end": row["end_date"]}


def entry_dict(row):
    return {"week_id": row["week_id"], "hours": row["hours"], "description": row["description"]}


def ensure_current_week(conn):
    """Make sure some week covers today, so students always have somewhere to log hours.

    Creates the Monday–Sunday week containing today, trimmed so it doesn't overlap
    any week the admin already set up. Admins can relabel or adjust it afterward.
    """
    today = date.today().isoformat()
    if conn.execute("SELECT 1 FROM weeks WHERE start_date <= ? AND end_date >= ?", (today, today)).fetchone():
        return
    start = date.today() - timedelta(days=date.today().weekday())
    end = start + timedelta(days=6)
    prev_end = conn.execute("SELECT MAX(end_date) FROM weeks WHERE end_date < ?", (today,)).fetchone()[0]
    next_start = conn.execute("SELECT MIN(start_date) FROM weeks WHERE start_date > ?", (today,)).fetchone()[0]
    if prev_end:
        start = max(start, date.fromisoformat(prev_end) + timedelta(days=1))
    if next_start:
        end = min(end, date.fromisoformat(next_start) - timedelta(days=1))
    conn.execute("INSERT INTO weeks (label, start_date, end_date, auto) VALUES ('', ?, ?, 1)", (start.isoformat(), end.isoformat()))


def all_weeks(conn):
    ensure_current_week(conn)
    return [week_dict(r) for r in conn.execute("SELECT * FROM weeks ORDER BY start_date")]


# ---------- hours storage: Google Sheet when configured, else the local database ----------


def load_config():
    path = os.path.join(ROOT, "config.json")
    config = {}
    if os.path.isfile(path):
        with open(path) as f:
            config = json.load(f)
    return {
        "sheet_script_url": os.environ.get("SHEET_SCRIPT_URL", config.get("sheet_script_url", "")).strip(),
        "sheet_token": os.environ.get("SHEET_TOKEN", config.get("sheet_token", "")).strip(),
    }


CONFIG = load_config()
USE_SHEET = CONFIG["sheet_script_url"].startswith("https://")  # ignores the placeholder in a fresh config.json
SHEET_CACHE_SECONDS = 10
_sheet_cache = {"rows": None, "at": 0.0}
_sheet_lock = threading.Lock()


def sheet_call(payload=None):
    """GET (payload None) or POST to the Apps Script web app and return its JSON."""
    url = CONFIG["sheet_script_url"]
    if payload is None:
        req = urllib.request.Request(f"{url}?{urlencode({'token': CONFIG['sheet_token']})}")
    else:
        body = json.dumps({**payload, "token": CONFIG["sheet_token"]}).encode()
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    try:
        # Apps Script answers with a redirect to the result; urllib follows it as a GET.
        with urllib.request.urlopen(req, timeout=20) as res:
            data = json.loads(res.read())
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
        raise ApiError(502, f"Couldn't reach the Google Sheet ({e})")
    if data.get("error"):
        raise ApiError(502, f"Google Sheet error: {data['error']}")
    return data


def sheet_rows():
    with _sheet_lock:
        if _sheet_cache["rows"] is None or time.monotonic() - _sheet_cache["at"] > SHEET_CACHE_SECONDS:
            _sheet_cache["rows"] = sheet_call()["rows"]
            _sheet_cache["at"] = time.monotonic()
        return _sheet_cache["rows"]


def sheet_write(payload):
    with _sheet_lock:
        _sheet_cache["rows"] = None
    sheet_call(payload)


def all_entries(conn):
    """{user_id: {week_id: entry}} for every student."""
    result = {}
    if not USE_SHEET:
        for r in conn.execute("SELECT * FROM entries"):
            result.setdefault(r["user_id"], {})[r["week_id"]] = entry_dict(r)
        return result
    users = {r["username"].lower(): r["id"] for r in conn.execute("SELECT id, username FROM users")}
    weeks = all_weeks(conn)
    for row in sheet_rows():
        user_id = users.get(row["username"].lower())
        # A row belongs to whichever week contains the date in its Week column.
        week = next((w for w in weeks if w["start"] <= row["week"] <= w["end"]), None)
        if user_id is None or week is None:
            continue
        try:
            hours = round(float(row["hours"]), 2)
        except (TypeError, ValueError):
            continue
        result.setdefault(user_id, {})[week["id"]] = {"week_id": week["id"], "hours": hours, "description": row["notes"]}
    return result


def user_entries(conn, user_id):
    if not USE_SHEET:
        rows = conn.execute("SELECT * FROM entries WHERE user_id = ?", (user_id,))
        return {r["week_id"]: entry_dict(r) for r in rows}
    return all_entries(conn).get(user_id, {})


def save_entry(conn, user, week, hours, description):
    if USE_SHEET:
        return sheet_write({
            "action": "upsert", "username": user["username"], "name": user["name"],
            "start": week["start_date"], "end": week["end_date"], "hours": hours, "notes": description,
        })
    conn.execute(
        "INSERT INTO entries (user_id, week_id, hours, description, updated_at) VALUES (?, ?, ?, ?, ?) "
        "ON CONFLICT (user_id, week_id) DO UPDATE SET "
        "hours = excluded.hours, description = excluded.description, updated_at = excluded.updated_at",
        (user["id"], week["id"], hours, description, now_iso()),
    )


def delete_entry(conn, user, week):
    if USE_SHEET:
        return sheet_write({"action": "delete", "username": user["username"], "start": week["start_date"], "end": week["end_date"]})
    conn.execute("DELETE FROM entries WHERE week_id = ? AND user_id = ?", (week["id"], user["id"]))


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class Handler(BaseHTTPRequestHandler):
    server_version = "APWLog/1.0"

    # ---------- plumbing ----------

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def send_json(self, status, payload, extra_headers=()):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in extra_headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        if "application/json" not in self.headers.get("Content-Type", ""):
            raise ApiError(415, "Expected JSON")
        length = int(self.headers.get("Content-Length") or 0)
        if length > 100_000:
            raise ApiError(413, "Request too large")
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            raise ApiError(400, "Invalid JSON")

    def session_token(self):
        jar = cookies.SimpleCookie(self.headers.get("Cookie", ""))
        return jar[COOKIE].value if COOKIE in jar else None

    def current_user(self, conn):
        token = self.session_token()
        if not token:
            return None
        row = conn.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id "
            "WHERE s.token = ? AND s.expires_at > ?",
            (token, now_iso()),
        ).fetchone()
        return row

    def require_user(self, conn):
        user = self.current_user(conn)
        if not user:
            raise ApiError(401, "Please log in")
        return user

    def require_admin(self, conn):
        user = self.require_user(conn)
        if not user["is_admin"]:
            raise ApiError(403, "Admins only")
        return user

    def session_cookie(self, token, max_age):
        return f"{COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={max_age}"

    def start_session(self, conn, user_id):
        token = secrets.token_urlsafe(32)
        expires = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)
        conn.execute("INSERT INTO sessions VALUES (?, ?, ?)", (token, user_id, expires.isoformat()))
        return ("Set-Cookie", self.session_cookie(token, SESSION_DAYS * 86400))

    # ---------- routing ----------

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            return self.dispatch("GET", path)
        self.serve_static(path)

    def do_POST(self):
        self.dispatch("POST", urlparse(self.path).path)

    def do_DELETE(self):
        self.dispatch("DELETE", urlparse(self.path).path)

    def dispatch(self, method, path):
        parts = [p for p in path.split("/") if p][1:]  # drop "api"
        routes = {
            ("GET", "me"): self.api_me,
            ("POST", "signup"): self.api_signup,
            ("POST", "login"): self.api_login,
            ("POST", "logout"): self.api_logout,
            ("GET", "entries"): self.api_list_entries,
            ("POST", "entries"): self.api_save_entry,
            ("DELETE", "entries"): self.api_delete_entry,
            ("GET", "admin"): self.api_admin,
            ("POST", "admin"): self.api_admin_action,
            ("DELETE", "admin"): self.api_admin_delete,
        }
        handler = routes.get((method, parts[0] if parts else ""))
        try:
            if not handler:
                raise ApiError(404, "Not found")
            with db() as conn:
                handler(conn, parts[1:])
        except ApiError as e:
            self.send_json(e.status, {"error": e.message})
        except Exception as e:  # noqa: BLE001
            self.log_error("Unhandled error: %r", e)
            self.send_json(500, {"error": "Server error"})

    def serve_static(self, path):
        name = "index.html" if path in ("", "/") else path.lstrip("/")
        full = os.path.realpath(os.path.join(STATIC_DIR, name))
        if not full.startswith(STATIC_DIR + os.sep) or not os.path.isfile(full):
            full = os.path.join(STATIC_DIR, "index.html")  # SPA fallback
        types = {".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml"}
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", types.get(os.path.splitext(full)[1], "application/octet-stream") + "; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---------- auth ----------

    def api_me(self, conn, _):
        user = self.current_user(conn)
        self.send_json(200, {"user": public_user(user) if user else None})

    def api_signup(self, conn, _):
        data = self.read_json()
        username = str(data.get("username", "")).strip()
        name = str(data.get("name", "")).strip()
        password = str(data.get("password", ""))
        if not (3 <= len(username) <= 40) or not username.replace("_", "").replace(".", "").isalnum():
            raise ApiError(400, "Username must be 3–40 letters, numbers, dots or underscores")
        if not name or len(name) > 80:
            raise ApiError(400, "Please enter your name")
        if len(password) < 8:
            raise ApiError(400, "Password must be at least 8 characters")
        if conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
            raise ApiError(409, "That username is taken")
        is_admin = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
        salt, pw_hash = hash_password(password)
        cur = conn.execute(
            "INSERT INTO users (username, name, salt, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (username, name, salt, pw_hash, int(is_admin), now_iso()),
        )
        user = conn.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone()
        cookie = self.start_session(conn, user["id"])
        self.send_json(201, {"user": public_user(user)}, [cookie])

    def api_login(self, conn, _):
        data = self.read_json()
        user = conn.execute("SELECT * FROM users WHERE username = ?", (str(data.get("username", "")).strip(),)).fetchone()
        password = str(data.get("password", ""))
        if not user or not hmac.compare_digest(hash_password(password, user["salt"])[1], user["password_hash"]):
            raise ApiError(401, "Wrong username or password")
        conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (now_iso(),))
        cookie = self.start_session(conn, user["id"])
        self.send_json(200, {"user": public_user(user)}, [cookie])

    def api_logout(self, conn, _):
        token = self.session_token()
        if token:
            conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
        self.send_json(200, {"ok": True}, [("Set-Cookie", self.session_cookie("", 0))])

    # ---------- entries ----------

    def api_list_entries(self, conn, _):
        user = self.require_user(conn)
        self.send_json(200, {"weeks": all_weeks(conn), "entries": user_entries(conn, user["id"])})

    def open_week(self, conn, week_id):
        week = conn.execute("SELECT * FROM weeks WHERE id = ?", (week_id,)).fetchone()
        if not week:
            raise ApiError(404, "Week not found")
        if date.fromisoformat(week["start_date"]) > date.today():
            raise ApiError(400, "That week hasn't started yet")
        return week

    def api_save_entry(self, conn, _):
        user = self.require_user(conn)
        data = self.read_json()
        try:
            week_id = int(data.get("week_id"))
        except (TypeError, ValueError):
            raise ApiError(400, "Pick a week")
        week = self.open_week(conn, week_id)
        try:
            hours = round(float(data.get("hours")), 2)
        except (TypeError, ValueError):
            raise ApiError(400, "Hours must be a number")
        if not (0 < hours <= 100):
            raise ApiError(400, "Weekly hours must be between 0 and 100")
        description = str(data.get("description", "")).strip()
        if not description:
            raise ApiError(400, "Describe what you worked on this week")
        if len(description) > 2000:
            raise ApiError(400, "Description is too long (2000 characters max)")
        save_entry(conn, user, week, hours, description)
        self.send_json(200, {"entries": user_entries(conn, user["id"])})

    def api_delete_entry(self, conn, parts):
        user = self.require_user(conn)
        if not parts or not parts[0].isdigit():
            raise ApiError(404, "Not found")
        week = conn.execute("SELECT * FROM weeks WHERE id = ?", (int(parts[0]),)).fetchone()
        if not week:
            raise ApiError(404, "Week not found")
        delete_entry(conn, user, week)
        self.send_json(200, {"entries": user_entries(conn, user["id"])})

    # ---------- admin ----------

    def api_admin(self, conn, parts):
        self.require_admin(conn)
        if parts and parts[0] == "overview":
            users = conn.execute("SELECT * FROM users ORDER BY is_admin, name COLLATE NOCASE").fetchall()
            hours = {  # user_id -> {week_id: hours}
                uid: {wid: e["hours"] for wid, e in per.items()} for uid, per in all_entries(conn).items()
            }
            students = [
                {**public_user(u), "hours": hours.get(u["id"], {}), "total": round(sum(hours.get(u["id"], {}).values()), 2)}
                for u in users
            ]
            return self.send_json(200, {"weeks": all_weeks(conn), "students": students})
        if len(parts) == 3 and parts[0] == "users" and parts[1].isdigit() and parts[2] == "entries":
            user = conn.execute("SELECT * FROM users WHERE id = ?", (int(parts[1]),)).fetchone()
            if not user:
                raise ApiError(404, "User not found")
            return self.send_json(200, {"user": public_user(user), "weeks": all_weeks(conn), "entries": user_entries(conn, user["id"])})
        raise ApiError(404, "Not found")

    def read_week(self, conn, exclude_id=None):
        data = self.read_json()
        start, end = parse_date(data.get("start")), parse_date(data.get("end"))
        label = str(data.get("label", "")).strip()
        if not start or not end:
            raise ApiError(400, "Pick a start and end date")
        if end < start:
            raise ApiError(400, "End date must be on or after the start date")
        if len(label) > 60:
            raise ApiError(400, "Label is too long (60 characters max)")
        # Admin-defined weeks replace auto-created ones that nobody has logged hours in yet.
        conn.execute(
            "DELETE FROM weeks WHERE auto = 1 AND start_date <= ? AND end_date >= ? AND id IS NOT ? "
            "AND NOT EXISTS (SELECT 1 FROM entries WHERE entries.week_id = weeks.id)",
            (end.isoformat(), start.isoformat(), exclude_id),
        )
        clash = conn.execute(
            "SELECT * FROM weeks WHERE start_date <= ? AND end_date >= ? AND id IS NOT ?",
            (end.isoformat(), start.isoformat(), exclude_id),
        ).fetchone()
        if clash:
            raise ApiError(409, f"Overlaps {clash['label'] or 'the week'} ({clash['start_date']} to {clash['end_date']})")
        return label, start.isoformat(), end.isoformat()

    def api_admin_action(self, conn, parts):
        admin = self.require_admin(conn)
        if parts == ["weeks"]:
            conn.execute("INSERT INTO weeks (label, start_date, end_date) VALUES (?, ?, ?)", self.read_week(conn))
            return self.send_json(201, {"weeks": all_weeks(conn)})
        if len(parts) == 2 and parts[0] == "weeks" and parts[1].isdigit():
            week_id = int(parts[1])
            cur = conn.execute(
                "UPDATE weeks SET label = ?, start_date = ?, end_date = ?, auto = 0 WHERE id = ?",
                (*self.read_week(conn, exclude_id=week_id), week_id),
            )
            if cur.rowcount == 0:
                raise ApiError(404, "Week not found")
            return self.send_json(200, {"weeks": all_weeks(conn)})
        if len(parts) == 3 and parts[0] == "users" and parts[1].isdigit() and parts[2] == "role":
            target_id = int(parts[1])
            if target_id == admin["id"]:
                raise ApiError(400, "You can't change your own role")
            make_admin = bool(self.read_json().get("is_admin"))
            cur = conn.execute("UPDATE users SET is_admin = ? WHERE id = ?", (int(make_admin), target_id))
            if cur.rowcount == 0:
                raise ApiError(404, "User not found")
            return self.send_json(200, {"ok": True})
        if len(parts) == 3 and parts[0] == "users" and parts[1].isdigit() and parts[2] == "password":
            password = str(self.read_json().get("password", ""))
            if len(password) < 8:
                raise ApiError(400, "Password must be at least 8 characters")
            salt, pw_hash = hash_password(password)
            cur = conn.execute("UPDATE users SET salt = ?, password_hash = ? WHERE id = ?", (salt, pw_hash, int(parts[1])))
            if cur.rowcount == 0:
                raise ApiError(404, "User not found")
            conn.execute("DELETE FROM sessions WHERE user_id = ?", (int(parts[1]),))
            return self.send_json(200, {"ok": True})
        raise ApiError(404, "Not found")

    def api_admin_delete(self, conn, parts):
        self.require_admin(conn)
        if len(parts) == 2 and parts[0] == "weeks" and parts[1].isdigit():
            cur = conn.execute("DELETE FROM weeks WHERE id = ?", (int(parts[1]),))
            if cur.rowcount == 0:
                raise ApiError(404, "Week not found")
            return self.send_json(200, {"weeks": all_weeks(conn)})
        raise ApiError(404, "Not found")


def main():
    init_db()
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"APW Hours Log running at http://localhost:{port}")
    print("Hours are stored in " + ("the Google Sheet" if USE_SHEET else f"the local database ({DB_PATH})"), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
