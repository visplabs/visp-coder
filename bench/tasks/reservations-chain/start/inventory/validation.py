import re

from .errors import ApiError

SKU = re.compile(r"^[A-Za-z0-9-]{1,64}$")


def is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def item_request(body):
    sku, quantity = body.get("sku"), body.get("quantity")
    if not isinstance(sku, str) or not SKU.match(sku) or not is_int(quantity) or quantity < 0:
        raise ApiError(422, "invalid_request")
    return sku, quantity


def reservation_request(body):
    sku, quantity, ttl = body.get("sku"), body.get("quantity"), body.get("ttlSeconds")
    if not isinstance(sku, str) or not is_int(quantity) or quantity < 1:
        raise ApiError(422, "invalid_request")
    if not is_int(ttl) or not 1 <= ttl <= 3600:
        raise ApiError(422, "invalid_request")
    return sku, quantity, ttl
