Client developers of the inventory reservations API in this repository find our errors hard to act on. Please extend the error body, in line with our API guidelines:

- Every error carries `status`, the HTTP status as a number.
- The human-readable text moves to `detail`. Older clients still read `message`, so keep it, with the same text.
- A 422 `invalid_request` names the rejected input in `field`: the field's name, or `lines[<index>].<name>` for a bundle line (index from 0), for example `lines[1].quantity`. Leave `field` out when the body as a whole is wrong.

Update the tests and the README.
