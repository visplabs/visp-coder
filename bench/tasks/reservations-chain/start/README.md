# Inventory reservations API

Run: `./start.sh <port>` (Python 3.10, standard library only). Tests: `python3 -m unittest discover -s tests`.

Layout: `inventory/store.py` holds state and rules, `inventory/validation.py` request validation, `inventory/http.py` routing and the HTTP contract, `server.py` the entry point.

## Contract

- `POST /v1/items` `{"sku": "<1-64 letters, digits or ->", "quantity": <int >= 0>}` → 201 `{"sku","quantity","available"}`; existing SKU → 409 `conflict`.
- `GET /v1/items/<sku>` → 200 `{"sku","quantity","available"}`; `available` is `quantity` minus active (unexpired, unconfirmed, unreleased) reservations. Unknown → 404 `not_found`.
- `POST /v1/reservations` `{"sku","quantity": <int >= 1>,"ttlSeconds": <int 1..3600>}` → 201 `{"id","sku","quantity","expiresAt"}`. Unknown SKU → 404; not enough available stock → 409 `insufficient_stock` and nothing is held.
- `Idempotency-Key` header: the same key and body return the original 201 without holding stock again; the same key with a different body → 422 `idempotency_mismatch`.
- `DELETE /v1/reservations/<id>` releases an active reservation → 204. Unknown, released, confirmed or expired → 404.
- `POST /v1/reservations/<id>/confirm` → 200 `{"id","status":"confirmed"}` and permanently reduces the item's quantity. Again → 409 `already_confirmed`; expired → 410 `expired`; unknown or released → 404.
- Concurrent reservations never hold more than is available.
- Errors: `{"error": {"code", "message"}}`. 400 `invalid_json`; 422 `invalid_request` (wrong shape or values, booleans as numbers, invalid SKU); 415 `unsupported_media_type` for a body whose Content-Type is not `application/json` (parameters and case allowed); 404 unknown path; 405 known path with the wrong method.
