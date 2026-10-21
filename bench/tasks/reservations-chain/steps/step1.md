This repository is our inventory reservations API; the contract is in README.md. Warehouse staff need two things:

- Restocking: `POST /v1/items/<sku>/restock` with `{"quantity": <integer >= 1>}` adds that many units to the item and returns 200 with the item, as `GET /v1/items/<sku>` shows it. An unknown SKU is 404.
- A stock list: `GET /v1/items` returns 200 `{"items": [...]}` with every item, shown as `GET /v1/items/<sku>` shows it, sorted by SKU.

Add tests and update the README. Standard library only; `./start.sh <port>` still starts the service.
