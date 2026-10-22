"""Reviewer probes for reservations-bundles: contract rules the hidden checks leave untested.

Usage: probes.py <project_dir> [--only id,id] [--list]

Every probe quotes the clause of task.md (or the README the request points to) that it tests.
None is grounded in one run's implementation. They are scored apart from the hidden checks.
Groups are explained in bench/probekit.py. Cases the request leaves open are not probed; the
ones considered are listed at the end of this file.
"""
import http.client
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
import probekit  # noqa: E402

REG = probekit.Registry()
PORT = 0
JSON_HEADERS = {"Content-Type": "application/json"}

LINE = '`{"lines": [{"sku": "<sku>", "quantity": <integer >= 1>}, ...], "ttlSeconds": <integer 1..3600>}`'
INVALID = "a repeated SKU, or any invalid line is 422 `invalid_request`"
SKU_RULE = 'README: `"sku": "<1-64 letters, digits or ->"`; Errors: `422 invalid_request` (... invalid SKU)'
SHAPE = "A request must use exactly one shape: either `sku` and `quantity`, or `lines`"
ALL_OR_NOTHING = "All or nothing: if any line's SKU is unknown the response is 404 `not_found`; if any line lacks available stock it is 409 `insufficient_stock`; in both cases nothing is held."
SUCCESS = 'Success returns 201 `{"id": "<string>", "lines": [{"sku", "quantity"}, ...], "expiresAt": "<ISO 8601 UTC>"}` with lines in request order. The response for the single-SKU shape is unchanged.'
IDEM = "`Idempotency-Key` works for bundles exactly as for single reservations."
IDEM_README = "README: the same key and body return the original 201 without holding stock again; the same key with a different body -> 422 `idempotency_mismatch`"
ACT = "`DELETE /v1/reservations/<id>` and `POST /v1/reservations/<id>/confirm` act on every line of a bundle at once, with the same status codes as for single reservations."
README_DELETE = "README: DELETE releases an active reservation -> 204. Unknown, released, confirmed or expired -> 404."
README_CONFIRM = "README: confirm -> 200 and permanently reduces the item's quantity. Again -> 409 `already_confirmed`; expired -> 410 `expired`; unknown or released -> 404."
GET = 'New `GET /v1/reservations/<id>` returns 200 `{"id", "status", "lines": [{"sku", "quantity"}, ...], "expiresAt"}` for either shape (a single reservation has one line). `status` is `active`, `confirmed`, `released` or `expired` (an unconfirmed, unreleased reservation past `expiresAt`).'
CONCURRENT = "README: Concurrent reservations never hold more than is available."


def call(method, path, body=None, headers=None, raw=None, timeout=10):
    conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=timeout)
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    try:
        conn.request(method, path, body=data, headers=JSON_HEADERS if headers is None else headers)
        response = conn.getresponse()
        payload = response.read()
        try:
            parsed = json.loads(payload) if payload else None
        except ValueError:
            parsed = payload.decode(errors="replace")
        return response.status, parsed
    except Exception as error:  # noqa: BLE001
        return None, repr(error)
    finally:
        conn.close()


def error(result, expected, code):
    status, body = result
    ok = (status == expected and isinstance(body, dict) and isinstance(body.get("error"), dict)
          and body["error"].get("code") == code)
    return ok, {"status": status, "body": body}


def item(sku, quantity):
    return call("POST", "/v1/items", {"sku": sku, "quantity": quantity})


def stock(sku):
    status, body = call("GET", f"/v1/items/{sku}")
    return (body.get("quantity"), body.get("available")) if status == 200 and isinstance(body, dict) else None


def available(sku):
    pair = stock(sku)
    return pair[1] if pair else None


def reserve(sku, quantity, ttl=60, key=None):
    headers = dict(JSON_HEADERS, **({"Idempotency-Key": key} if key else {}))
    return call("POST", "/v1/reservations", {"sku": sku, "quantity": quantity, "ttlSeconds": ttl}, headers=headers)


def bundle(lines, ttl=60, key=None):
    headers = dict(JSON_HEADERS, **({"Idempotency-Key": key} if key else {}))
    return call("POST", "/v1/reservations", {"lines": lines, "ttlSeconds": ttl}, headers=headers)


def rid(result):
    return result[1].get("id") if isinstance(result[1], dict) else None


def line(sku, quantity=1):
    return {"sku": sku, "quantity": quantity}


def post_reservation(body):
    return call("POST", "/v1/reservations", body)


def expect_422_each(bodies, watch=()):
    """Every body is 422 invalid_request, and the watched SKUs keep their availability."""
    before = {sku: available(sku) for sku in watch}
    failures = []
    for body in bodies:
        ok, detail = error(post_reservation(body), 422, "invalid_request")
        if not ok:
            failures.append({"body": body, **detail})
    after = {sku: available(sku) for sku in watch}
    return not failures and before == after, {"failures": failures[:4], "before": before, "after": after}


def with_line(bad, ttl=60, good=None):
    """A bundle whose first line is valid and whose last line is `bad`."""
    lines = [line(good)] if good else []
    return {"lines": lines + [bad], "ttlSeconds": ttl}


def iso_utc(text):
    if not isinstance(text, str) or not text.endswith("Z"):
        return None
    try:
        return datetime.fromisoformat(text[:-1] + "+00:00")
    except ValueError:
        return None


def threads(count, work):
    results = []
    lock = threading.Lock()

    def run():
        outcome = work()
        with lock:
            results.append(outcome)

    pool = [threading.Thread(target=run) for _ in range(count)]
    for thread in pool:
        thread.start()
    for thread in pool:
        thread.join(30)
    return results


# --- Line validation: "any invalid line is 422". -------------------------------------------------

def p_sku_malformed():
    item("PV-1", 5)
    return expect_422_each([
        with_line(line("bad sku!"), good="PV-1"),
        {"lines": [line("bad sku!")], "ttlSeconds": 60},
    ], watch=("PV-1",))


REG.case("line-sku-malformed", f"{INVALID}; {SKU_RULE}", p_sku_malformed, "refgap", "sku-422")


def p_sku_empty():
    item("PV-2", 5)
    return expect_422_each([{"lines": [line("")], "ttlSeconds": 60}, with_line(line(""), good="PV-2")], watch=("PV-2",))


REG.case("line-sku-empty", f"{INVALID}; {SKU_RULE}", p_sku_empty, "refgap")


def p_sku_too_long():
    item("PV-3", 5)
    return expect_422_each([with_line(line("a" * 65), good="PV-3"), {"lines": [line("a" * 200)], "ttlSeconds": 60}], watch=("PV-3",))


REG.case("line-sku-too-long", f"{INVALID}; {SKU_RULE}", p_sku_too_long, "refgap")


def p_sku_symbols():
    item("PV-4", 5)
    bodies = [with_line(line(sku), good="PV-4") for sku in ("bad>sku", "a_b", "a.b", "a/b", "a b", "ab\t", "é-1")]
    return expect_422_each(bodies, watch=("PV-4",))


REG.case("line-sku-symbols", f"{INVALID}; {SKU_RULE}", p_sku_symbols, "refgap")


def p_sku_newline():
    # Item creation of "PV-5\n" is existing behavior and is not judged here.
    item("PV-5\n", 5)
    item("PV-5", 5)
    return expect_422_each([
        {"lines": [line("PV-5\n")], "ttlSeconds": 60},
        with_line(line("PV-5\n"), good="PV-5"),
        {"lines": [line("PV-5 ")], "ttlSeconds": 60},
    ], watch=("PV-5", "PV-5\n"))


REG.case("line-sku-trailing-whitespace", f"{INVALID}; {SKU_RULE}", p_sku_newline, "refgap", "sku-newline")


def p_unknown_wellformed_stays_404():
    item("PV-6", 5)
    first = bundle([line("PV-6"), line("NOPE-PV-6")])
    only = bundle([line("NOPE-PV-6")])
    ok1, d1 = error(first, 404, "not_found")
    ok2, d2 = error(only, 404, "not_found")
    return ok1 and ok2 and available("PV-6") == 5, {"mixed": d1, "only": d2, "available": available("PV-6")}


REG.case("unknown-wellformed-sku-404", ALL_OR_NOTHING, p_unknown_wellformed_stays_404)


def p_sku_not_string():
    return expect_422_each([{"lines": [{"sku": value, "quantity": 1}], "ttlSeconds": 60}
                            for value in (123, None, True, ["A-1"], {"a": 1}, 1.5)])


REG.case("line-sku-not-string", f"{INVALID}; {LINE}", p_sku_not_string)


def p_sku_missing():
    return expect_422_each([{"lines": [{"quantity": 1}], "ttlSeconds": 60}, {"lines": [{}], "ttlSeconds": 60}])


REG.case("line-sku-missing", f"{INVALID}; {LINE}", p_sku_missing)


def p_quantity_boolean():
    item("PQ-1", 5)
    return expect_422_each([with_line({"sku": "PQ-1", "quantity": value}) for value in (True, False)], watch=("PQ-1",))


REG.case("line-quantity-boolean", f'{INVALID}; `"quantity": <integer >= 1>`; README: booleans as numbers are 422', p_quantity_boolean)


def p_quantity_float_or_text():
    item("PQ-2", 5)
    return expect_422_each([with_line({"sku": "PQ-2", "quantity": value}) for value in (1.5, 0.5, "1", "", None, [1])], watch=("PQ-2",))


REG.case("line-quantity-not-integer", f'{INVALID}; `"quantity": <integer >= 1>`', p_quantity_float_or_text)


def p_quantity_low_or_missing():
    item("PQ-3", 5)
    bodies = [with_line({"sku": "PQ-3", "quantity": value}) for value in (0, -1, -100)]
    bodies.append(with_line({"sku": "PQ-3"}))
    return expect_422_each(bodies, watch=("PQ-3",))


REG.case("line-quantity-below-one-or-missing", f'{INVALID}; `"quantity": <integer >= 1>`', p_quantity_low_or_missing)


def p_line_not_object():
    return expect_422_each([{"lines": [value], "ttlSeconds": 60} for value in ("A-1", None, 1, ["A-1", 1], True)])


REG.case("line-not-object", f"{INVALID}; {LINE}", p_line_not_object)


def p_lines_not_list():
    return expect_422_each([{"lines": value, "ttlSeconds": 60} for value in ("A-1", {}, {"sku": "A-1", "quantity": 1}, 5, None, True)])


REG.case("lines-not-a-list", f"{SHAPE}; {LINE}", p_lines_not_list)


def p_neither_shape():
    return expect_422_each([{"ttlSeconds": 60}, {"ttlSeconds": 60, "lines": None}, {}])


REG.case("neither-shape", f"{SHAPE}; both, neither ... is 422 `invalid_request`", p_neither_shape)


def p_mixed_shape():
    item("PM-1", 5)
    return expect_422_each([
        {"quantity": 1, "lines": [line("PM-1")], "ttlSeconds": 60},
        {"sku": "PM-1", "lines": [line("PM-1")], "ttlSeconds": 60},
        {"sku": "PM-1", "quantity": 1, "lines": [], "ttlSeconds": 60},
    ], watch=("PM-1",))


REG.case("mixed-shapes", f"{SHAPE}; both ... is 422 `invalid_request`", p_mixed_shape)


def p_ttl_invalid():
    item("PT-1", 5)
    bodies = [{"lines": [line("PT-1")], "ttlSeconds": value} for value in (0, -1, 3601, 99999, "60", 1.5, True, None, [60])]
    return expect_422_each(bodies, watch=("PT-1",))


REG.case("bundle-ttl-invalid", f"{LINE}: `ttlSeconds` is an <integer 1..3600>", p_ttl_invalid)


def p_ttl_bounds():
    item("PT-2", 5)
    item("PT-3", 5)
    low, high = bundle([line("PT-2")], ttl=1), bundle([line("PT-3")], ttl=3600)
    ok = low[0] == 201 and high[0] == 201
    expires = iso_utc(high[1].get("expiresAt")) if isinstance(high[1], dict) else None
    delta = (expires - datetime.now(timezone.utc)).total_seconds() if expires else None
    return ok and delta is not None and 3500 <= delta <= 3700, {"low": low, "high": high, "delta": delta}


REG.case("bundle-ttl-bounds", f"{LINE}: `ttlSeconds` is an <integer 1..3600>", p_ttl_bounds)


def p_twenty_lines():
    skus = [f"P20-{i}" for i in range(20)]
    for sku in skus:
        item(sku, 1)
    status, body = bundle([line(sku) for sku in reversed(skus)])
    lines = body.get("lines") if isinstance(body, dict) else None
    ok = status == 201 and lines == [line(sku) for sku in reversed(skus)] and all(available(s) == 0 for s in skus)
    return ok, {"status": status, "count": len(lines) if isinstance(lines, list) else None}


REG.case("exactly-twenty-lines", "1 to 20 lines, each SKU at most once", p_twenty_lines)


def p_repeat_not_adjacent():
    item("PR-1", 9)
    item("PR-2", 9)
    return expect_422_each([
        {"lines": [line("PR-1"), line("PR-2"), line("PR-1", 2)], "ttlSeconds": 60},
        {"lines": [line("PR-2"), line("PR-1"), line("PR-1")], "ttlSeconds": 60},
    ], watch=("PR-1", "PR-2"))


REG.case("repeated-sku-not-adjacent", "1 to 20 lines, each SKU at most once; a repeated SKU ... is 422 `invalid_request`", p_repeat_not_adjacent)


def p_validation_before_lookup():
    item("PO-1", 1)
    cases = [
        {"lines": [line("NOPE-PO-1"), line("PO-1", 0)], "ttlSeconds": 60},
        {"lines": [line("PO-1", 50), {"sku": "PO-1b", "quantity": True}], "ttlSeconds": 60},
        {"lines": [line("PO-1", 50), line("PO-1", 1)], "ttlSeconds": 60},
    ]
    return expect_422_each(cases, watch=("PO-1",))


REG.case("invalid-line-beats-unknown-and-stock", f"{INVALID} (a request with an invalid line is invalid whatever the stock or SKUs)", p_validation_before_lookup)


# --- Holding: all or nothing, and the response. ------------------------------------------------

def p_exact_stock():
    item("PH-1", 3)
    item("PH-2", 2)
    status, body = bundle([line("PH-1", 3), line("PH-2", 2)])
    return status == 201 and available("PH-1") == 0 and available("PH-2") == 0, {"status": status, "body": body}


REG.case("bundle-takes-exact-stock", "if any line lacks available stock it is 409 (a line that equals the available stock does not lack it)", p_exact_stock)


def p_last_line_short():
    item("PH-3", 5)
    item("PH-4", 5)
    item("PH-5", 1)
    ok, detail = error(bundle([line("PH-3", 2), line("PH-4", 2), line("PH-5", 2)]), 409, "insufficient_stock")
    held = (available("PH-3"), available("PH-4"), available("PH-5"))
    return ok and held == (5, 5, 1), {**detail, "available": held}


REG.case("last-line-short-holds-nothing", ALL_OR_NOTHING, p_last_line_short)


def p_unknown_last_line():
    item("PH-6", 5)
    item("PH-7", 5)
    ok, detail = error(bundle([line("PH-6"), line("PH-7"), line("NOPE-PH-6")]), 404, "not_found")
    return ok and available("PH-6") == 5 and available("PH-7") == 5, detail


REG.case("unknown-last-line-holds-nothing", ALL_OR_NOTHING, p_unknown_last_line)


def p_bundle_response_keys():
    item("PH-8", 5)
    item("PH-9", 5)
    status, body = bundle([line("PH-9", 2), line("PH-8", 1)], ttl=120)
    expires = iso_utc(body.get("expiresAt")) if isinstance(body, dict) else None
    delta = (expires - datetime.now(timezone.utc)).total_seconds() if expires else None
    ok = (status == 201 and isinstance(body, dict) and set(body) == {"id", "lines", "expiresAt"}
          and isinstance(body["id"], str) and body["id"] != "" and delta is not None and 100 <= delta <= 140)
    return ok, {"status": status, "body": body, "delta": delta}


REG.case("bundle-response-keys", SUCCESS, p_bundle_response_keys)


def p_single_response_keys():
    item("PH-10", 5)
    status, body = reserve("PH-10", 2)
    ok = status == 201 and isinstance(body, dict) and set(body) == {"id", "sku", "quantity", "expiresAt"}
    return ok, {"status": status, "body": body}


REG.case("single-response-unchanged", SUCCESS, p_single_response_keys)


def p_bundles_accumulate():
    item("PH-11", 5)
    first = bundle([line("PH-11", 3)])
    second = bundle([line("PH-11", 3)])
    third = bundle([line("PH-11", 2)])
    ok = first[0] == 201 and error(second, 409, "insufficient_stock")[0] and third[0] == 201 and available("PH-11") == 0
    return ok, {"first": first[0], "second": second[0], "third": third[0]}


REG.case("bundles-and-singles-share-stock", f"{ALL_OR_NOTHING} {CONCURRENT}", p_bundles_accumulate)


# --- Idempotency: "exactly as for single reservations". ---------------------------------------

def p_idem_replay_after_stock_gone():
    item("PI-1", 2)
    item("PI-2", 2)
    lines = [line("PI-1", 2), line("PI-2", 2)]
    first = bundle(lines, key="pi-key-1")
    second = bundle(lines, key="pi-key-1")
    ok = first[0] == 201 and second[0] == 201 and first[1] == second[1] and available("PI-1") == 0
    return ok, {"first": first, "second": second}


REG.case("idem-bundle-replay-returns-original", f"{IDEM} {IDEM_README}", p_idem_replay_after_stock_gone)


def p_idem_other_ttl():
    item("PI-3", 5)
    bundle([line("PI-3")], ttl=30, key="pi-key-3")
    ok, detail = error(bundle([line("PI-3")], ttl=40, key="pi-key-3"), 422, "idempotency_mismatch")
    return ok and available("PI-3") == 4, detail


REG.case("idem-bundle-different-ttl", f"{IDEM} {IDEM_README}", p_idem_other_ttl)


def p_idem_other_lines():
    item("PI-4", 9)
    item("PI-5", 9)
    item("PI-6", 9)
    bundle([line("PI-4"), line("PI-5")], key="pi-key-4")
    results = [
        bundle([line("PI-4"), line("PI-6")], key="pi-key-4"),
        bundle([line("PI-4")], key="pi-key-4"),
        bundle([line("PI-4"), line("PI-5", 2)], key="pi-key-4"),
    ]
    oks = [error(result, 422, "idempotency_mismatch")[0] for result in results]
    return all(oks) and available("PI-4") == 8 and available("PI-5") == 8 and available("PI-6") == 9, results


REG.case("idem-bundle-different-lines", f"{IDEM} {IDEM_README}", p_idem_other_lines)


def p_idem_shape_switch():
    item("PI-7", 9)
    reserve("PI-7", 1, key="pi-key-7")
    to_bundle = bundle([line("PI-7")], key="pi-key-7")
    bundle([line("PI-7", 2)], key="pi-key-8")
    to_single = reserve("PI-7", 2, key="pi-key-8")
    oks = [error(to_bundle, 422, "idempotency_mismatch")[0], error(to_single, 422, "idempotency_mismatch")[0]]
    return all(oks) and available("PI-7") == 6, {"toBundle": to_bundle, "toSingle": to_single}


REG.case("idem-key-between-shapes", f"{IDEM} {IDEM_README} (a bundle body is a different body from a single body)", p_idem_shape_switch)


def p_idem_concurrent():
    item("PI-9", 10)
    item("PI-10", 10)
    results = threads(10, lambda: bundle([line("PI-9", 3), line("PI-10", 2)], key="pi-key-9"))
    ids = {rid(r) for r in results if r[0] == 201}
    ok = len(results) == 10 and all(r[0] == 201 for r in results) and len(ids) == 1 and available("PI-9") == 7 and available("PI-10") == 8
    return ok, {"statuses": [r[0] for r in results], "ids": len(ids), "available": (available("PI-9"), available("PI-10"))}


REG.case("idem-bundle-concurrent-same-key", f"{IDEM} {IDEM_README}", p_idem_concurrent)


# --- Release and confirm: "act on every line of a bundle at once". -----------------------------

def two_line_bundle(tag, ttl=60, quantities=(2, 3), stocks=(5, 5)):
    first, second = f"{tag}-a", f"{tag}-b"
    item(first, stocks[0])
    item(second, stocks[1])
    made = bundle([line(first, quantities[0]), line(second, quantities[1])], ttl=ttl)
    return first, second, rid(made), made


def p_delete_twice():
    a, b, reservation, _ = two_line_bundle("PL-1")
    first = call("DELETE", f"/v1/reservations/{reservation}")
    second = call("DELETE", f"/v1/reservations/{reservation}")
    ok = first[0] == 204 and error(second, 404, "not_found")[0] and available(a) == 5 and available(b) == 5
    return ok, {"first": first, "second": second, "available": (available(a), available(b))}


REG.case("bundle-delete-twice-restores-once", f"{ACT} {README_DELETE}", p_delete_twice)


def p_delete_confirmed():
    a, b, reservation, _ = two_line_bundle("PL-2")
    call("POST", f"/v1/reservations/{reservation}/confirm", {})
    result = call("DELETE", f"/v1/reservations/{reservation}")
    ok = error(result, 404, "not_found")[0] and stock(a) == (3, 3) and stock(b) == (2, 2)
    return ok, {"delete": result, "stock": (stock(a), stock(b))}


REG.case("bundle-delete-confirmed-404", f"{ACT} {README_DELETE}", p_delete_confirmed)


def p_confirm_then_new_hold():
    a, b, reservation, _ = two_line_bundle("PL-3", quantities=(3, 1), stocks=(5, 2))
    call("POST", f"/v1/reservations/{reservation}/confirm", {})
    too_much = reserve(a, 3)
    fits = reserve(a, 2)
    other = bundle([line(b, 1)])
    ok = (error(too_much, 409, "insufficient_stock")[0] and fits[0] == 201 and other[0] == 201
          and stock(a) == (2, 0) and stock(b) == (1, 0))
    return ok, {"tooMuch": too_much, "fits": fits[0], "other": other[0], "stock": (stock(a), stock(b))}


REG.case("bundle-confirm-reduces-every-line", f"{ACT} Confirming a bundle reduces every line's item quantity. {README_CONFIRM}", p_confirm_then_new_hold)


def p_confirm_released():
    a, b, reservation, _ = two_line_bundle("PL-4")
    call("DELETE", f"/v1/reservations/{reservation}")
    result = call("POST", f"/v1/reservations/{reservation}/confirm", {})
    return error(result, 404, "not_found")[0] and stock(a) == (5, 5) and stock(b) == (5, 5), result


REG.case("bundle-confirm-released-404", f"{ACT} {README_CONFIRM}", p_confirm_released)


def expired_bundle(tag):
    a, b, reservation, made = two_line_bundle(tag, ttl=1)
    return a, b, reservation


def p_expired_bundle_actions():
    a, b, reservation = expired_bundle("PX-1")
    c, d, second = expired_bundle("PX-2")
    held = (available(a), available(b))
    time.sleep(1.6)
    confirm = call("POST", f"/v1/reservations/{reservation}/confirm", {})
    delete = call("DELETE", f"/v1/reservations/{second}")
    ok = (held == (3, 2) and error(confirm, 410, "expired")[0] and error(delete, 404, "not_found")[0]
          and stock(a) == (5, 5) and stock(b) == (5, 5) and stock(c) == (5, 5) and stock(d) == (5, 5))
    return ok, {"held": held, "confirm": confirm, "delete": delete, "stock": [stock(s) for s in (a, b, c, d)]}


REG.case("bundle-expiry-frees-every-line-and-blocks-actions", f"{ACT} {README_CONFIRM} README: `available` is `quantity` minus active (unexpired, ...) reservations", p_expired_bundle_actions)


def p_expiry_reuse():
    a, b, _ = expired_bundle("PX-3")
    time.sleep(1.5)
    again = bundle([line(a, 5), line(b, 5)])
    return again[0] == 201 and available(a) == 0 and available(b) == 0, again


REG.case("bundle-expiry-capacity-reusable", "README: `available` is `quantity` minus active (unexpired, unconfirmed, unreleased) reservations", p_expiry_reuse)


def p_confirmed_after_expiry():
    a, b, reservation = expired_bundle("PX-4")
    call("POST", f"/v1/reservations/{reservation}/confirm", {})
    c, d, released = expired_bundle("PX-5")
    call("DELETE", f"/v1/reservations/{released}")
    time.sleep(1.6)
    again = call("POST", f"/v1/reservations/{reservation}/confirm", {})
    after_release = call("POST", f"/v1/reservations/{released}/confirm", {})
    view_confirmed = call("GET", f"/v1/reservations/{reservation}")[1]
    view_released = call("GET", f"/v1/reservations/{released}")[1]
    status = lambda view: view.get("status") if isinstance(view, dict) else None  # noqa: E731
    ok = (error(again, 409, "already_confirmed")[0] and error(after_release, 404, "not_found")[0]
          and status(view_confirmed) == "confirmed" and status(view_released) == "released"
          and stock(a) == (3, 3) and stock(c) == (5, 5))
    return ok, {"again": again, "afterRelease": after_release, "views": [view_confirmed, view_released]}


REG.case("bundle-confirmed-or-released-stays-so-past-expiry", f"{GET} {README_CONFIRM}", p_confirmed_after_expiry)


# --- GET /v1/reservations/<id>. ------------------------------------------------------------

def p_get_keys_and_expires():
    item("PG-1", 9)
    item("PG-2", 9)
    made = bundle([line("PG-2", 4), line("PG-1", 1)], ttl=90)
    single = reserve("PG-1", 2, ttl=90)
    views = [call("GET", f"/v1/reservations/{rid(r)}") for r in (made, single)]
    ok = all(v[0] == 200 and isinstance(v[1], dict) and set(v[1]) == {"id", "status", "lines", "expiresAt"} for v in views)
    ok = ok and views[0][1]["expiresAt"] == made[1]["expiresAt"] and views[1][1]["expiresAt"] == single[1]["expiresAt"]
    ok = ok and views[0][1]["status"] == "active" and views[1][1]["lines"] == [line("PG-1", 2)]
    ok = ok and sorted(views[0][1]["lines"], key=lambda x: x["sku"]) == [line("PG-1", 1), line("PG-2", 4)]
    return ok, views


REG.case("get-reservation-keys-and-expires-at", GET, p_get_keys_and_expires)


def p_get_after_confirm():
    a, b, reservation, _ = two_line_bundle("PG-3")
    call("POST", f"/v1/reservations/{reservation}/confirm", {})
    view = call("GET", f"/v1/reservations/{reservation}")
    body = view[1] if isinstance(view[1], dict) else {}
    ok = view[0] == 200 and body.get("status") == "confirmed" and sorted(body.get("lines", []), key=lambda x: x["sku"]) == [line(a, 2), line(b, 3)]
    return ok, view


REG.case("get-bundle-after-confirm", GET, p_get_after_confirm)


def p_get_after_release():
    a, b, reservation, _ = two_line_bundle("PG-4")
    call("DELETE", f"/v1/reservations/{reservation}")
    view = call("GET", f"/v1/reservations/{reservation}")
    body = view[1] if isinstance(view[1], dict) else {}
    return view[0] == 200 and body.get("status") == "released", view


REG.case("get-bundle-after-release", GET, p_get_after_release)


def p_reservation_id_methods():
    item("PG-5", 5)
    reservation = rid(reserve("PG-5", 1))
    failures = []
    for method in ("POST", "PUT", "PATCH"):
        for target in (reservation, "no-such-id"):
            ok, detail = error(call(method, f"/v1/reservations/{target}", {}), 405, "method_not_allowed")
            if not ok:
                failures.append({"method": method, "id": target, **detail})
    return not failures and available("PG-5") == 4, failures[:3]


REG.case("reservation-id-known-for-get-and-delete-only", "`/v1/reservations/<id>` is now a known path for `GET` and `DELETE` only.", p_reservation_id_methods)


def p_get_extra_segment():
    item("PG-6", 5)
    reservation = rid(reserve("PG-6", 1))
    return error(call("GET", f"/v1/reservations/{reservation}/extra"), 404, "not_found")


REG.case("get-reservation-extra-segment-404", "README: 404 unknown path; 405 known path with the wrong method", p_get_extra_segment)


# --- Concurrency. ------------------------------------------------------------------------

def p_opposite_orders():
    item("PC-1", 10)
    item("PC-2", 10)
    start = time.time()
    orders = iter([("PC-1", "PC-2") if index % 2 else ("PC-2", "PC-1") for index in range(20)])
    lock = threading.Lock()

    def one():
        with lock:
            order = next(orders)
        return bundle([line(sku) for sku in order])

    results = threads(20, one)
    codes = [r[0] for r in results]
    ok = len(codes) == 20 and codes.count(201) == 10 and codes.count(409) == 10 and available("PC-1") == 0 and available("PC-2") == 0
    return ok and time.time() - start < 60, {"codes": codes}


REG.case("concurrent-bundles-in-opposite-line-orders", f"{CONCURRENT} {ALL_OR_NOTHING}", p_opposite_orders)


def p_mixed_single_and_bundle():
    item("PC-3", 10)
    toggle = iter(range(40))
    lock = threading.Lock()

    def one():
        with lock:
            index = next(toggle)
        return reserve("PC-3", 1) if index % 2 else bundle([line("PC-3")])

    results = threads(30, one)
    codes = [r[0] for r in results]
    return codes.count(201) == 10 and codes.count(409) == 20 and available("PC-3") == 0, {"codes": codes}


REG.case("concurrent-singles-and-bundles-never-oversell", CONCURRENT, p_mixed_single_and_bundle)


def p_double_confirm():
    a, b, reservation, _ = two_line_bundle("PC-4", quantities=(1, 2))
    results = threads(10, lambda: call("POST", f"/v1/reservations/{reservation}/confirm", {}))
    codes = sorted(r[0] for r in results)
    ok = codes == [200] + [409] * 9 and stock(a) == (4, 4) and stock(b) == (3, 3)
    return ok, {"codes": codes, "stock": (stock(a), stock(b))}


REG.case("concurrent-confirms-reduce-once", f"{ACT} {README_CONFIRM}", p_double_confirm)


def p_confirm_vs_delete():
    problems = []
    for round_ in range(6):
        a, b, reservation, _ = two_line_bundle(f"PC-5{round_}", quantities=(1, 2))
        outcome = []
        lock = threading.Lock()

        def confirm():
            result = call("POST", f"/v1/reservations/{reservation}/confirm", {})
            with lock:
                outcome.append(("confirm", result[0]))

        def delete():
            result = call("DELETE", f"/v1/reservations/{reservation}")
            with lock:
                outcome.append(("delete", result[0]))

        pool = [threading.Thread(target=confirm), threading.Thread(target=delete)]
        for t in pool:
            t.start()
        for t in pool:
            t.join(30)
        results = dict(outcome)
        confirmed = results.get("confirm") == 200 and results.get("delete") == 404 and stock(a) == (4, 4) and stock(b) == (3, 3)
        released = results.get("delete") == 204 and results.get("confirm") == 404 and stock(a) == (5, 5) and stock(b) == (5, 5)
        if not (confirmed or released):
            problems.append({"round": round_, "results": results, "stock": (stock(a), stock(b))})
    return not problems, problems[:2]


REG.case("concurrent-confirm-and-delete-one-wins", f"{ACT} {README_DELETE} {README_CONFIRM}", p_confirm_vs_delete)


# --- Running. -------------------------------------------------------------------------------

def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main():
    global PORT
    args = sys.argv[1:]
    if "--list" in args:
        print("\n".join(probekit.listing(REG.probes)))
        return
    only = set(args[args.index("--only") + 1].split(",")) if "--only" in args else None
    root = Path(args[0]).resolve()
    if not (root / "start.sh").exists():
        probekit.emit([{"name": "start.sh exists", "passed": False, "detail": "missing", "group": "request",
                        "finding": None, "clause": ""}])
        return
    PORT = free_port()
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    with tempfile.TemporaryFile() as log:
        proc = subprocess.Popen(["bash", "start.sh", str(PORT)], cwd=root, env=env, stdout=log, stderr=log,
                                start_new_session=True)
        try:
            deadline = time.time() + 15
            while time.time() < deadline:
                try:
                    with socket.create_connection(("127.0.0.1", PORT), timeout=0.2):
                        break
                except OSError:
                    time.sleep(0.1)
            probekit.emit(probekit.execute(REG.probes, only))
        finally:
            os.killpg(proc.pid, 15)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, 9)


# Considered and left out, because task.md and the README leave the answer open:
# - a malformed SKU in a single-SKU request (the existing service answers 404; the README
#   says "invalid SKU" is 422): changing it may break "without changing any existing behavior";
# - the order of `lines` in `GET /v1/reservations/<id>` (only the POST response says "in request order");
# - a line that is unknown plus a line that lacks stock: 404 or 409;
# - the same SKU in two letter cases in one bundle (case rules for SKUs are not stated);
# - extra fields on a line or at the top level of a bundle request;
# - `quantity` 1.0 (a JSON number with no fraction) and very large integers;
# - the same idempotency key with the same lines in another order (same body or not);
# - whether a failed (404, 409, 422) request consumes its idempotency key.
if __name__ == "__main__":
    main()
