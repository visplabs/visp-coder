This repository contains a spreadsheet engine. Its contract is in README.md, and the contract is correct: it is what users rely on. The code does not always follow it. Two reports so far: `=2^3^2` prints `64` instead of `512`, and `=COUNTIF(A1:A4,"<>5")` does not count empty cells. There are more deviations that nobody has reported yet.

1. Check the engine against every statement of the README contract and fix every place where its behavior differs from the contract. Do not change behavior that already follows the contract, and do not change the contract.
2. Add tests that pin the contract, including one for each deviation you fix, and keep the existing tests passing.
3. At the end, list the deviations you found and fixed.

Use only the Python standard library. Run with `./run.sh` as before.
