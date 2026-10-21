Ops want to inspect and back up the state of the inventory reservations API in this repository, so its state should move from in-memory dictionaries into SQLite (the standard library's `sqlite3`). The environment variable `INVENTORY_DB` names the database file; without it, use an in-memory database. A restart with the same file must pick up exactly where the service left off.

Update the tests and the README.
