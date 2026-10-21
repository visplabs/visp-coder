The spreadsheet engine in this repository should be able to build labels in formulas:

- Text literals in double quotes, such as `="Total: "`. Two double quotes inside a literal stand for one quote character.
- `&` joins two values into text. A number joins the way `GET` prints it, an empty cell as nothing, `TRUE` and `FALSE` as those words, and an error operand makes the result that error. `&` binds more loosely than `+` and `-` and more tightly than comparisons, so `=1+2&"x"` is `3x`.
- `LEN(value)` is the number of characters in the value, taken as text the way `&` takes it.

A formula whose value is text prints as that text. Add tests and update the README.
