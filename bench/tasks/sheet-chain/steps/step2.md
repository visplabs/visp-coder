Next request for the spreadsheet engine in this repository: users want conditions in formulas.

- Comparisons `=`, `<>`, `<`, `>`, `<=` and `>=` compare two numbers and give `TRUE` or `FALSE`, which is how `GET` prints them. They bind more loosely than every other operator (`=1+1=2` is `TRUE`), and they don't chain: `=1<2<3` is `#PARSE!`. An empty cell compares as 0. Comparing text is `#VALUE!`.
- `IF(condition, then, else)` takes exactly three arguments; any other number is `#PARSE!`. A condition that is a non-zero number or `TRUE` picks `then`. A text condition is `#VALUE!`, and an error in the condition is the result. Only the chosen branch is evaluated, so `=IF(1, 5, 1/0)` is 5.
- `TRUE` and `FALSE` are not numbers: using one in arithmetic or with a sign, or passing one directly to a function that adds or compares numbers, is `#VALUE!`. Functions skip them inside ranges, as they skip text.

Please add tests and update the README.
