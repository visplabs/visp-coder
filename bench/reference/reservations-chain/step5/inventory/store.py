"""Inventory with time-limited reservations, kept in SQLite."""
import json
import sqlite3
import threading
import uuid
from datetime import datetime, timedelta, timezone

from .errors import ApiError

SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
    item TEXT PRIMARY KEY,          -- key(sku): SKUs are case-insensitive
    sku TEXT NOT NULL,              -- the spelling the item was created with
    quantity INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reservations (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL,            -- active, released or confirmed; expiry is read from expires
    expires TEXT NOT NULL           -- ISO 8601 UTC
);
CREATE TABLE IF NOT EXISTS lines (
    reservation TEXT NOT NULL REFERENCES reservations(id),
    position INTEGER NOT NULL,
    item TEXT NOT NULL REFERENCES items(item),
    quantity INTEGER NOT NULL,
    PRIMARY KEY (reservation, position)
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
    key TEXT PRIMARY KEY,
    body TEXT NOT NULL,             -- the canonical request body
    response TEXT NOT NULL          -- the 201 response, as JSON
);
"""


def now():
    return datetime.now(timezone.utc)


def iso(moment):
    return moment.isoformat().replace("+00:00", "Z")


def parse_iso(text):
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def key(sku):
    """SKUs are case-insensitive: every lookup goes through this key."""
    return sku.lower()


class Store:
    """All state lives in one SQLite connection; every public method holds the lock and runs in
    one transaction, so concurrent requests never interleave and a change is on disk before the
    response."""

    def __init__(self, path=None):
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path or ":memory:", check_same_thread=False, isolation_level=None)
        self.db.executescript(SCHEMA)

    def _transaction(self):
        store = self

        class Transaction:
            def __enter__(self):
                store.lock.acquire()
                store.db.execute("BEGIN IMMEDIATE")
                return store.db

            def __exit__(self, kind, error, trace):
                try:
                    store.db.execute("COMMIT" if kind is None else "ROLLBACK")
                finally:
                    store.lock.release()

        return Transaction()

    def _active(self, state, expires):
        return state == "active" and parse_iso(expires) > now()

    def _available(self, db, item):
        quantity = db.execute("SELECT quantity FROM items WHERE item = ?", (item,)).fetchone()[0]
        held = sum(
            count
            for state, expires, count in db.execute(
                "SELECT r.state, r.expires, l.quantity FROM lines l JOIN reservations r ON r.id = l.reservation "
                "WHERE l.item = ? AND r.state = 'active'", (item,))
            if self._active(state, expires)
        )
        return quantity - held

    def _view(self, db, item):
        sku, quantity = db.execute("SELECT sku, quantity FROM items WHERE item = ?", (item,)).fetchone()
        return {"sku": sku, "quantity": quantity, "available": self._available(db, item)}

    def _known(self, db, sku):
        item = key(sku)
        if not db.execute("SELECT 1 FROM items WHERE item = ?", (item,)).fetchone():
            raise ApiError(404, "not_found")
        return item

    def _lines(self, db, reservation_id):
        return [{"sku": sku, "quantity": quantity} for sku, quantity in db.execute(
            "SELECT i.sku, l.quantity FROM lines l JOIN items i ON i.item = l.item WHERE l.reservation = ? "
            "ORDER BY l.position", (reservation_id,))]

    def _reservation(self, db, reservation_id):
        return db.execute("SELECT state, expires FROM reservations WHERE id = ?", (reservation_id,)).fetchone()

    def create_item(self, sku, quantity):
        with self._transaction() as db:
            item = key(sku)
            if db.execute("SELECT 1 FROM items WHERE item = ?", (item,)).fetchone():
                raise ApiError(409, "conflict")
            db.execute("INSERT INTO items (item, sku, quantity) VALUES (?, ?, ?)", (item, sku, quantity))
            return self._view(db, item)

    def get_item(self, sku):
        with self._transaction() as db:
            return self._view(db, self._known(db, sku))

    def list_items(self):
        with self._transaction() as db:
            items = [item for item, in db.execute("SELECT item FROM items")]
            return sorted((self._view(db, item) for item in items), key=lambda view: view["sku"])

    def restock(self, sku, quantity):
        with self._transaction() as db:
            item = self._known(db, sku)
            db.execute("UPDATE items SET quantity = quantity + ? WHERE item = ?", (quantity, item))
            return self._view(db, item)

    def reserve(self, lines, ttl, bundle, idempotency_key=None, body=None):
        canonical = json.dumps(body, sort_keys=True)
        with self._transaction() as db:
            if idempotency_key:
                earlier = db.execute("SELECT body, response FROM idempotency_keys WHERE key = ?",
                                     (idempotency_key,)).fetchone()
                if earlier:
                    if earlier[0] != canonical:
                        raise ApiError(422, "idempotency_mismatch")
                    return json.loads(earlier[1])
            lines = [(self._known(db, sku), quantity) for sku, quantity in lines]
            if any(self._available(db, item) < quantity for item, quantity in lines):
                raise ApiError(409, "insufficient_stock")
            reservation_id = uuid.uuid4().hex
            expires = iso(now() + timedelta(seconds=ttl))
            db.execute("INSERT INTO reservations (id, state, expires) VALUES (?, 'active', ?)", (reservation_id, expires))
            db.executemany("INSERT INTO lines (reservation, position, item, quantity) VALUES (?, ?, ?, ?)",
                           [(reservation_id, position, item, quantity) for position, (item, quantity) in enumerate(lines)])
            shown = self._lines(db, reservation_id)
            if bundle:
                result = {"id": reservation_id, "lines": shown, "expiresAt": expires}
            else:
                result = {"id": reservation_id, **shown[0], "expiresAt": expires}
            if idempotency_key:
                db.execute("INSERT INTO idempotency_keys (key, body, response) VALUES (?, ?, ?)",
                           (idempotency_key, canonical, json.dumps(result)))
            return result

    def get_reservation(self, reservation_id):
        with self._transaction() as db:
            found = self._reservation(db, reservation_id)
            if not found:
                raise ApiError(404, "not_found")
            state, expires = found
            status = "expired" if state == "active" and parse_iso(expires) <= now() else state
            return {"id": reservation_id, "status": status, "lines": self._lines(db, reservation_id), "expiresAt": expires}

    def release(self, reservation_id):
        with self._transaction() as db:
            found = self._reservation(db, reservation_id)
            if not found or not self._active(*found):
                raise ApiError(404, "not_found")
            db.execute("UPDATE reservations SET state = 'released' WHERE id = ?", (reservation_id,))

    def confirm(self, reservation_id):
        with self._transaction() as db:
            found = self._reservation(db, reservation_id)
            if not found or found[0] == "released":
                raise ApiError(404, "not_found")
            if found[0] == "confirmed":
                raise ApiError(409, "already_confirmed")
            if parse_iso(found[1]) <= now():
                raise ApiError(410, "expired")
            db.execute("UPDATE reservations SET state = 'confirmed' WHERE id = ?", (reservation_id,))
            db.execute("UPDATE items SET quantity = quantity - (SELECT l.quantity FROM lines l WHERE l.reservation = ? "
                       "AND l.item = items.item) WHERE item IN (SELECT item FROM lines WHERE reservation = ?)",
                       (reservation_id, reservation_id))
            return {"id": reservation_id, "status": "confirmed"}
