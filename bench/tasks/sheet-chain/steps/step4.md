Users of the spreadsheet engine in this repository keep asking for row insertion and deletion. Add two commands:

- `INSERTROW <n>` inserts an empty row before row `n` (1 to 99): row `n` and every row below it move down by one. If row 99 has content, print `ERROR` and change nothing.
- `DELETEROW <n>` removes row `n`: every row below it moves up by one and row 99 becomes empty.

After either command, formulas still refer to the same cells, wherever those cells moved. A reference to a deleted row, or one that would move past row 99, becomes `#REF!`. The two corners of a range move like references; a corner on a deleted row moves to the nearest remaining row inside the range, and a range whose rows were all deleted is `#REF!`. A missing or invalid row number prints `ERROR`.

Add tests and document the commands in the README.
