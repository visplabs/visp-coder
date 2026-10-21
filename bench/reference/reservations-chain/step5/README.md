# Inventory reservations API

Run: `./start.sh <port>` (Python 3.10, standard library only). With `INVENTORY_DATA_FILE=<path>` the state (items, reservations with their status and expiry, idempotency keys) is kept in that file and a restart with the same file resumes it; a file that does not exist yet starts an empty store. Without it, state is in memory only. Tests: `python3 -m unittest discover -s tests`.

Layout: `inventory/store.py` holds state and rules, `inventory/validation.py` request validation, `inventory/http.py` routing and the HTTP contract, `server.py` the entry point.

## Contract

- SKUs are case-insensitive: `desk-1` and `DESK-1` name the same item wherever a SKU is accepted (including a bundle's repeated-SKU rule). An item keeps the spelling it was created with, and every response shows it.
- `POST /v1/items` `{"sku": "<1-64 letters, digits or ->", "quantity": <int >= 0>}` → 201 `{"sku","quantity","available"}`; existing SKU → 409 `conflict`.
- `GET /v1/items` → 200 `{"items": [...]}`: every item as `GET /v1/items/<sku>` shows it, sorted by SKU.
- `POST /v1/items/<sku>/restock` `{"quantity": <int >= 1>}` → 200 with the item; adds to its quantity. Unknown SKU → 404 `not_found`.
- `GET /v1/items/<sku>` → 200 `{"sku","quantity","available"}`; `available` is `quantity` minus active (unexpired, unconfirmed, unreleased) reservations. Unknown → 404 `not_found`.
- `POST /v1/reservations` `{"sku","quantity": <int >= 1>,"ttlSeconds": <int 1..3600>}` → 201 `{"id","sku","quantity","expiresAt"}`. Unknown SKU → 404; not enough available stock → 409 `insufficient_stock` and nothing is held.
- Bundles: `POST /v1/reservations` also accepts `{"lines": [{"sku", "quantity": <int >= 1>}, ...], "ttlSeconds"}` with 1 to 20 lines, each SKU at most once; a request uses exactly one shape, otherwise 422 `invalid_request`. All or nothing: an unknown SKU on any line → 404, too little stock on any line → 409 `insufficient_stock`, and nothing is held. → 201 `{"id","lines": [{"sku","quantity"}, ...],"expiresAt"}` in request order.
- `GET /v1/reservations/<id>` → 200 `{"id","status","lines","expiresAt"}` for either shape (a single reservation has one line); `status` is `active`, `confirmed`, `released` or `expired`. Unknown → 404.
- `Idempotency-Key` header: the same key and body return the original 201 without holding stock again; the same key with a different body → 422 `idempotency_mismatch`.
- `DELETE /v1/reservations/<id>` releases an active reservation (every line of a bundle) → 204. Unknown, released, confirmed or expired → 404.
- `POST /v1/reservations/<id>/confirm` → 200 `{"id","status":"confirmed"}` and permanently reduces the quantity of every line's item. Again → 409 `already_confirmed`; expired → 410 `expired`; unknown or released → 404.
- Concurrent reservations never hold more than is available.
- Errors: `{"error": {"code", "status", "detail", "message"}}`: `status` is the HTTP status, `detail` the text, and `message` the same text for older clients. A 422 `invalid_request` adds `field`, the rejected input (`sku`, `quantity`, `ttlSeconds`, `lines`, or `lines[<index>].sku`/`lines[<index>].quantity` for a bundle line, index from 0); it is left out when the body as a whole is wrong (not an object, or neither or both reservation shapes). 400 `invalid_json`; 422 `invalid_request` (wrong shape or values, booleans as numbers, invalid SKU); 415 `unsupported_media_type` for a body whose Content-Type is not `application/json` (parameters and case allowed); 404 unknown path; 405 known path with the wrong method.
