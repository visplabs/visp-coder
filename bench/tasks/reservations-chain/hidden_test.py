"""Reservations chain oracle: hidden_test.py <project_dir> [--step 0..5].

Runs the checks of every step up to --step (default 5): step 0 is the starting contract in
start/README.md, step k the request in steps/step<k>.md. Later steps only add to the contract, so
every check stays valid after every later step: response bodies are compared on the fields a
check's own step defines, and SKUs differ in more than case across all checks. A check that
passed after its own step and fails after a later one is a regression. Each result carries its
step.

Steps 0-4 share one server started without INVENTORY_DATA_FILE. Step 5 checks start their own
servers with a fresh data file and restart them (SIGTERM, as a deploy would) to check what
survives.
"""
import argparse
import http.client
import json
import os
import signal
import socket
import subprocess
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = None
PORT = None


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def call(method, path, body=None, headers=None, raw=None, timeout=5):
    conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=timeout)
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    hdrs = {"Content-Type": "application/json"} if headers is None else headers
    try:
        conn.request(method, path, body=data, headers=hdrs)
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


def error(status, body, expected, code):
    """The starting contract's error: the status, `code` and a non-empty `message`."""
    ok = (
        status == expected
        and isinstance(body, dict)
        and isinstance(body.get("error"), dict)
        and body["error"].get("code") == code
        and isinstance(body["error"].get("message"), str)
        and body["error"]["message"].strip() != ""
    )
    return ok, {"status": status, "body": body}


def has(body, expected):
    """Every expected field has its value; fields a later step adds are allowed."""
    return isinstance(body, dict) and all(body.get(key) == value for key, value in expected.items())


def item(sku, quantity):
    return call("POST", "/v1/items", {"sku": sku, "quantity": quantity})


def view(sku):
    status, body = call("GET", f"/v1/items/{sku}")
    return body if status == 200 and isinstance(body, dict) else None


def available(sku):
    return (view(sku) or {}).get("available")


def reserve(sku, quantity, ttl=60, key=None):
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Idempotency-Key"] = key
    return call("POST", "/v1/reservations", {"sku": sku, "quantity": quantity, "ttlSeconds": ttl}, headers=headers)


def bundle(lines, ttl=60, key=None):
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Idempotency-Key"] = key
    return call("POST", "/v1/reservations", {"lines": lines, "ttlSeconds": ttl}, headers=headers)


def restock(sku, quantity):
    return call("POST", f"/v1/items/{sku}/restock", {"quantity": quantity})


def rid(result):
    return result[1].get("id") if isinstance(result[1], dict) else None


def confirm(reservation):
    return call("POST", f"/v1/reservations/{reservation}/confirm", {})


def invalid(path, body, raw=None):
    return lambda: error(*call("POST", path, body, raw=raw), 422, "invalid_request")


def parallel(count, action):
    results, lock = [], threading.Lock()

    def worker(index):
        outcome = action(index)
        with lock:
            results.append(outcome)

    threads = [threading.Thread(target=worker, args=(index,)) for index in range(count)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    return results


# Step 0: the starting contract.
def t_create():
    status, body = item("Base-Lamp-1", 10)
    return status == 201 and has(body, {"sku": "Base-Lamp-1", "quantity": 10, "available": 10}), {"status": status, "body": body}


def t_get():
    status, body = call("GET", "/v1/items/Base-Lamp-1")
    return status == 200 and has(body, {"sku": "Base-Lamp-1", "quantity": 10, "available": 10}), {"status": status, "body": body}


def t_reserve_shape():
    item("Base-Desk-1", 5)
    status, body = reserve("Base-Desk-1", 2, 60)
    ok = status == 201 and has(body, {"sku": "Base-Desk-1", "quantity": 2}) and isinstance(body.get("id"), str)
    if ok:
        expires = datetime.fromisoformat(body["expiresAt"].replace("Z", "+00:00"))
        ok = 50 <= (expires - datetime.now(timezone.utc)).total_seconds() <= 70
    return ok and available("Base-Desk-1") == 3, {"status": status, "body": body, "available": available("Base-Desk-1")}


def t_insufficient():
    item("Base-Chair-1", 2)
    ok, detail = error(*reserve("Base-Chair-1", 3), 409, "insufficient_stock")
    return ok and available("Base-Chair-1") == 2, detail


def t_release():
    item("Base-Rug-1", 4)
    reservation = rid(reserve("Base-Rug-1", 3))
    status, _ = call("DELETE", f"/v1/reservations/{reservation}")
    again = call("DELETE", f"/v1/reservations/{reservation}")
    ok = status == 204 and available("Base-Rug-1") == 4 and error(*again, 404, "not_found")[0]
    return ok, {"status": status, "again": again, "available": available("Base-Rug-1")}


def t_confirm():
    item("Base-Mug-1", 5)
    reservation = rid(reserve("Base-Mug-1", 2))
    status, body = confirm(reservation)
    ok = status == 200 and has(body, {"id": reservation, "status": "confirmed"})
    return ok and has(view("Base-Mug-1"), {"quantity": 3, "available": 3}), {"status": status, "body": body, "item": view("Base-Mug-1")}


def t_confirm_twice():
    item("Base-Mug-2", 5)
    reservation = rid(reserve("Base-Mug-2", 1))
    confirm(reservation)
    return error(*confirm(reservation), 409, "already_confirmed")


def t_delete_confirmed():
    item("Base-Mug-3", 5)
    reservation = rid(reserve("Base-Mug-3", 1))
    confirm(reservation)
    ok, detail = error(*call("DELETE", f"/v1/reservations/{reservation}"), 404, "not_found")
    return ok and available("Base-Mug-3") == 4, detail


def t_expiry():
    item("Base-Pen-1", 3)
    reservation = rid(reserve("Base-Pen-1", 2, 1))
    before = available("Base-Pen-1")
    time.sleep(1.6)
    after = available("Base-Pen-1")
    expired = confirm(reservation)
    return before == 1 and after == 3 and error(*expired, 410, "expired")[0], {"before": before, "after": after, "confirm": expired}


def t_expired_release():
    item("Base-Pen-2", 3)
    reservation = rid(reserve("Base-Pen-2", 1, 1))
    time.sleep(1.4)
    return error(*call("DELETE", f"/v1/reservations/{reservation}"), 404, "not_found")


def t_expired_capacity():
    item("Base-Pen-3", 2)
    reserve("Base-Pen-3", 2, 1)
    time.sleep(1.4)
    status, body = reserve("Base-Pen-3", 2, 60)
    return status == 201, {"status": status, "body": body}


def t_idempotent():
    item("Base-Key-1", 5)
    first = reserve("Base-Key-1", 2, 60, key="base-k-1")
    second = reserve("Base-Key-1", 2, 60, key="base-k-1")
    ok = first[0] == 201 and second[0] == 201 and isinstance(first[1], dict) and first[1] == second[1]
    return ok and available("Base-Key-1") == 3, {"first": first, "second": second, "available": available("Base-Key-1")}


def t_idempotent_mismatch():
    item("Base-Key-2", 5)
    reserve("Base-Key-2", 1, 60, key="base-k-2")
    ok, detail = error(*reserve("Base-Key-2", 2, 60, key="base-k-2"), 422, "idempotency_mismatch")
    return ok and available("Base-Key-2") == 4, detail


def t_idempotency_ttl():
    item("Base-Key-3", 5)
    reserve("Base-Key-3", 1, 30, key="base-k-3")
    ok, detail = error(*reserve("Base-Key-3", 1, 40, key="base-k-3"), 422, "idempotency_mismatch")
    return ok and available("Base-Key-3") == 4, detail


def t_distinct_keys():
    item("Base-Key-4", 5)
    a, b = reserve("Base-Key-4", 1, 60, key="base-k-4a"), reserve("Base-Key-4", 1, 60, key="base-k-4b")
    return a[0] == 201 and b[0] == 201 and rid(a) != rid(b) and available("Base-Key-4") == 3, {"a": a, "b": b}


def t_concurrent():
    item("Base-Box-1", 10)
    statuses = [status for status, _ in parallel(50, lambda _: reserve("Base-Box-1", 1, 60))]
    ok = statuses.count(201) == 10 and statuses.count(409) == 40 and available("Base-Box-1") == 0
    return ok, {"201": statuses.count(201), "409": statuses.count(409), "available": available("Base-Box-1")}


def t_concurrent_idempotent():
    item("Base-Box-2", 10)
    results = parallel(10, lambda _: reserve("Base-Box-2", 3, 60, key="base-same-key"))
    ids = {rid(r) for r in results if r[0] == 201}
    ok = all(r[0] == 201 for r in results) and len(ids) == 1 and available("Base-Box-2") == 7
    return ok, {"statuses": [r[0] for r in results], "ids": len(ids), "available": available("Base-Box-2")}


def t_reconfirm_after_expiry():
    item("Base-Pen-4", 3)
    reservation = rid(reserve("Base-Pen-4", 1, 1))
    confirm(reservation)
    time.sleep(1.5)
    return error(*confirm(reservation), 409, "already_confirmed")


def t_released_after_expiry():
    item("Base-Pen-5", 3)
    reservation = rid(reserve("Base-Pen-5", 1, 1))
    call("DELETE", f"/v1/reservations/{reservation}")
    time.sleep(1.5)
    return error(*confirm(reservation), 404, "not_found")


def t_content_type_params():
    status, body = call("POST", "/v1/items", {"sku": "Base-Ct-1", "quantity": 1},
                        headers={"Content-Type": "Application/JSON; charset=utf-8"})
    return status == 201, {"status": status, "body": body}


# Step 1: restocking and the stock list.
def t_restock():
    item("Rs-Shelf-1", 3)
    status, body = restock("Rs-Shelf-1", 4)
    ok = status == 200 and has(body, {"sku": "Rs-Shelf-1", "quantity": 7, "available": 7})
    return ok and has(view("Rs-Shelf-1"), {"quantity": 7, "available": 7}), {"status": status, "body": body}


def t_restock_held():
    item("Rs-Shelf-2", 2)
    reserve("Rs-Shelf-2", 2)
    status, body = restock("Rs-Shelf-2", 3)
    return status == 200 and has(body, {"quantity": 5, "available": 3}), {"status": status, "body": body}


def t_restock_then_confirm():
    item("Rs-Shelf-3", 1)
    restock("Rs-Shelf-3", 2)
    reservation = rid(reserve("Rs-Shelf-3", 3))
    status, _ = confirm(reservation)
    return status == 200 and has(view("Rs-Shelf-3"), {"quantity": 0, "available": 0}), {"status": status, "item": view("Rs-Shelf-3")}


def t_restock_quantities():
    item("Rs-Shelf-4", 1)
    outcomes = [restock("Rs-Shelf-4", value) for value in (0, -2, True, 1.5, "2")]
    outcomes.append(call("POST", "/v1/items/Rs-Shelf-4/restock", {}))
    ok = all(error(*outcome, 422, "invalid_request")[0] for outcome in outcomes)
    return ok and has(view("Rs-Shelf-4"), {"quantity": 1}), {"outcomes": outcomes}


def t_restock_bodies():
    item("Rs-Shelf-5", 1)
    wrong_type = call("POST", "/v1/items/Rs-Shelf-5/restock", {"quantity": 1}, headers={"Content-Type": "text/plain"})
    malformed = call("POST", "/v1/items/Rs-Shelf-5/restock", raw=b"{nope")
    ok = error(*wrong_type, 415, "unsupported_media_type")[0] and error(*malformed, 400, "invalid_json")[0]
    return ok and has(view("Rs-Shelf-5"), {"quantity": 1}), {"wrongType": wrong_type, "malformed": malformed}


def t_restock_methods():
    item("Rs-Shelf-6", 1)
    outcomes = [call("GET", "/v1/items/Rs-Shelf-6/restock"), call("DELETE", "/v1/items")]
    return all(error(*outcome, 405, "method_not_allowed")[0] for outcome in outcomes), {"outcomes": outcomes}


def t_list():
    for sku, quantity in (("Rs-List-c", 3), ("Rs-List-a", 1), ("Rs-List-b", 2)):
        item(sku, quantity)
    reserve("Rs-List-b", 1)
    status, body = call("GET", "/v1/items")
    listed = [entry for entry in (body or {}).get("items", []) if isinstance(entry, dict)
              and str(entry.get("sku", "")).startswith("Rs-List-")] if isinstance(body, dict) else []
    expected = [{"sku": "Rs-List-a", "quantity": 1, "available": 1}, {"sku": "Rs-List-b", "quantity": 2, "available": 1},
                {"sku": "Rs-List-c", "quantity": 3, "available": 3}]
    ok = status == 200 and len(listed) == 3 and all(has(got, want) for got, want in zip(listed, expected))
    return ok, {"status": status, "listed": listed}


def t_list_everything():
    status, body = call("GET", "/v1/items")
    skus = [entry.get("sku") for entry in body.get("items", [])] if isinstance(body, dict) else []
    wanted = {"Base-Lamp-1", "Rs-Shelf-1", "Rs-List-a"}
    return status == 200 and wanted.issubset(skus) and len(skus) == len(set(skus)), {"status": status, "count": len(skus)}


# Step 2: bundle reservations and reservation lookup.
def t_bundle_shape():
    item("Bd-Kit-1", 5)
    item("Bd-Kit-2", 5)
    status, body = bundle([{"sku": "Bd-Kit-2", "quantity": 2}, {"sku": "Bd-Kit-1", "quantity": 1}])
    ok = (status == 201 and isinstance(body, dict) and isinstance(body.get("id"), str)
          and body.get("lines") == [{"sku": "Bd-Kit-2", "quantity": 2}, {"sku": "Bd-Kit-1", "quantity": 1}]
          and isinstance(body.get("expiresAt"), str) and "sku" not in body)
    return ok and available("Bd-Kit-1") == 4 and available("Bd-Kit-2") == 3, {"status": status, "body": body}


def t_bundle_stock():
    item("Bd-Kit-3", 5)
    item("Bd-Kit-4", 1)
    ok, detail = error(*bundle([{"sku": "Bd-Kit-3", "quantity": 2}, {"sku": "Bd-Kit-4", "quantity": 2}]), 409, "insufficient_stock")
    return ok and available("Bd-Kit-3") == 5 and available("Bd-Kit-4") == 1, detail


def t_bundle_unknown():
    item("Bd-Kit-5", 5)
    ok, detail = error(*bundle([{"sku": "Bd-Kit-5", "quantity": 1}, {"sku": "Bd-Nope-9", "quantity": 1}]), 404, "not_found")
    return ok and available("Bd-Kit-5") == 5, detail


def t_bundle_confirm():
    item("Bd-Kit-6", 5)
    item("Bd-Kit-7", 5)
    reservation = rid(bundle([{"sku": "Bd-Kit-6", "quantity": 2}, {"sku": "Bd-Kit-7", "quantity": 3}]))
    status, body = confirm(reservation)
    again = confirm(reservation)
    ok = (status == 200 and has(body, {"id": reservation, "status": "confirmed"})
          and has(view("Bd-Kit-6"), {"quantity": 3, "available": 3}) and has(view("Bd-Kit-7"), {"quantity": 2, "available": 2})
          and error(*again, 409, "already_confirmed")[0])
    return ok, {"status": status, "items": [view("Bd-Kit-6"), view("Bd-Kit-7")], "again": again}


def t_bundle_release():
    item("Bd-Kit-8", 5)
    item("Bd-Kit-9", 5)
    reservation = rid(bundle([{"sku": "Bd-Kit-8", "quantity": 2}, {"sku": "Bd-Kit-9", "quantity": 3}]))
    status, _ = call("DELETE", f"/v1/reservations/{reservation}")
    ok = status == 204 and available("Bd-Kit-8") == 5 and available("Bd-Kit-9") == 5
    return ok and error(*confirm(reservation), 404, "not_found")[0], {"status": status}


def t_reservation_states():
    item("Bd-Kit-10", 9)
    single, confirmed, released = (rid(reserve("Bd-Kit-10", 1)) for _ in range(3))
    expiring = rid(bundle([{"sku": "Bd-Kit-10", "quantity": 1}], ttl=1))
    confirm(confirmed)
    call("DELETE", f"/v1/reservations/{released}")
    time.sleep(1.5)
    views = {name: call("GET", f"/v1/reservations/{reservation}") for name, reservation in
             (("single", single), ("confirmed", confirmed), ("released", released), ("expired", expiring))}
    statuses = {name: got[1].get("status") if isinstance(got[1], dict) else None for name, got in views.items()}
    first = views["single"][1] if isinstance(views["single"][1], dict) else {}
    ok = (all(got[0] == 200 for got in views.values())
          and statuses == {"single": "active", "confirmed": "confirmed", "released": "released", "expired": "expired"}
          and first.get("id") == single and first.get("lines") == [{"sku": "Bd-Kit-10", "quantity": 1}]
          and isinstance(first.get("expiresAt"), str))
    return ok, {"statuses": statuses, "single": first}


def t_bundle_idempotent():
    item("Bd-Kit-11", 5)
    lines = [{"sku": "Bd-Kit-11", "quantity": 2}]
    first, second = bundle(lines, key="bd-key"), bundle(lines, key="bd-key")
    mismatch = bundle([{"sku": "Bd-Kit-11", "quantity": 1}], key="bd-key")
    ok = (first[0] == 201 and second[0] == 201 and rid(first) == rid(second) and available("Bd-Kit-11") == 3
          and error(*mismatch, 422, "idempotency_mismatch")[0])
    return ok, {"first": first, "second": second, "mismatch": mismatch}


def t_bundle_concurrent():
    item("Bd-Kit-12", 4)
    item("Bd-Kit-13", 40)
    results = [status for status, _ in parallel(12, lambda _: bundle([{"sku": "Bd-Kit-13", "quantity": 1},
                                                                      {"sku": "Bd-Kit-12", "quantity": 1}]))]
    ok = results.count(201) == 4 and results.count(409) == 8 and available("Bd-Kit-12") == 0 and available("Bd-Kit-13") == 36
    return ok, {"results": results}


# Step 3: richer errors.
def detailed(status, body, expected, code, field=None):
    """Step 3's error: `status`, `detail` equal to `message`, and `field` where named."""
    ok, detail = error(status, body, expected, code)
    failure = body.get("error") if isinstance(body, dict) and isinstance(body.get("error"), dict) else {}
    ok = ok and failure.get("status") == expected and failure.get("detail") == failure.get("message")
    if field is not None:
        ok = ok and failure.get("field") == field
    return ok, detail


def all_ok(*outcomes):
    return all(ok for ok, _ in outcomes), [detail for ok, detail in outcomes if not ok]


def t_status_not_found():
    reservation_missing = call("GET", "/v1/reservations/er-missing")
    return all_ok(detailed(*call("GET", "/v1/items/Er-Nope-1"), 404, "not_found"),
                  detailed(*call("GET", "/v1/nothing"), 404, "not_found"),
                  detailed(*restock("Er-Nope-2", 1), 404, "not_found"),
                  detailed(*reservation_missing, 404, "not_found"),
                  detailed(*call("DELETE", "/v1/reservations/er-missing"), 404, "not_found"))


def t_status_conflicts():
    item("Er-Item-1", 1)
    reservation = rid(reserve("Er-Item-1", 1))
    confirm(reservation)
    return all_ok(detailed(*item("Er-Item-1", 1), 409, "conflict"),
                  detailed(*reserve("Er-Item-1", 5), 409, "insufficient_stock"),
                  detailed(*confirm(reservation), 409, "already_confirmed"))


def t_status_requests():
    return all_ok(detailed(*call("POST", "/v1/items", raw=b"{nope"), 400, "invalid_json"),
                  detailed(*call("POST", "/v1/items", {"sku": "Er-Ct-1", "quantity": 1}, headers={"Content-Type": "text/plain"}),
                           415, "unsupported_media_type"),
                  detailed(*call("PUT", "/v1/items", {}), 405, "method_not_allowed"),
                  detailed(*call("POST", "/v1/items", [1]), 422, "invalid_request"))


def t_status_expired():
    item("Er-Item-2", 2)
    reservation = rid(reserve("Er-Item-2", 1, 1))
    time.sleep(1.5)
    return detailed(*confirm(reservation), 410, "expired")


def t_status_idempotency():
    item("Er-Item-3", 3)
    reserve("Er-Item-3", 1, key="er-key")
    return detailed(*reserve("Er-Item-3", 2, key="er-key"), 422, "idempotency_mismatch")


def t_field_items():
    return all_ok(detailed(*item("bad sku!", 1), 422, "invalid_request", "sku"),
                  detailed(*item("Er-Item-4", -1), 422, "invalid_request", "quantity"),
                  detailed(*call("POST", "/v1/items", {"sku": "Er-Item-5"}), 422, "invalid_request", "quantity"))


def t_field_reservations():
    item("Er-Item-6", 3)
    return all_ok(detailed(*reserve("Er-Item-6", 0), 422, "invalid_request", "quantity"),
                  detailed(*reserve("Er-Item-6", 1, 3601), 422, "invalid_request", "ttlSeconds"),
                  detailed(*call("POST", "/v1/reservations", {"sku": "Er-Item-6", "quantity": 1}), 422, "invalid_request", "ttlSeconds"))


def t_field_restock():
    item("Er-Item-7", 3)
    return detailed(*restock("Er-Item-7", 0), 422, "invalid_request", "quantity")


def t_field_lines():
    item("Er-Item-8", 3)
    return all_ok(detailed(*bundle([{"sku": "Er-Item-8", "quantity": 1}, {"sku": "Er-Item-8x", "quantity": 0}]),
                           422, "invalid_request", "lines[1].quantity"),
                  detailed(*bundle([{"sku": 7, "quantity": 1}]), 422, "invalid_request", "lines[0].sku"),
                  detailed(*bundle([]), 422, "invalid_request", "lines"))


def t_field_left_out():
    status, body = call("POST", "/v1/items", [1])
    failure = body.get("error") if isinstance(body, dict) and isinstance(body.get("error"), dict) else {}
    return status == 422 and "field" not in failure, {"status": status, "body": body}


# Step 4: case-insensitive SKUs.
def t_case_lookup():
    item("Ci-Desk-1", 5)
    lower, upper = call("GET", "/v1/items/ci-desk-1"), call("GET", "/v1/items/CI-DESK-1")
    want = {"sku": "Ci-Desk-1", "quantity": 5, "available": 5}
    return lower[0] == 200 and upper[0] == 200 and has(lower[1], want) and has(upper[1], want), {"lower": lower, "upper": upper}


def t_case_duplicate():
    item("Ci-Desk-2", 5)
    ok, detail = error(*item("CI-DESK-2", 1), 409, "conflict")
    return ok and has(view("Ci-Desk-2"), {"sku": "Ci-Desk-2", "quantity": 5}), detail


def t_case_reserve():
    item("Ci-Desk-3", 5)
    status, body = reserve("ci-desk-3", 2)
    reservation = rid((status, body))
    ok = status == 201 and has(body, {"sku": "Ci-Desk-3", "quantity": 2}) and available("CI-desk-3") == 3
    looked = call("GET", f"/v1/reservations/{reservation}")
    ok = ok and looked[0] == 200 and has(looked[1], {"lines": [{"sku": "Ci-Desk-3", "quantity": 2}]})
    return ok and confirm(reservation)[0] == 200 and has(view("Ci-Desk-3"), {"quantity": 3}), {"status": status, "body": body, "looked": looked}


def t_case_restock():
    item("Ci-Desk-4", 1)
    status, body = restock("CI-DESK-4", 2)
    return status == 200 and has(body, {"sku": "Ci-Desk-4", "quantity": 3}), {"status": status, "body": body}


def t_case_bundle():
    item("Ci-Part-1", 5)
    item("Ci-Part-2", 5)
    status, body = bundle([{"sku": "ci-part-1", "quantity": 1}, {"sku": "CI-PART-2", "quantity": 2}])
    ok = status == 201 and has(body, {"lines": [{"sku": "Ci-Part-1", "quantity": 1}, {"sku": "Ci-Part-2", "quantity": 2}]})
    return ok and available("Ci-Part-1") == 4 and available("Ci-Part-2") == 3, {"status": status, "body": body}


def t_case_bundle_repeat():
    item("Ci-Part-3", 5)
    ok, detail = error(*bundle([{"sku": "Ci-Part-3", "quantity": 1}, {"sku": "ci-part-3", "quantity": 1}]), 422, "invalid_request")
    return ok and available("Ci-Part-3") == 5, detail


def t_case_list():
    item("Ci-List-1", 2)
    status, body = call("GET", "/v1/items")
    skus = [entry.get("sku") for entry in body.get("items", [])] if isinstance(body, dict) else []
    matches = [sku for sku in skus if str(sku).lower() == "ci-list-1"]
    return status == 200 and matches == ["Ci-List-1"], {"status": status, "matches": matches}


def t_case_unknown():
    return error(*reserve("ci-nope-1", 1), 404, "not_found")


def t_case_concurrent():
    item("Ci-Box-1", 10)
    statuses = [status for status, _ in parallel(30, lambda index: reserve(("ci-box-1", "CI-BOX-1", "Ci-Box-1")[index % 3], 1))]
    ok = statuses.count(201) == 10 and statuses.count(409) == 20 and available("ci-box-1") == 0
    return ok, {"201": statuses.count(201), "409": statuses.count(409), "available": available("ci-box-1")}


CHECKS = [
    (0, "create item", t_create),
    (0, "duplicate item conflict", lambda: error(*item("Base-Lamp-1", 5), 409, "conflict")),
    (0, "get item", t_get),
    (0, "unknown item 404", lambda: error(*call("GET", "/v1/items/Base-Nope-1"), 404, "not_found")),
    (0, "reserve shape and expiry", t_reserve_shape),
    (0, "reserve unknown sku 404", lambda: error(*reserve("Base-Nope-2", 1), 404, "not_found")),
    (0, "insufficient stock holds nothing", t_insufficient),
    (0, "release restores stock", t_release),
    (0, "confirm reduces quantity", t_confirm),
    (0, "confirm twice", t_confirm_twice),
    (0, "delete confirmed 404", t_delete_confirmed),
    (0, "unknown reservation delete 404", lambda: error(*call("DELETE", "/v1/reservations/nope"), 404, "not_found")),
    (0, "unknown reservation confirm 404", lambda: error(*confirm("nope"), 404, "not_found")),
    (0, "expiry frees stock and confirm 410", t_expiry),
    (0, "expired release 404", t_expired_release),
    (0, "expired capacity reusable", t_expired_capacity),
    (0, "reconfirm after expiry 409", t_reconfirm_after_expiry),
    (0, "released then expired 404", t_released_after_expiry),
    (0, "idempotent repeat", t_idempotent),
    (0, "idempotency mismatch", t_idempotent_mismatch),
    (0, "idempotency key with different ttl", t_idempotency_ttl),
    (0, "distinct keys distinct reservations", t_distinct_keys),
    (0, "concurrent reservations never oversell", t_concurrent),
    (0, "concurrent same idempotency key", t_concurrent_idempotent),
    (0, "item sku invalid", invalid("/v1/items", {"sku": "bad sku!", "quantity": 1})),
    (0, "item sku too long", invalid("/v1/items", {"sku": "a" * 65, "quantity": 1})),
    (0, "item quantity invalid", lambda: all_ok(*(error(*item(f"Base-Q-{n}", value), 422, "invalid_request")
                                                  for n, value in enumerate((-1, True, 1.5, "3"))))),
    (0, "reserve zero quantity", invalid("/v1/reservations", {"sku": "Base-Lamp-1", "quantity": 0, "ttlSeconds": 10})),
    (0, "reserve ttl out of range", lambda: all_ok(*(error(*reserve("Base-Lamp-1", 1, ttl), 422, "invalid_request")
                                                     for ttl in (0, 3601, True)))),
    (0, "reserve ttl missing", invalid("/v1/reservations", {"sku": "Base-Lamp-1", "quantity": 1})),
    (0, "body not object", invalid("/v1/items", [1])),
    (0, "malformed json", lambda: error(*call("POST", "/v1/items", raw=b"{nope"), 400, "invalid_json")),
    (0, "wrong content type", lambda: error(*call("POST", "/v1/items", {"sku": "Base-Ct-2", "quantity": 1},
                                                  headers={"Content-Type": "text/plain"}), 415, "unsupported_media_type")),
    (0, "content type params", t_content_type_params),
    (0, "unknown path 404", lambda: error(*call("GET", "/v1/nothing"), 404, "not_found")),
    (0, "extra path segment 404", lambda: error(*call("GET", "/v1/items/Base-Lamp-1/extra"), 404, "not_found")),
    (0, "wrong method 405", lambda: error(*call("PUT", "/v1/items", {"sku": "Base-M", "quantity": 1}), 405, "method_not_allowed")),
    (0, "wrong method on reservations 405", lambda: error(*call("GET", "/v1/reservations"), 405, "method_not_allowed")),
    (0, "wrong method on confirm 405", lambda: error(*call("DELETE", "/v1/reservations/abc/confirm"), 405, "method_not_allowed")),

    (1, "restock adds stock", t_restock),
    (1, "restock with stock held", t_restock_held),
    (1, "restocked units can be confirmed", t_restock_then_confirm),
    (1, "restock unknown sku 404", lambda: error(*restock("Rs-Nope-1", 1), 404, "not_found")),
    (1, "restock quantity invalid", t_restock_quantities),
    (1, "restock body errors", t_restock_bodies),
    (1, "restock and list methods 405", t_restock_methods),
    (1, "list sorted with availability", t_list),
    (1, "list holds every item once", t_list_everything),

    (2, "bundle response and holds", t_bundle_shape),
    (2, "bundle all or nothing on stock", t_bundle_stock),
    (2, "bundle all or nothing on unknown sku", t_bundle_unknown),
    (2, "confirm bundle", t_bundle_confirm),
    (2, "release bundle", t_bundle_release),
    (2, "reservation states", t_reservation_states),
    (2, "bundle idempotency", t_bundle_idempotent),
    (2, "concurrent bundles never oversell", t_bundle_concurrent),
    (2, "both shapes 422", invalid("/v1/reservations", {"sku": "Bd-Kit-1", "quantity": 1, "lines": [{"sku": "Bd-Kit-2", "quantity": 1}], "ttlSeconds": 5})),
    (2, "neither shape 422", invalid("/v1/reservations", {"ttlSeconds": 5})),
    (2, "empty lines 422", invalid("/v1/reservations", {"lines": [], "ttlSeconds": 5})),
    (2, "repeated sku 422", invalid("/v1/reservations", {"lines": [{"sku": "Bd-Kit-1", "quantity": 1}, {"sku": "Bd-Kit-1", "quantity": 2}], "ttlSeconds": 5})),
    (2, "too many lines 422", invalid("/v1/reservations", {"lines": [{"sku": f"Bd-Z-{i}", "quantity": 1} for i in range(21)], "ttlSeconds": 5})),
    (2, "invalid line 422", invalid("/v1/reservations", {"lines": [{"sku": "Bd-Kit-1", "quantity": 0}], "ttlSeconds": 5})),
    (2, "bundle missing ttl 422", invalid("/v1/reservations", {"lines": [{"sku": "Bd-Kit-1", "quantity": 1}]})),
    (2, "unknown reservation lookup 404", lambda: error(*call("GET", "/v1/reservations/does-not-exist"), 404, "not_found")),
    (2, "wrong method on reservation id 405", lambda: error(*call("PUT", "/v1/reservations/abc", {}), 405, "method_not_allowed")),

    (3, "status and detail on 404", t_status_not_found),
    (3, "status and detail on 409", t_status_conflicts),
    (3, "status and detail on request errors", t_status_requests),
    (3, "status and detail on 410", t_status_expired),
    (3, "status and detail on idempotency mismatch", t_status_idempotency),
    (3, "field for item errors", t_field_items),
    (3, "field for reservation errors", t_field_reservations),
    (3, "field for restock errors", t_field_restock),
    (3, "field for bundle lines", t_field_lines),
    (3, "field left out for a wrong body", t_field_left_out),

    (4, "lookup in any case", t_case_lookup),
    (4, "duplicate in another case 409", t_case_duplicate),
    (4, "reserve in another case", t_case_reserve),
    (4, "restock in another case", t_case_restock),
    (4, "bundle in another case", t_case_bundle),
    (4, "bundle repeats a sku in another case 422", t_case_bundle_repeat),
    (4, "list shows the created spelling", t_case_list),
    (4, "unknown sku in any case 404", t_case_unknown),
    (4, "concurrent reservations across cases", t_case_concurrent),
]


class Server:
    """One run of ./start.sh on a free port, optionally with INVENTORY_DATA_FILE."""

    def __init__(self, data_file=None, port=None):
        self.port = port or free_port()
        self.data_file = data_file
        self.process = None

    def start(self):
        global PORT
        env = {k: v for k, v in os.environ.items() if k != "INVENTORY_DATA_FILE"}
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        if self.data_file:
            env["INVENTORY_DATA_FILE"] = str(self.data_file)
        log = open(ROOT.parent / f"{ROOT.name}-hidden-server.log", "a")
        self.process = subprocess.Popen(["bash", "start.sh", str(self.port)], cwd=ROOT, env=env, stdout=log, stderr=log,
                                        start_new_session=True)
        PORT = self.port
        deadline = time.time() + 15
        while time.time() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.2):
                    return True
            except OSError:
                if self.process.poll() is not None:
                    return False
                time.sleep(0.1)
        return False

    def stop(self):
        if not self.process:
            return
        try:
            os.killpg(self.process.pid, signal.SIGTERM)
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait()
        except ProcessLookupError:
            pass
        self.process = None

    def restart(self):
        self.stop()
        return self.start()


def with_data(scenario):
    """A step 5 check: a server on a fresh data file, which the scenario may restart."""
    def run():
        with tempfile.TemporaryDirectory(prefix="inventory-data-") as directory:
            server = Server(Path(directory) / "state.json")
            try:
                if not server.start():
                    return False, "the server did not start with INVENTORY_DATA_FILE set"
                return scenario(server)
            finally:
                server.stop()
    return run


def p_items(server):
    item("Pf-Item-1", 5)
    restock("Pf-Item-1", 2)
    restarted = server.restart()
    listed = call("GET", "/v1/items")[1]
    skus = [entry.get("sku") for entry in listed.get("items", [])] if isinstance(listed, dict) else []
    ok = restarted and has(view("Pf-Item-1"), {"sku": "Pf-Item-1", "quantity": 7, "available": 7}) and skus == ["Pf-Item-1"]
    return ok and error(*item("Pf-Item-1", 1), 409, "conflict")[0], {"restarted": restarted, "item": view("Pf-Item-1"), "listed": listed}


def moment(text):
    try:
        return datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    except ValueError:
        return None


def p_active(server):
    item("Pf-Item-2", 5)
    created = reserve("Pf-Item-2", 2, 60)
    restarted = server.restart()
    looked = call("GET", f"/v1/reservations/{rid(created)}")
    before, after = moment((created[1] or {}).get("expiresAt")), moment((looked[1] or {}).get("expiresAt"))
    ok = (restarted and available("Pf-Item-2") == 3 and looked[0] == 200 and before and after
          and abs((after - before).total_seconds()) < 0.01
          and has(looked[1], {"status": "active", "lines": [{"sku": "Pf-Item-2", "quantity": 2}]}))
    confirmed = confirm(rid(created))
    return ok and confirmed[0] == 200 and has(view("Pf-Item-2"), {"quantity": 3, "available": 3}), {
        "created": created, "looked": looked, "confirmed": confirmed, "item": view("Pf-Item-2")}


def p_finished(server):
    item("Pf-Item-3", 5)
    confirmed, released = rid(reserve("Pf-Item-3", 1)), rid(reserve("Pf-Item-3", 1))
    confirm(confirmed)
    call("DELETE", f"/v1/reservations/{released}")
    restarted = server.restart()
    statuses = [(call("GET", f"/v1/reservations/{reservation}")[1] or {}).get("status") for reservation in (confirmed, released)]
    ok = (restarted and statuses == ["confirmed", "released"] and has(view("Pf-Item-3"), {"quantity": 4, "available": 4})
          and error(*confirm(confirmed), 409, "already_confirmed")[0]
          and error(*call("DELETE", f"/v1/reservations/{released}"), 404, "not_found")[0])
    return ok, {"restarted": restarted, "statuses": statuses, "item": view("Pf-Item-3")}


def p_expiry(server):
    item("Pf-Item-4", 3)
    reservation = rid(reserve("Pf-Item-4", 2, 3))
    restarted = server.restart()
    held = available("Pf-Item-4")
    time.sleep(3.2)
    status = (call("GET", f"/v1/reservations/{reservation}")[1] or {}).get("status")
    ok = restarted and held == 1 and status == "expired" and available("Pf-Item-4") == 3
    return ok and error(*confirm(reservation), 410, "expired")[0], {"held": held, "status": status, "after": available("Pf-Item-4")}


def p_idempotency(server):
    item("Pf-Item-5", 5)
    first = reserve("Pf-Item-5", 1, 60, key="pf-key")
    restarted = server.restart()
    again = reserve("Pf-Item-5", 1, 60, key="pf-key")
    mismatch = reserve("Pf-Item-5", 2, 60, key="pf-key")
    ok = (restarted and first[0] == 201 and again[0] == 201 and again[1] == first[1] and available("Pf-Item-5") == 4
          and error(*mismatch, 422, "idempotency_mismatch")[0])
    return ok, {"first": first, "again": again, "mismatch": mismatch}


def p_bundles(server):
    item("Pf-Kit-1", 5)
    item("Pf-Kit-2", 5)
    created = bundle([{"sku": "Pf-Kit-2", "quantity": 2}, {"sku": "Pf-Kit-1", "quantity": 1}])
    restarted = server.restart()
    looked = call("GET", f"/v1/reservations/{rid(created)}")
    ok = restarted and has(looked[1], {"status": "active", "lines": [{"sku": "Pf-Kit-2", "quantity": 2}, {"sku": "Pf-Kit-1", "quantity": 1}]})
    confirmed = confirm(rid(created))
    ok = ok and confirmed[0] == 200 and has(view("Pf-Kit-1"), {"quantity": 4}) and has(view("Pf-Kit-2"), {"quantity": 3})
    return ok, {"looked": looked, "confirmed": confirmed}


def p_spelling(server):
    item("Pf-Case-1", 2)
    restarted = server.restart()
    ok = restarted and has(view("pf-case-1"), {"sku": "Pf-Case-1", "quantity": 2})
    return ok and error(*item("PF-CASE-1", 1), 409, "conflict")[0], {"item": view("pf-case-1")}


def p_concurrent(server):
    item("Pf-Box-1", 10)
    statuses = [status for status, _ in parallel(30, lambda _: reserve("Pf-Box-1", 1, 60))]
    restarted = server.restart()
    ok = statuses.count(201) == 10 and statuses.count(409) == 20 and restarted and available("Pf-Box-1") == 0
    return ok, {"201": statuses.count(201), "409": statuses.count(409), "available": available("Pf-Box-1")}


def p_missing_file():
    with tempfile.TemporaryDirectory(prefix="inventory-data-") as directory:
        server = Server(Path(directory) / "state.json")
        try:
            started = server.start()
            ok = started and error(*call("GET", "/v1/items/Pf-Item-1"), 404, "not_found")[0] and item("Pf-New-1", 1)[0] == 201
            return ok and server.restart() and has(view("Pf-New-1"), {"quantity": 1}), {"started": started}
        finally:
            server.stop()


def p_memory():
    server = Server()
    try:
        started = server.start()
        created = item("Pf-Mem-1", 1)
        restarted = server.restart()
        gone = call("GET", "/v1/items/Pf-Mem-1")
        return started and created[0] == 201 and restarted and gone[0] == 404, {"created": created, "after": gone}
    finally:
        server.stop()


PERSISTENCE = [
    (5, "items survive a restart", with_data(p_items)),
    (5, "an active reservation survives with its expiry", with_data(p_active)),
    (5, "confirmed and released reservations survive", with_data(p_finished)),
    (5, "expiry continues across a restart", with_data(p_expiry)),
    (5, "idempotency keys survive", with_data(p_idempotency)),
    (5, "bundles survive", with_data(p_bundles)),
    (5, "created spelling survives", with_data(p_spelling)),
    (5, "concurrent holds are kept", with_data(p_concurrent)),
    (5, "a file that does not exist yet starts empty", p_missing_file),
    (5, "without the variable state stays in memory", p_memory),
]


def run_check(step, name, function):
    try:
        ok, detail = function()
    except Exception as failure:  # noqa: BLE001
        ok, detail = False, repr(failure)
    return {"name": f"{'base' if step == 0 else f's{step}'}: {name}", "step": step, "passed": bool(ok),
            "detail": None if ok else detail}


def main():
    global ROOT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project_dir", type=Path)
    parser.add_argument("--step", type=int, choices=range(6), default=5)
    args = parser.parse_args()
    ROOT = args.project_dir.resolve()
    checks = [check for check in CHECKS + PERSISTENCE if check[0] <= args.step]
    if not (ROOT / "start.sh").exists():
        results = [{"name": f"{'base' if step == 0 else f's{step}'}: {name}", "step": step, "passed": False,
                    "detail": "no start.sh"} for step, name, _ in checks]
    else:
        server = Server()
        try:
            started = server.start()
            results = [run_check(step, name, function if started else lambda: (False, "the server did not start"))
                       for step, name, function in CHECKS if step <= args.step]
        finally:
            server.stop()
        results += [run_check(*check) for check in PERSISTENCE if check[0] <= args.step]
    print(json.dumps({"passed": sum(r["passed"] for r in results), "total": len(results), "step": args.step,
                      "results": results}, indent=1))


if __name__ == "__main__":
    main()
