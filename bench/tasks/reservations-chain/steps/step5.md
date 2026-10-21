The inventory reservations API in this repository loses everything when it restarts, which hurts on every deploy. When the environment variable `INVENTORY_DATA_FILE` names a file, keep the service's state in that file, so that a restart with the same file comes back to exactly the state it had: items, reservations with their status and expiry, and idempotency keys. A file that doesn't exist yet means an empty store. Without the variable the service keeps its state in memory, as now.

Add tests and update the README.
