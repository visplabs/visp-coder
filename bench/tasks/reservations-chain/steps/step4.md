Support keeps getting tickets from customers who typed a SKU in the wrong case. In the inventory reservations API in this repository, SKUs should be case-insensitive from now on: `desk-1` and `DESK-1` are the same item wherever a SKU is accepted, and creating `desk-1` when `DESK-1` exists is a 409 conflict. An item keeps the spelling it was created with, and every response shows that spelling.

Add tests and update the README.
