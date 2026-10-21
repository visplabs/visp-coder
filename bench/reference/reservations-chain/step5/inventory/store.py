import json
import os
import threading
import uuid
from datetime import datetime, timedelta, timezone

from .errors import ApiError


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
    """All state lives here; every public method holds the lock for its whole operation.

    Items and reservation lines are keyed by key(sku); `names` keeps the spelling each item was
    created with, which every response shows. With a data file, every change is written to it
    before the response, and a new store starts from it.
    """

    def __init__(self, path=None):
        self.lock = threading.Lock()
        self.path = path
        self.items = {}
        self.names = {}
        self.reservations = {}
        self.keys = {}
        if path and os.path.exists(path):
            self._load()

    def _load(self):
        with open(self.path) as handle:
            state = json.load(handle)
        self.items, self.names, self.keys = state["items"], state["names"], state["keys"]
        self.reservations = {
            reservation_id: {"lines": [tuple(line) for line in r["lines"]], "expires": parse_iso(r["expires"]),
                             "state": r["state"]}
            for reservation_id, r in state["reservations"].items()
        }

    def _save(self):
        """Write the whole state atomically: a crash leaves the old file or the new one."""
        if not self.path:
            return
        state = {
            "items": self.items, "names": self.names, "keys": self.keys,
            "reservations": {reservation_id: {**r, "expires": iso(r["expires"])}
                             for reservation_id, r in self.reservations.items()},
        }
        temporary = f"{self.path}.tmp"
        with open(temporary, "w") as handle:
            json.dump(state, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, self.path)

    def _active(self, reservation):
        return reservation["state"] == "active" and reservation["expires"] > now()

    def _available(self, item):
        held = sum(
            quantity
            for r in self.reservations.values()
            if self._active(r)
            for line_item, quantity in r["lines"]
            if line_item == item
        )
        return self.items[item] - held

    def _view(self, item):
        return {"sku": self.names[item], "quantity": self.items[item], "available": self._available(item)}

    def _known(self, sku):
        item = key(sku)
        if item not in self.items:
            raise ApiError(404, "not_found")
        return item

    def _lines(self, lines):
        return [{"sku": self.names[item], "quantity": quantity} for item, quantity in lines]

    def create_item(self, sku, quantity):
        with self.lock:
            item = key(sku)
            if item in self.items:
                raise ApiError(409, "conflict")
            self.items[item] = quantity
            self.names[item] = sku
            self._save()
            return self._view(item)

    def get_item(self, sku):
        with self.lock:
            return self._view(self._known(sku))

    def list_items(self):
        with self.lock:
            return [self._view(item) for item in sorted(self.items, key=self.names.get)]

    def restock(self, sku, quantity):
        with self.lock:
            item = self._known(sku)
            self.items[item] += quantity
            self._save()
            return self._view(item)

    def reserve(self, lines, ttl, bundle, idempotency_key=None, body=None):
        canonical = json.dumps(body, sort_keys=True)
        with self.lock:
            if idempotency_key and idempotency_key in self.keys:
                if self.keys[idempotency_key][0] != canonical:
                    raise ApiError(422, "idempotency_mismatch")
                return self.keys[idempotency_key][1]
            lines = [(self._known(sku), quantity) for sku, quantity in lines]
            if any(self._available(item) < quantity for item, quantity in lines):
                raise ApiError(409, "insufficient_stock")
            reservation_id = uuid.uuid4().hex
            expires = now() + timedelta(seconds=ttl)
            self.reservations[reservation_id] = {"lines": lines, "expires": expires, "state": "active"}
            if bundle:
                result = {"id": reservation_id, "lines": self._lines(lines), "expiresAt": iso(expires)}
            else:
                item, quantity = lines[0]
                result = {"id": reservation_id, "sku": self.names[item], "quantity": quantity, "expiresAt": iso(expires)}
            if idempotency_key:
                self.keys[idempotency_key] = (canonical, result)
            self._save()
            return result

    def get_reservation(self, reservation_id):
        with self.lock:
            reservation = self.reservations.get(reservation_id)
            if not reservation:
                raise ApiError(404, "not_found")
            status = reservation["state"]
            if status == "active" and reservation["expires"] <= now():
                status = "expired"
            return {
                "id": reservation_id,
                "status": status,
                "lines": self._lines(reservation["lines"]),
                "expiresAt": iso(reservation["expires"]),
            }

    def release(self, reservation_id):
        with self.lock:
            reservation = self.reservations.get(reservation_id)
            if not reservation or not self._active(reservation):
                raise ApiError(404, "not_found")
            reservation["state"] = "released"
            self._save()

    def confirm(self, reservation_id):
        with self.lock:
            reservation = self.reservations.get(reservation_id)
            if not reservation or reservation["state"] == "released":
                raise ApiError(404, "not_found")
            if reservation["state"] == "confirmed":
                raise ApiError(409, "already_confirmed")
            if reservation["expires"] <= now():
                raise ApiError(410, "expired")
            reservation["state"] = "confirmed"
            for item, quantity in reservation["lines"]:
                self.items[item] -= quantity
            self._save()
            return {"id": reservation_id, "status": "confirmed"}
