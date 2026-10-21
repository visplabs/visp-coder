import json
import threading
import uuid
from datetime import datetime, timedelta, timezone

from .errors import ApiError


def now():
    return datetime.now(timezone.utc)


def iso(moment):
    return moment.isoformat().replace("+00:00", "Z")


def key(sku):
    """SKUs are case-insensitive: every lookup goes through this key."""
    return sku.lower()


class Store:
    """All state lives here; every public method holds the lock for its whole operation.

    Items and reservation lines are keyed by key(sku); `names` keeps the spelling each item was
    created with, which every response shows.
    """

    def __init__(self):
        self.lock = threading.Lock()
        self.items = {}
        self.names = {}
        self.reservations = {}
        self.keys = {}

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
            return {"id": reservation_id, "status": "confirmed"}
