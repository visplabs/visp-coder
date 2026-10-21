import re

from .errors import ApiError

SKU = re.compile(r"^[A-Za-z0-9-]{1,64}$")
MAX_LINES = 20


def is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def rejected(field=None):
    """The 422 for invalid input, naming the field unless the body as a whole is wrong."""
    return ApiError(422, "invalid_request", field)


def count(value, field, minimum):
    if not is_int(value) or value < minimum:
        raise rejected(field)
    return value


def item_request(body):
    sku = body.get("sku")
    if not isinstance(sku, str) or not SKU.match(sku):
        raise rejected("sku")
    return sku, count(body.get("quantity"), "quantity", 0)


def restock_request(body):
    return count(body.get("quantity"), "quantity", 1)


def ttl_value(body):
    ttl = body.get("ttlSeconds")
    if not is_int(ttl) or not 1 <= ttl <= 3600:
        raise rejected("ttlSeconds")
    return ttl


def line_request(line, prefix=""):
    sku = line.get("sku")
    if not isinstance(sku, str):
        raise rejected(f"{prefix}sku")
    return sku, count(line.get("quantity"), f"{prefix}quantity", 1)


def lines_request(body):
    """The reservation as lines, whichever shape the request used."""
    single = "sku" in body or "quantity" in body
    if single == ("lines" in body):
        raise rejected()
    if single:
        line = line_request(body)
        return [line], ttl_value(body), False
    lines = body["lines"]
    if not isinstance(lines, list) or not 1 <= len(lines) <= MAX_LINES:
        raise rejected("lines")
    parsed, seen = [], set()
    for index, line in enumerate(lines):
        if not isinstance(line, dict):
            raise rejected(f"lines[{index}]")
        sku, quantity = line_request(line, f"lines[{index}].")
        if sku in seen:
            raise rejected(f"lines[{index}].sku")
        seen.add(sku)
        parsed.append((sku, quantity))
    return parsed, ttl_value(body), True
