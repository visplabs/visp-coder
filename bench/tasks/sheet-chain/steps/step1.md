This repository contains our spreadsheet engine; its contract is in README.md. Finance asked for two more functions:

- `AVERAGE(...)`: the mean of the numbers in its arguments. It takes arguments and ranges the way `SUM` does. With no numbers to average the result is `#DIV/0!`.
- `COUNT(...)`: how many numbers its arguments and ranges hold. Empty cells and text cells in a range are not counted.

Add tests for both and document them in the README. Use only the Python standard library; `./run.sh` stays the way to run it.
