# Spreadsheet engine

Run: `./run.sh` (Python 3.10, standard library only). Tests: `python3 -m unittest discover -s tests`.

Layout: `sheet/parser.py` tokenizes and parses formulas into tuple nodes, `sheet/engine.py` stores cells, finds cycles and evaluates, `sheet/values.py` holds value types and output formatting, `sheet/cells.py` cell names and ranges, `sheet/cli.py` the commands; `move_formula` and `rewrite_rows` in `sheet/parser.py` rewrite references for `COPY` and the row commands.

## Contract

- Start command: `./run.sh` reads commands from standard input, one per line, and writes one output line for every `GET` and for every invalid command. Use only the standard library of Python 3.10 or Node.js 22; no dependency downloads.
- Cells are named by one letter `A`–`Z` followed by a row `1`–`99` (for example `A1`, `Z99`); letters are case-insensitive on input.
- Commands (keywords are case-insensitive, separated by single spaces):
  - `SET <cell> <content>`: everything after the second space is the cell's raw content. Content starting with `=` is a formula. Content that is a number (an optional `+` or `-`, one or more digits, then optionally `.` and one or more digits, for example `-3` or `2.50`; `.5` and `1e3` are not numbers) is a number. Any other content is text. Empty content clears the cell.
  - `GET <cell>`: prints the cell's current value.
  - `CLEAR <cell>`: empties the cell.
  - `COPY <from> <to>`: copies the raw content of one cell to another (copying an empty cell clears the target). In a formula every reference part without `$` moves by the distance from `<from>` to `<to>` (columns and rows separately); parts with `$` stay. A reference moved outside `A1`–`Z99` becomes the text `#REF!` in the formula.
  - `FORMULA <cell>`: prints the cell's raw content (an empty line for an empty cell). For content set with `SET` it prints what was set; for content produced by `COPY` it prints the moved formula, with every reference written as upper-case letters, keeping `$` signs, and all other text unchanged.
  - `INSERTROW <n>` (`n` from `1` to `99`): inserts an empty row before row `n`; every row from `n` down moves one row down. If any cell in row `99` has content, prints `ERROR` and changes nothing.
  - `DELETEROW <n>` (`n` from `1` to `99`): removes row `n`; every row below moves one row up and row `99` becomes empty.
  - After `INSERTROW` or `DELETEROW` every reference in every formula still points to the cell it pointed to, wherever that cell moved; `$` makes no difference. A reference to a deleted row, or one that `INSERTROW` would move past row `99`, becomes the text `#REF!`. A range's corners move on their own, except that a range whose rows are all deleted, or with a corner moved past row `99`, becomes `#REF!` as a whole, and a corner on a deleted row moves to the nearest remaining row inside the range. Every formula is then written as `COPY` writes a moved formula (references in upper case, `$` kept, text in double quotes unchanged), also where no reference moved.
  - Any other line, or a command with a missing or invalid cell name or row number, prints `ERROR` and changes nothing. Blank lines are ignored.
- Values printed by `GET`:
  - An empty cell prints an empty line.
  - Numbers print without a trailing `.0`: integers as integers; other numbers rounded to at most 6 decimal places with trailing zeros removed (`1/3` prints `0.333333`, `2/4` prints `0.5`). Negative zero prints `0`.
  - Text prints as stored. A formula whose value is text prints as that text.
  - Booleans print as `TRUE` or `FALSE`.
  - Errors print as their code: `#DIV/0!`, `#VALUE!`, `#REF!`, `#CYCLE!`, `#PARSE!`.
- Formulas:
  - Numbers (digits with an optional `.` and digits), text literals in double quotes (`"a b"`; `""` inside a literal is one quote character), cell references, parentheses, binary `+ - * / ^`, unary `-` and `+`, concatenation `&` and comparisons `=`, `<>`, `<`, `>`, `<=`, `>=`.
  - Precedence from highest: unary sign, then `^` (right-associative), then `*` and `/`, then `+` and `-` (left-associative), then `&` (left-associative), then comparisons, which are not chained (`=1<2<3` is `#PARSE!`). So `=-2^2` is `4` and `=2^3^2` is `512`.
  - Absolute references: a `$` before the column letter and/or the row number (`$A$1`, `A$1`, `$A1`) refers to the same cell as `A1`, also in ranges.
  - `&` turns each operand into text: a number as `GET` would print it, an empty cell as `""`, text as itself, booleans as `TRUE`/`FALSE`. An error operand gives that error.
  - Two numbers compare numerically; two texts compare exactly (case-sensitive, by character code). An empty cell is `0` against a number and `""` against text. Comparing a number with text is `#VALUE!`. The result is a boolean. A boolean used with `+ - * / ^`, unary signs or as a direct argument of `SUM`/`MIN`/`MAX` is `#VALUE!`.
  - Functions (case-insensitive) take arguments separated by commas; an argument of `SUM`, `MIN`, `MAX` or `COUNT` is an expression or a range `A1:B3` (any two corners, inclusive).
  - `SUM`, `MIN`, `MAX` ignore empty, text and boolean cells inside ranges; a text value passed directly as an argument is `#VALUE!`. `MIN` and `MAX` over no numbers are `0`.
  - `COUNT` counts numeric values: inside ranges it counts numbers and ignores empty, text, boolean and error cells; a direct error argument gives that error; direct text or boolean arguments are not counted.
  - `COUNTIF(range, criterion)` counts the range's cells that match the criterion; `SUMIF(range, criterion)` adds its matching numeric cells. Exactly two arguments, the first a range (or `#REF!`, which gives `#REF!`), the second an expression that is not a range; otherwise `#PARSE!`. An error criterion gives that error; error cells in the range never match. A number criterion matches equal numeric cells, a boolean matches equal boolean cells, an empty cell or empty text matches empty cells. Text may start with an operator (`<=`, `>=`, `<>`, `<`, `>`, `=`, the longest that fits; none means `=`) followed by an operand. A number operand: `=` matches equal numeric cells, `<`, `>`, `<=`, `>=` compare numeric cells only, `<>` matches every cell that is not an equal number. An empty operand: `=` matches empty cells, `<>` every non-empty cell, the others nothing. A text operand: `=` matches text cells equal to it ignoring case, with `*` for any run of characters, `?` for one character, and `~` before `*`, `?` or `~` making it literal; `<>` matches every cell `=` would not; `<`, `>`, `<=`, `>=` compare text cells only, lower-cased, by character code, without wildcards.
  - `IF(condition, then, else)` takes exactly three arguments (otherwise `#PARSE!`). The condition must be a boolean or a number (non-zero is true; an empty cell is false); text is `#VALUE!` and an error gives that error. Only the chosen branch is evaluated.
  - An empty cell counts as `0`. A formula that is just a reference (`=A1`) takes the referenced value, including text; text used with any operator or sign is `#VALUE!`.
  - Spaces are allowed between tokens.
- Errors:
  - Division by zero is `#DIV/0!`.
  - A reference to a cell outside `A1`–`Z99` (for example `AA1` or `A100`) is `#REF!`.
  - A formula that cannot be parsed, or uses an unknown function, is `#PARSE!`.
  - Every cell whose formula is part of a reference cycle is `#CYCLE!`; cycles are found from every reference in a formula, including `IF` branches not taken. A cell that depends on an error cell takes that error; if several operands are errors, the first one in left-to-right order in the formula wins, and inside a range the first in row order (row by row, left to right within a row).
- Values always reflect the current contents of all cells: changing a cell updates every cell that depends on it, and removing a cycle removes the `#CYCLE!` results.
