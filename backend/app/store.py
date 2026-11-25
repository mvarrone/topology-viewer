"""Device inventory in SQLite: devices and their connection methods.

Each connection method has its own username and password. Passwords are encrypted with Fernet.
The key is SECRET_KEY in .env; without it a key file is created next to the database on first
start. Passwords never leave this module in clear text, except inside the DeviceTarget objects
given to the collectors.
"""

import ipaddress
import logging
import re
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

import yaml
from cryptography.fernet import Fernet, InvalidToken
from pydantic import BaseModel, Field, SecretStr, field_validator

from app.inventory import DeviceEntry, DeviceTarget, InventoryError, InventoryStore, Protocol

log = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY,
    host TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_method_id INTEGER,
    last_polled_at TEXT,
    last_seen_at TEXT,
    last_hostname TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS connection_methods (
    id INTEGER PRIMARY KEY,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    protocol TEXT NOT NULL,
    port INTEGER,
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    platform TEXT,
    verify_tls INTEGER NOT NULL DEFAULT 0,
    timeout REAL NOT NULL DEFAULT 10
);
"""

# First version kept usernames and passwords in shared credential profiles.
MIGRATE_FROM_PROFILES = """
ALTER TABLE connection_methods RENAME TO connection_methods_old;
CREATE TABLE connection_methods (
    id INTEGER PRIMARY KEY,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    protocol TEXT NOT NULL,
    port INTEGER,
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    platform TEXT,
    verify_tls INTEGER NOT NULL DEFAULT 0,
    timeout REAL NOT NULL DEFAULT 10
);
INSERT INTO connection_methods (id, device_id, position, protocol, port, username, password, platform, verify_tls, timeout)
    SELECT m.id, m.device_id, m.position, m.protocol, m.port, c.username, c.password, m.platform, m.verify_tls, m.timeout
    FROM connection_methods_old m JOIN credentials c ON c.id = m.credential_id;
DROP TABLE connection_methods_old;
DROP TABLE credentials;
"""


# API models. Passwords are write only: they are accepted, never returned.


class MethodIn(BaseModel):
    id: int | None = None  # set when editing an existing method
    protocol: Protocol
    username: str = Field(min_length=1)
    # Required for a new method. Empty on an existing method keeps its password.
    password: SecretStr | None = None
    port: int | None = Field(default=None, ge=1, le=65535)
    platform: str | None = None
    verify_tls: bool = False
    timeout: float = Field(default=10.0, gt=0, le=120)


class MethodOut(BaseModel):
    id: int
    protocol: Protocol
    username: str
    port: int | None
    platform: str | None
    verify_tls: bool
    timeout: float


_HOSTNAME = re.compile(r"^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$")


def valid_host(value: str) -> str:
    """An IPv4 or IPv6 address, or a DNS name. Only digits and dots must be a full IPv4 address."""
    host = value.strip()
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        pass
    if re.fullmatch(r"[\d.]+", host) or not _HOSTNAME.match(host):
        raise ValueError(f"{host!r} is not a valid IP address or DNS name")
    return host


class InventoryDeviceIn(BaseModel):
    host: str = Field(min_length=1)
    enabled: bool = True
    methods: list[MethodIn] = Field(min_length=1)

    @field_validator("host")
    @classmethod
    def _check_host(cls, value: str) -> str:
        return valid_host(value)


class InventoryDeviceOut(BaseModel):
    id: int
    host: str
    enabled: bool
    methods: list[MethodOut]
    last_method_id: int | None
    last_polled_at: datetime | None
    last_seen_at: datetime | None
    last_hostname: str | None
    last_error: str | None


class NotFoundError(Exception):
    pass


class ConflictError(Exception):
    pass


def _now() -> str:
    return datetime.now(UTC).isoformat()


def load_key(secret_key: str | None, key_file: Path) -> bytes:
    """Fernet key from SECRET_KEY, or from a key file created on first use."""
    if secret_key:
        return secret_key.encode()
    if not key_file.exists():
        key_file.parent.mkdir(parents=True, exist_ok=True)
        key_file.write_bytes(Fernet.generate_key())
        log.warning("SECRET_KEY is not set; created %s. Move it to .env and keep a copy.", key_file)
    return key_file.read_bytes().strip()


class SqliteInventory(InventoryStore):
    def __init__(self, path: Path, key: bytes):
        self.path = path
        self.fernet = Fernet(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._db() as db:
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            if "credentials" in tables:
                db.executescript(MIGRATE_FROM_PROFILES)
                log.info("Moved usernames and passwords from credential profiles into each connection method")
            db.executescript(SCHEMA)

    @contextmanager
    def _db(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.path)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        try:
            yield db
            db.commit()
        finally:
            db.close()

    def _encrypt(self, value: str) -> str:
        return self.fernet.encrypt(value.encode()).decode()

    def _decrypt(self, token: str) -> str:
        try:
            return self.fernet.decrypt(token.encode()).decode()
        except InvalidToken as exc:
            raise InventoryError("a stored password cannot be decrypted: SECRET_KEY changed?") from exc

    # Devices

    def list_devices(self) -> list[InventoryDeviceOut]:
        with self._db() as db:
            devices = db.execute("SELECT * FROM devices ORDER BY host").fetchall()
            methods = db.execute("SELECT * FROM connection_methods ORDER BY device_id, position").fetchall()
        by_device: dict[int, list[MethodOut]] = {}
        for m in methods:
            by_device.setdefault(m["device_id"], []).append(
                MethodOut(
                    id=m["id"],
                    protocol=m["protocol"],
                    username=m["username"],
                    port=m["port"],
                    platform=m["platform"],
                    verify_tls=bool(m["verify_tls"]),
                    timeout=m["timeout"],
                )
            )
        return [
            InventoryDeviceOut(
                **{k: d[k] for k in InventoryDeviceOut.model_fields if k not in ("enabled", "methods")},
                enabled=bool(d["enabled"]),
                methods=by_device.get(d["id"], []),
            )
            for d in devices
        ]

    def get_device(self, device_id: int) -> InventoryDeviceOut:
        found = next((d for d in self.list_devices() if d.id == device_id), None)
        if not found:
            raise NotFoundError(f"Device {device_id} not found")
        return found

    def _write_methods(self, db: sqlite3.Connection, device_id: int, methods: list[MethodIn]) -> None:
        """Replace the methods of a device. Existing methods keep their id and, if no new one is
        given, their password."""
        stored = {
            row["id"]: row["password"]
            for row in db.execute("SELECT id, password FROM connection_methods WHERE device_id = ?", (device_id,))
        }
        db.execute("DELETE FROM connection_methods WHERE device_id = ?", (device_id,))
        for position, m in enumerate(methods, start=1):
            method_id = m.id if m.id in stored else None
            new_password = m.password.get_secret_value() if m.password else ""
            if new_password:
                password = self._encrypt(new_password)
            elif method_id:
                password = stored[method_id]
            else:
                raise ConflictError(f"Method {position}: a password is required")
            db.execute(
                """INSERT INTO connection_methods
                   (id, device_id, position, protocol, port, username, password, platform, verify_tls, timeout)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    method_id,
                    device_id,
                    position,
                    m.protocol,
                    m.port,
                    m.username.strip(),
                    password,
                    m.platform or None,
                    int(m.verify_tls),
                    m.timeout,
                ),
            )
        # Forget the method that worked last time if it was removed.
        kept = {m.id for m in methods if m.id in stored}
        last = db.execute("SELECT last_method_id FROM devices WHERE id = ?", (device_id,)).fetchone()
        if last and last[0] is not None and last[0] not in kept:
            db.execute("UPDATE devices SET last_method_id = NULL WHERE id = ?", (device_id,))

    def create_device(self, data: InventoryDeviceIn) -> InventoryDeviceOut:
        now = _now()
        try:
            with self._db() as db:
                cur = db.execute(
                    "INSERT INTO devices (host, enabled, created_at, updated_at) VALUES (?, ?, ?, ?)",
                    (data.host.strip(), int(data.enabled), now, now),
                )
                self._write_methods(db, cur.lastrowid, data.methods)
        except sqlite3.IntegrityError as exc:
            raise ConflictError(f"Device {data.host} already exists") from exc
        return self.get_device(cur.lastrowid)

    def update_device(self, device_id: int, data: InventoryDeviceIn) -> InventoryDeviceOut:
        self.get_device(device_id)
        try:
            with self._db() as db:
                db.execute(
                    "UPDATE devices SET host = ?, enabled = ?, updated_at = ? WHERE id = ?",
                    (data.host.strip(), int(data.enabled), _now(), device_id),
                )
                self._write_methods(db, device_id, data.methods)
        except sqlite3.IntegrityError as exc:
            raise ConflictError(f"Device {data.host} already exists") from exc
        return self.get_device(device_id)

    def delete_device(self, device_id: int) -> None:
        self.get_device(device_id)
        with self._db() as db:
            db.execute("DELETE FROM devices WHERE id = ?", (device_id,))

    # Discovery

    def entry(self, device_id: int) -> DeviceEntry:
        """One device with clear text credentials, enabled or not (for connection tests)."""
        found = next((e for e in self._entries(only_enabled=False) if e.id == device_id), None)
        if not found:
            raise NotFoundError(f"Device {device_id} not found")
        return found

    def load(self) -> list[DeviceEntry]:
        return self._entries(only_enabled=True)

    def _entries(self, only_enabled: bool) -> list[DeviceEntry]:
        with self._db() as db:
            devices = db.execute(
                "SELECT * FROM devices" + (" WHERE enabled = 1" if only_enabled else "") + " ORDER BY host"
            ).fetchall()
            methods = db.execute("SELECT * FROM connection_methods ORDER BY device_id, position").fetchall()
        hosts = {d["id"]: d["host"] for d in devices}
        targets: dict[int, list[DeviceTarget]] = {}
        for m in methods:
            if m["device_id"] not in hosts:
                continue
            targets.setdefault(m["device_id"], []).append(
                DeviceTarget(
                    host=hosts[m["device_id"]],
                    protocol=m["protocol"],
                    port=m["port"],
                    username=m["username"],
                    password=SecretStr(self._decrypt(m["password"])),
                    platform=m["platform"],
                    verify_tls=bool(m["verify_tls"]),
                    timeout=m["timeout"],
                    method_id=m["id"],
                )
            )
        return [
            DeviceEntry(id=d["id"], host=d["host"], methods=targets.get(d["id"], []), last_method_id=d["last_method_id"])
            for d in devices
            if targets.get(d["id"])
        ]

    def record_result(self, device_id, polled_at, method_id, hostname, error, detected_platform=None) -> None:
        at = polled_at.isoformat()
        with self._db() as db:
            if error is None:
                db.execute(
                    """UPDATE devices SET last_polled_at = ?, last_seen_at = ?, last_method_id = ?,
                       last_hostname = ?, last_error = NULL WHERE id = ?""",
                    (at, at, method_id, hostname, device_id),
                )
                if detected_platform and method_id:
                    db.execute(
                        "UPDATE connection_methods SET platform = ? WHERE id = ? AND platform IS NULL",
                        (detected_platform, method_id),
                    )
            else:
                # Every method was tried and failed (methods go in priority order), so none worked.
                db.execute(
                    "UPDATE devices SET last_polled_at = ?, last_error = ?, last_method_id = NULL WHERE id = ?",
                    (at, error, device_id),
                )

    # Import

    def is_empty(self) -> bool:
        with self._db() as db:
            return db.execute("SELECT COUNT(*) FROM devices").fetchone()[0] == 0

    def import_yaml(self, path: Path) -> int:
        """Import a devices.yaml (host, protocol, username, password, port...; optional defaults).

        Each device gets one connection method. Returns the number of devices imported.
        """
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        defaults = data.get("defaults") or {}
        count = 0
        for item in data.get("devices") or []:
            device = defaults | (item or {})
            method = MethodIn(
                protocol=device.get("protocol", "restconf"),
                username=str(device["username"]),
                password=SecretStr(str(device["password"])),
                port=device.get("port"),
                platform=device.get("platform"),
                verify_tls=device.get("verify_tls", False),
                timeout=device.get("timeout", 10.0),
            )
            self.create_device(
                InventoryDeviceIn(host=str(device["host"]), enabled=device.get("enabled", True), methods=[method])
            )
            count += 1
        return count
