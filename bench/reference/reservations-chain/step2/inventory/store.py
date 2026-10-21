import json
import threading
import uuid
from datetime import datetime, timedelta, timezone

from .errors import ApiError


def now():
    return datetime.now(timezone.utc)


def iso(moment):
    return moment.isoformat().replace("+00:00", "Z")


class Store:
    """All state lives here; every public method holds the lock for its whole operation."""

    def __init__(self):
        self.lock = threading.Lock()
        self.items = {}
        self.reservations = {}
        self.keys = {}

    def _active(self, reservation):
        return reservation["state"] == "active" and reservation["expires"] > now()

    def _available(self, sku):
        held = sum(
            quantity
            for r in self.reservations.values()
            if self._active(r)
            for line_sku, quantity in r["lines"]
            if line_sku == sku
        )
        return self.items[sku] - held

    def _view(self, sku):
        return {"sku": sku, "quantity": self.items[sku], "available": self._available(sku)}

    def create_item(self, sku, quantity):
        with self.lock:
            if sku in self.items:
                raise ApiError(409, "conflict")
            self.items[sku] = quantity
            return self._view(sku)

    def get_item(self, sku):
        with self.lock:
            if sku not in self.items:
                raise ApiError(404, "not_found")
            return self._view(sku)

    def list_items(self):
        with self.lock:
            return [self._view(sku) for sku in sorted(self.items)]

    def restock(self, sku, quantity):
        with self.lock:
            if sku not in self.items:
                raise ApiError(404, "not_found")
            self.items[sku] += quantity
            return self._view(sku)

    def reserve(self, lines, ttl, bundle, key=None, body=None):
        canonical = json.dumps(body, sort_keys=True)
        with self.lock:
            if key and key in self.keys:
                if self.keys[key][0] != canonical:
                    raise ApiError(422, "idempotency_mismatch")
                return self.keys[key][1]
            if any(sku not in self.items for sku, _ in lines):
                raise ApiError(404, "not_found")
            if any(self._available(sku) < quantity for sku, quantity in lines):
                raise ApiError(409, "insufficient_stock")
            reservation_id = uuid.uuid4().hex
            expires = now() + timedelta(seconds=ttl)
            self.reservations[reservation_id] = {"lines": lines, "expires": expires, "state": "active"}
            if bundle:
                result = {
                    "id": reservation_id,
                    "lines": [{"sku": sku, "quantity": quantity} for sku, quantity in lines],
                    "expiresAt": iso(expires),
                }
            else:
                sku, quantity = lines[0]
                result = {"id": reservation_id, "sku": sku, "quantity": quantity, "expiresAt": iso(expires)}
            if key:
                self.keys[key] = (canonical, result)
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
                "lines": [{"sku": sku, "quantity": q} for sku, q in reservation["lines"]],
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
            for sku, quantity in reservation["lines"]:
                self.items[sku] -= quantity
            return {"id": reservation_id, "status": "confirmed"}
