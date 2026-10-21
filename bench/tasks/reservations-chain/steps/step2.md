Next feature for the inventory reservations API in this repository: customers check out several products at once.

- `POST /v1/reservations` also accepts `{"lines": [{"sku": "<sku>", "quantity": <integer >= 1>}, ...], "ttlSeconds": <integer 1..3600>}` with 1 to 20 lines and each SKU at most once. A request uses either `sku` and `quantity` or `lines`, never both; anything else is 422 `invalid_request`.
- It is all or nothing: an unknown SKU on any line is 404 `not_found`, too little stock on any line is 409 `insufficient_stock`, and then nothing is held.
- Success is 201 `{"id", "lines": [{"sku", "quantity"}, ...], "expiresAt"}`, with the lines in request order. Idempotency keys work for these as they do today.
- Releasing or confirming such a reservation acts on all its lines at once, with the usual status codes; confirming reduces every line's item.
- New: `GET /v1/reservations/<id>` returns 200 `{"id", "status", "lines", "expiresAt"}` for any reservation (a single-SKU one has one line). `status` is `active`, `confirmed`, `released` or `expired`. An unknown id is 404.

Please add tests and update the README.
