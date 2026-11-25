"""Run history and the last topology, kept in the same SQLite file as the inventory.

With this, a restart of the backend keeps the events and does not report the whole
network as new on the first run.
"""

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from app.models import DiscoveryRun, Topology

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, data TEXT NOT NULL, notable INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, data TEXT NOT NULL);
"""

KEEP_RUNS = 5000  # quiet runs; runs with changes are kept longer
KEEP_NOTABLE = 1000


def is_notable(run: DiscoveryRun) -> bool:
    """A run worth keeping in the Events list: it changed something or it failed."""
    return run.status == "failed" or bool(run.diff and run.diff.changes)


class HistoryStore:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._db() as db:
            db.executescript(SCHEMA)
            columns = {row[1] for row in db.execute("PRAGMA table_info(runs)")}
            if "notable" not in columns:
                db.execute("ALTER TABLE runs ADD COLUMN notable INTEGER NOT NULL DEFAULT 0")
                for run_id, data in db.execute("SELECT id, data FROM runs").fetchall():
                    if is_notable(DiscoveryRun.model_validate_json(data)):
                        db.execute("UPDATE runs SET notable = 1 WHERE id = ?", (run_id,))

    @contextmanager
    def _db(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.path)
        try:
            yield db
            db.commit()
        finally:
            db.close()

    def load_runs(self, limit: int) -> list[DiscoveryRun]:
        """Newest first."""
        with self._db() as db:
            rows = db.execute("SELECT data FROM runs ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [DiscoveryRun.model_validate_json(row[0]) for row in rows]

    def load_notable_runs(self, limit: int) -> list[DiscoveryRun]:
        """Runs with changes or failures, newest first, however old they are."""
        with self._db() as db:
            rows = db.execute("SELECT data FROM runs WHERE notable = 1 ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [DiscoveryRun.model_validate_json(row[0]) for row in rows]

    def last_run_id(self) -> int:
        with self._db() as db:
            return db.execute("SELECT COALESCE(MAX(id), 0) FROM runs").fetchone()[0]

    def save_run(self, run: DiscoveryRun) -> None:
        with self._db() as db:
            db.execute(
                "INSERT OR REPLACE INTO runs (id, data, notable) VALUES (?, ?, ?)",
                (run.id, run.model_dump_json(), int(is_notable(run))),
            )
            db.execute("DELETE FROM runs WHERE notable = 0 AND id <= ?", (run.id - KEEP_RUNS,))
            db.execute(
                "DELETE FROM runs WHERE notable = 1 AND id NOT IN "
                "(SELECT id FROM runs WHERE notable = 1 ORDER BY id DESC LIMIT ?)",
                (KEEP_NOTABLE,),
            )

    def load_topology(self) -> Topology | None:
        with self._db() as db:
            row = db.execute("SELECT data FROM state WHERE key = 'topology'").fetchone()
        return Topology.model_validate_json(row[0]) if row else None

    def save_topology(self, topology: Topology) -> None:
        with self._db() as db:
            db.execute(
                "INSERT OR REPLACE INTO state (key, data) VALUES ('topology', ?)", (topology.model_dump_json(),)
            )
