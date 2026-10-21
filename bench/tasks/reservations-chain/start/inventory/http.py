import json
from http.server import BaseHTTPRequestHandler

from . import validation
from .errors import ApiError

ROUTES = (
    (("v1", "items"), {"POST": "create_item"}),
    (("v1", "items", None), {"GET": "get_item"}),
    (("v1", "reservations"), {"POST": "create_reservation"}),
    (("v1", "reservations", None), {"DELETE": "release"}),
    (("v1", "reservations", None, "confirm"), {"POST": "confirm"}),
)


def match(parts):
    for pattern, methods in ROUTES:
        if len(pattern) == len(parts) and all(p is None or p == q for p, q in zip(pattern, parts)):
            return methods, [q for p, q in zip(pattern, parts) if p is None]
    return None, []


def make_handler(store):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, status, body=None):
            data = b"" if body is None else json.dumps(body).encode()
            self.send_response(status)
            if body is not None:
                self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def json_body(self):
            raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            media = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
            if media != "application/json":
                raise ApiError(415, "unsupported_media_type")
            try:
                value = json.loads(raw)
            except ValueError:
                raise ApiError(400, "invalid_json")
            if not isinstance(value, dict):
                raise ApiError(422, "invalid_request")
            return value

        def create_item(self):
            sku, quantity = validation.item_request(self.json_body())
            return 201, store.create_item(sku, quantity)

        def get_item(self, sku):
            return 200, store.get_item(sku)

        def create_reservation(self):
            body = self.json_body()
            sku, quantity, ttl = validation.reservation_request(body)
            return 201, store.reserve(sku, quantity, ttl, self.headers.get("Idempotency-Key"), body)

        def release(self, reservation_id):
            store.release(reservation_id)
            return 204, None

        def confirm(self, reservation_id):
            return 200, store.confirm(reservation_id)

        def dispatch(self, method):
            try:
                parts = tuple(self.path.split("?")[0].strip("/").split("/"))
                methods, args = match(parts)
                if methods is None:
                    raise ApiError(404, "not_found")
                if method not in methods:
                    raise ApiError(405, "method_not_allowed")
                status, body = getattr(self, methods[method])(*args)
            except ApiError as error:
                status = error.status
                body = {"error": {"code": error.code, "message": error.code.replace("_", " ")}}
            self.send(status, body)

        def do_GET(self):
            self.dispatch("GET")

        def do_POST(self):
            self.dispatch("POST")

        def do_PUT(self):
            self.dispatch("PUT")

        def do_PATCH(self):
            self.dispatch("PATCH")

        def do_DELETE(self):
            self.dispatch("DELETE")

    return Handler
