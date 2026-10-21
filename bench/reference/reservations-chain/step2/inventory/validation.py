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


def restock_request(body):
    quantity = body.get("quantity")
    if not is_int(quantity) or quantity < 1:
        raise ApiError(422, "invalid_request")
    return quantity


def reservation_request(body):
    sku, quantity, ttl = body.get("sku"), body.get("quantity"), body.get("ttlSeconds")
    if not isinstance(sku, str) or not is_int(quantity) or quantity < 1:
        raise ApiError(422, "invalid_request")
    if not is_int(ttl) or not 1 <= ttl <= 3600:
        raise ApiError(422, "invalid_request")
    return sku, quantity, ttl


def ttl_value(body):
    ttl = body.get("ttlSeconds")
    if not is_int(ttl) or not 1 <= ttl <= 3600:
        raise ApiError(422, "invalid_request")
    return ttl


def lines_request(body):
    """The reservation as lines, whichever shape the request used."""
    single = "sku" in body or "quantity" in body
    if single == ("lines" in body):
        raise ApiError(422, "invalid_request")
    if single:
        sku, quantity, ttl = reservation_request(body)
        return [(sku, quantity)], ttl, False
    lines = body["lines"]
    if not isinstance(lines, list) or not 1 <= len(lines) <= 20:
        raise ApiError(422, "invalid_request")
    parsed = []
    for line in lines:
        if not isinstance(line, dict):
            raise ApiError(422, "invalid_request")
        sku, quantity = line.get("sku"), line.get("quantity")
        if not isinstance(sku, str) or not is_int(quantity) or quantity < 1:
            raise ApiError(422, "invalid_request")
        parsed.append((sku, quantity))
    if len({sku for sku, _ in parsed}) != len(parsed):
        raise ApiError(422, "invalid_request")
    return parsed, ttl_value(body), True
