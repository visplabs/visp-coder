"""Reviewer probes for spreadsheet-extend: contract rules the hidden checks leave untested.

Usage: probes.py <project_dir> [--only id,id] [--list]

Every probe quotes the clause of task.md (or the README the request points to) that it tests.
None is grounded in one run's implementation. They are scored apart from the hidden checks.
Groups are explained in bench/probekit.py. Cases the request leaves open are not probed; the
ones considered are listed at the end of this file.

Each case is (id, clause, commands, expected). An expected line is a string, or a tuple of
strings when the contract allows several answers (any error code for an input whose error the
README does not name).
"""
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
import probekit  # noqa: E402

REG = probekit.Registry()
ROOT = None
ERRORS = ("#DIV/0!", "#VALUE!", "#REF!", "#CYCLE!", "#PARSE!")

TEXT = 'A formula may contain a text literal in double quotes (`"a b"`; `""` inside a literal is one quote character).'
CONCAT = "`&` concatenates: it has lower precedence than `+` and `-`, and is left-associative."
OPERANDS = 'Each operand becomes text: a number as `GET` would print it, an empty cell as `""`, text as itself, `TRUE`/`FALSE` as those words. An error operand gives that error (the first in left-to-right order).'
PRINTS = 'A formula whose value is text prints as that text; `=""` prints an empty line.'
CMP = "`=`, `<>`, `<`, `>`, `<=`, `>=` have the lowest precedence of all operators and are not chained (`=1<2<3` is `#PARSE!`)."
CMP_TYPES = "Two numbers compare numerically; two texts compare exactly (case-sensitive, by character code). An empty cell is `0` against a number and `\"\"` against text. Comparing a number with text is `#VALUE!`. The result is a boolean that prints as `TRUE` or `FALSE`."
BOOL = "A boolean used with `+ - * / ^`, unary signs or inside `SUM`/`MIN`/`MAX` arguments is `#VALUE!`; booleans inside ranges are ignored by those functions."
IF_ARGS = "`IF(condition, then, else)`: exactly three arguments, otherwise `#PARSE!`."
IF_COND = "The condition must be a boolean or a number (non-zero is true); text is `#VALUE!` and an error condition gives that error."
IF_LAZY = "Only the chosen branch is evaluated, so an error in the other branch does not matter."
IF_CYCLE = "Reference cycles are still found from every reference in the formula, including branches not taken."
COUNT = "`COUNT(...)`: the number of numeric values. Inside ranges it counts numbers and ignores empty, text, boolean and error cells. A direct argument that is an error gives that error; a direct text or boolean argument is not counted."
ABS = "Absolute references: a `$` before the column letter and/or the row number (`$A$1`, `A$1`, `$A1`) refers to the same cell as `A1` and also works in ranges."
COPY = "`COPY <from> <to>`: copies the raw content of one cell to another (copying an empty cell clears the target). In a formula every reference part without `$` moves by the distance from `<from>` to `<to>` (columns and rows separately); parts with `$` stay."
COPY_REF = "A reference moved outside `A1`-`Z99` becomes the text `#REF!` in the formula."
COPY_ERR = "Invalid cell names print `ERROR`. README: Any other line ... prints `ERROR` and changes nothing."
FORMULA = "`FORMULA <cell>` prints the cell's raw content (an empty line for an empty cell). For content set with `SET` it prints what was set; for content produced by `COPY` it prints the moved formula, with every reference written as upper-case letters, keeping `$` signs, and all other text unchanged."
ARGS = "README: Functions `SUM`, `MIN`, `MAX` take one or more arguments ...; a text value passed directly as an argument is `#VALUE!`; text used with any operator or sign is `#VALUE!`."
ONE_LINE = "README: writes one output line for every `GET` and for every invalid command. Errors print as their code."


def run(commands):
    completed = subprocess.run(["./run.sh"], cwd=ROOT, input="\n".join(commands) + "\n", capture_output=True,
                               text=True, timeout=30, env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
    if completed.returncode != 0:
        tail = completed.stderr.strip().splitlines()[-1:] or [""]
        raise RuntimeError(f"exit {completed.returncode}: {tail[0]}")
    return completed.stdout.split("\n")[:-1] if completed.stdout.endswith("\n") else completed.stdout.split("\n")


def matches(actual, expected):
    return actual in expected if isinstance(expected, tuple) else actual == expected


def case(pid, clause, commands, expected, group="request", finding=None):
    def probe():
        actual = run(commands)
        ok = len(actual) == len(expected) and all(matches(a, e) for a, e in zip(actual, expected))
        return ok, {"expected": expected, "actual": actual[:30]}

    REG.case(pid, clause, probe, group, finding)


def sets(*cells):
    return [f"SET {cell} {content}" for cell, content in cells]


def gets(*cells):
    return [f"GET {cell}" for cell in cells]


def formulas(*lines, prefix="SET A"):
    """SET A1..An to the formulas, then GET each: returns (commands, ())."""
    commands = [f"{prefix}{i} {line}" for i, line in enumerate(lines, 1)]
    return commands + [f"GET A{i}" for i in range(1, len(lines) + 1)]


def eval_case(pid, clause, formula_list, expected, setup=(), group="request", finding=None):
    """Each formula is set in its own cell A1..An (after `setup` commands), then read."""
    commands = list(setup) + formulas(*formula_list)
    case(pid, clause, commands, expected, group, finding)


# --- Text literals and concatenation. -----------------------------------------------------------

eval_case("text-literal-special-characters", TEXT,
          ['="a&b"', '="1+2"', '="x,y(z):"', '="<>="', '="a b  c"'], ["a&b", "1+2", "x,y(z):", "<>=", "a b  c"])
eval_case("text-literal-looks-like-reference", TEXT + " " + PRINTS,
          ['="A1"', '="$A$1"', '="SUM(1)"', '="=1"'], ["A1", "$A$1", "SUM(1)", "=1"], setup=["SET B1 5"])
eval_case("text-literal-quote-edges", TEXT, ['=""""', '="a"""', '=""""""', '="""a"""&"b"'],['"', 'a"', '""', '"a"b'])
eval_case("text-concat-numbers-print-as-get",
          OPERANDS, ['=1/3&""', '=2.50&"x"', '=-0&"a"', '=2^40&""', '=0.1+0.2&""', '=B1&"|"', '=1/8&"|"&B2'],
          ["0.333333", "2.5x", "0a", "1099511627776", "0.3", "2.5|", "0.125|hello world"],
          setup=["SET B1 2.50", "SET B2 hello world"])
eval_case("text-concat-booleans-and-empty", OPERANDS,
          ['=(1>2)&"|"&(1<2)', '=C9&"x"&D9', '=C9&D9', '=(2=2)&(2<>2)'], ["FALSE|TRUE", "x", "", "TRUEFALSE"])
eval_case("text-concat-lower-than-plus-minus", CONCAT,
          ["=1+1&2+2", '=10-4&"x"', "=2*3&4", "=-1&-1", '="a"&+2', '=2^2&"x"'], ["24", "6x", "64", "-1-1", "a2", "4x"])
eval_case("text-concat-errors", OPERANDS,
          ['=(1+"a")&"y"', '=AA1&1/0&"x"', '="x"&B1&B1', '=B1&AA1', '=B2&1/0'], ["#VALUE!", "#REF!", "#DIV/0!", "#DIV/0!", "#REF!"],
          setup=["SET B1 =1/0", "SET B2 =AA1"])
eval_case("text-formula-result-flows-through-references", PRINTS,
          ['="x"', '=A1&A1', '=A2&"y"&A1'], ["x", "xx", "xxyx"])
case("text-empty-values-print-empty-lines", PRINTS,
     ["SET A1 =\"\"", "SET A2 =\"\"&\"\"", "SET A3 =B9&\"\"", "SET A4 =IF(1,\"\",\"x\")", "GET A1", "GET A2", "GET A3", "GET A4", "SET A5 7", "GET A5"],
     ["", "", "", "", "7"])
eval_case("text-malformed-literals-are-parse-errors", "README: A formula that cannot be parsed ... is `#PARSE!`. " + TEXT,
          ['="abc', '="a"&"b', '="a" "b"', '="a"&', '=&"a"', '="a"b"'], ["#PARSE!"] * 6)
eval_case("text-literal-as-direct-function-argument", ARGS,
          ['=SUM("5")', '=MAX(1,"a")', '=MIN("")', '=SUM(1,2,"3")'], ["#VALUE!"] * 4)
eval_case("text-literal-with-operators", ARGS,
          ['="5"+1', '=-"a"', '="3"*"4"', '=2^"a"', '=+"a"'], ["#VALUE!"] * 5)

# --- Comparisons. -------------------------------------------------------------------------------

eval_case("cmp-every-operator-on-numbers", CMP,
          ["=2>=2", "=2>=3", "=3<>3", "=3<>4", "=3=3", "=3>2", "=2>3", "=2<=1", "=1<=1"],
          ["TRUE", "FALSE", "FALSE", "TRUE", "TRUE", "TRUE", "FALSE", "FALSE", "TRUE"])
eval_case("cmp-every-operator-on-text", CMP + " " + CMP_TYPES,
          ['="a"<"b"', '="a"<="a"', '="b">="a"', '="a"<>"a"', '="a"<>"b"', '="a">"b"', '="a"="a"', '="a"<"a"'],
          ["TRUE", "TRUE", "TRUE", "FALSE", "TRUE", "FALSE", "TRUE", "FALSE"])
eval_case("cmp-text-by-character-code", CMP_TYPES,
          ['="a"<"B"', '="Z"<"a"', '="abc"<"abd"', '="ab"<"abc"', '=""<"a"', '="10"<"9"', '="a"="A"', '="a">""'],
          ["FALSE", "TRUE", "TRUE", "TRUE", "TRUE", "TRUE", "FALSE", "TRUE"])
eval_case("cmp-empty-cell-against-number", CMP_TYPES,
          ["=C1<1", "=C1>-1", "=C1<>0", "=C1>=0", "=C1<=0", "=1>C1", "=C1=0"], ["TRUE", "TRUE", "FALSE", "TRUE", "TRUE", "TRUE", "TRUE"])
eval_case("cmp-empty-cell-against-text", CMP_TYPES,
          ['=C1<"a"', '=C1<>""', '="a">C1', '=C1=""', '="">=C1'], ["TRUE", "FALSE", "TRUE", "TRUE", "TRUE"])
eval_case("cmp-number-against-text-is-value-error", CMP_TYPES,
          ['=1="1"', '=1<>"a"', '="a"<1', "=B1=B2", "=B2>1", '=B1<>"x"'], ["#VALUE!", "#VALUE!", "#VALUE!", "#VALUE!", "#VALUE!", "#VALUE!"],
          setup=["SET B1 5", "SET B2 x"])
eval_case("cmp-not-chained", CMP, ["=1<2<3", "=1=1=1", "=1<>2<>3", "=1<2>0", '="a"="a"="a"'], ["#PARSE!"] * 5)
eval_case("cmp-error-operands", "README: A cell that depends on an error cell takes that error; if several operands are errors, the first one in left-to-right order in the formula wins. " + CMP,
          ["=1/0=1", "=AA1<1", "=1<>1/0", "=AA1=1/0", "=1/0=AA1", "=1=B1"], ["#DIV/0!", "#REF!", "#DIV/0!", "#REF!", "#DIV/0!", "#DIV/0!"],
          setup=["SET B1 =1/0"])
eval_case("cmp-error-beats-type-mismatch", "README: A cell that depends on an error cell takes that error. " + CMP_TYPES,
          ['=1/0="a"', '="a"=1/0', "=AA1<>B2"], ["#DIV/0!", "#DIV/0!", "#REF!"], setup=["SET B2 text"])
eval_case("cmp-lowest-precedence", CMP,
          ["=2*3>5", "=1<2+3", "=2^2=4", "=-1<0", "=1+1<>2", '="a"="a"&""', '="ab"="a"&"b"', "=10-4=3+3"],
          ["TRUE", "TRUE", "TRUE", "TRUE", "FALSE", "TRUE", "TRUE", "TRUE"])
eval_case("cmp-spaces-between-tokens", "README: Spaces are allowed between tokens. " + CMP,
          ["= 1 <= 2", "=1 <> 2", '= "a" = "a"', "=  3  >  2", "=1 >= 1"], ["TRUE", "TRUE", "TRUE", "TRUE", "TRUE"])
eval_case("cmp-booleans-in-arithmetic", BOOL,
          ["=B1-1", "=B1*2", "=B1/1", "=B1^2", "=2^B1", "=+B1", "=1+B1", "=B1+B1", "=-(1<2)", "=(1<2)*3"], ["#VALUE!"] * 10,
          setup=["SET B1 =1<2"])
eval_case("cmp-booleans-in-function-arguments", BOOL,
          ["=MIN(B1)", "=MAX(B1,2)", "=SUM(1,B1)", "=SUM(1<2)", "=MAX(2>1)", "=MIN(1,2,B1)"], ["#VALUE!"] * 6,
          setup=["SET B1 =1<2"])
eval_case("cmp-booleans-ignored-in-ranges", BOOL + " README: `MIN` and `MAX` over no numbers are `0`.",
          ["=SUM(B1:B3)", "=MIN(B1:B3)", "=MAX(B1:B3)", "=SUM(B1:B2)", "=MIN(B1:B2)", "=MAX(B1:B2)", "=SUM(B2:B1,B3)"],
          ["5", "5", "5", "0", "0", "0", "5"], setup=["SET B1 =1<2", "SET B2 =1>2", "SET B3 5"])
eval_case("cmp-boolean-cells-print", CMP_TYPES,
          ["=B1", "=B2", "=B1&B2", '=IF(B1,B1,B2)'], ["TRUE", "FALSE", "TRUEFALSE", "TRUE"], setup=["SET B1 =1<2", "SET B2 =1>2"])
eval_case("cmp-sum-of-empty-range", "Two numbers compare numerically. " + CMP_TYPES + " README: They ignore empty and text cells inside ranges.",
          ["=SUM(B1:B2)=0", "=SUM(B1:B2)<1", "=-SUM(B1:B2)=0", '=IF(SUM(B1:B2)=0,"empty","x")', "=SUM(B1:B2)>=0", "=SUM(B1:B2)<>0", "=SUM(B1:B2)=B3", "=0=SUM(B1:B2)"],
          ["TRUE", "TRUE", "TRUE", "empty", "TRUE", "FALSE", "TRUE", "TRUE"], group="request", finding="sum-empty")
eval_case("cmp-min-max-count-of-empty-range", "Two numbers compare numerically. README: `MIN` and `MAX` over no numbers are `0`. " + COUNT,
          ["=MIN(B1:B2)=0", "=MAX(B1:B2)=0", "=COUNT(B1:B2)=0", "=MIN(B1:B2)<1", "=MAX(B1:B2)>=0", "=COUNT(B1:B2)<=0"], ["TRUE"] * 6, finding=None)
eval_case("cmp-sum-of-text-range", "Two numbers compare numerically. README: They ignore empty and text cells inside ranges.",
          ["=SUM(C1:C2)=0", "=SUM(C1:C2)<1", '=IF(SUM(C1:C2)=0,"none","some")'], ["TRUE", "TRUE", "none"], setup=["SET C1 a", "SET C2 b"])
eval_case("cmp-integer-and-fraction-results-compare", "Two numbers compare numerically.",
          ["=SUM(B1:B2)=7", "=SUM(B1:B2)=7.0", "=SUM(B1,B2)=7", "=B1+B2=7.0", "=B1=3.0", "=B1*2=6", "=B1/1=3", "=MAX(B1:B2)=4",
           "=MIN(B1:B2)=3.0", "=COUNT(B1:B2)=2", "=COUNT(B1:B2)=2.0", "=COUNT(B1:B2)<2.5", "=-0=0", "=2/2=1", "=4/2=2", "=B2-B1=1"],
          ["TRUE"] * 16, setup=["SET B1 3", "SET B2 4"])

# --- IF. ------------------------------------------------------------------------------------------

eval_case("if-argument-count", IF_ARGS + " README: a function argument is an expression.",
          ["=IF()", "=IF(1)", "=IF(1,2,)", "=IF(1,,3)", "=IF(,2,3)", "=IF(1,2,3,)", "=IF(1,2,3,4,5)"], ["#PARSE!"] * 7)
eval_case("if-nested-and-as-operand", "`IF(condition, then, else)` is a formula value like any other.",
          ['=IF(1<2,IF(0,"a","b"),"c")', "=IF(1,2,3)+1", '=IF(1<2,"a","b")&"!"', "=IF(1,2,3)*IF(0,5,6)", '=IF(IF(1,0,1),"y","n")', "=IF(1,2,3)>IF(0,5,1)"],
          ["b", "3", "a!", "12", "n", "TRUE"])
eval_case("if-condition-kinds", IF_COND,
          ['=IF(0.5,"t","f")', '=IF(-0,"t","f")', '=IF(1<2,"t","f")', '=IF("a","t","f")', '=IF(1/0,"t","f")', '=IF(AA1,"t","f")', '=IF("","t","f")', '=IF(2-2,"t","f")'],
          ["t", "f", "t", "#VALUE!", "#DIV/0!", "#REF!", "#VALUE!", "f"])
eval_case("if-chosen-branch-errors", "An error in the chosen branch is the result. " + IF_LAZY,
          ["=IF(1,1/0,2)", "=IF(0,2,AA1)", '=IF(1,"a"+1,2)', "=IF(1,B1,2)"], ["#DIV/0!", "#REF!", "#VALUE!", "#DIV/0!"], setup=["SET B1 =1/0"])
eval_case("if-untaken-branch-ignored", IF_LAZY,
          ["=IF(1,5,B1)", "=IF(0,B1,6)", '=IF(1,2,"a"+1)', "=IF(0,1/0,3)", "=IF(1,2,AA1)", "=IF(0,SUM(B1,1),4)"], ["5", "6", "2", "3", "2", "4"],
          setup=["SET B1 =1/0"])
eval_case("if-unknown-function-is-parse-error", "README: A formula that cannot be parsed, or uses an unknown function, is `#PARSE!`. " + IF_ARGS,
          ["=IF(1,2,FOO(1))", "=IF(1,FOO(1),2)"], ["#PARSE!", "#PARSE!"])
eval_case("if-name-case-insensitive", "README: Functions ... (case-insensitive).", ['=if(1,"a","b")', '=If(0,"a","b")', '=iF(1<2,"a","b")'], ["a", "b", "a"])
case("if-cycle-through-untaken-branch", IF_CYCLE,
     ["SET A1 =IF(1,5,B1)", "SET B1 =A1", "SET C1 =A1", "SET D1 =IF(0,D1,2)", "SET E1 =IF(E1,1,2)", "SET A5 =IF(1,5,SUM(A4:A6))", "SET A7 =IF(1,5,COUNT(A7:A8))"]
     + gets("A1", "B1", "C1", "D1", "E1", "A5", "A7"),
     ["#CYCLE!"] * 7)
case("if-recalculates-after-untaken-branch-changes", "README: Values always reflect the current contents of all cells. " + IF_LAZY,
     ["SET A1 =IF(B1>0,C1,D1)", "SET B1 1", "SET C1 10", "SET D1 20", "GET A1", "SET B1 0", "GET A1", "SET D1 30", "GET A1", "SET B1 1", "SET C1 11",
      "GET A1", "SET D1 =1/0", "GET A1", "SET B1 0", "GET A1", "SET A1 =IF(1,5,A1)", "GET A1", "SET A1 =IF(1,5,2)", "GET A1"],
     ["10", "20", "30", "11", "11", "#DIV/0!", "#CYCLE!", "5"])

# --- COUNT. ---------------------------------------------------------------------------------------

eval_case("count-direct-arguments", COUNT,
          ["=COUNT(1,2,3)", '=COUNT("a","b",3)', "=COUNT(1<2)", '=COUNT(1,1<2,"x")', "=COUNT(1+1)", "=COUNT(1/0)", "=COUNT(1,1/0,2)", "=COUNT(AA1,1/0)", "=COUNT(B1:AA2)"],
          ["3", "1", "0", "1", "1", "#DIV/0!", "#DIV/0!", "#REF!", "#REF!"])
eval_case("count-cell-kinds-in-ranges", COUNT + " README: `.5` and `1e3` are not numbers.",
          ["=COUNT(B1:B9)", "=COUNT(B9:B1)", "=COUNT(B1:B1)", "=COUNT(B1:C9)", "=COUNT(C1:C5)", "=COUNT($B$1:B$9)"], ["3", "3", "1", "3", "0", "3"],
          setup=["SET B1 5", "SET B2 =1+1", "SET B3 text", "SET B4 =1<2", "SET B5 =\"x\"", "SET B6 =1/0", "SET B7 .5", "SET B8 1e3", "SET B9 -2.50"])
eval_case("count-in-expressions", COUNT,
          ["=COUNT(B1:B3)+1", "=COUNT(B1:B3)*2", '=COUNT(B1:B3)&"x"', '=IF(COUNT(B1:B2)=2,"full","gaps")', "=SUM(COUNT(B1:B2),1)", "=MAX(COUNT(B1:B3),0)", "=COUNT(B1:B3)>1"],
          ["3", "4", "2x", "full", "3", "2", "TRUE"], setup=["SET B1 5", "SET B2 6", "SET B3 x"])
case("count-cycle", COUNT + " " + IF_CYCLE,
     ["SET A1 =COUNT(A1:A3)", "SET A5 =COUNT(A4:A6)", "SET B1 =A1"] + gets("A1", "A5", "B1"), ["#CYCLE!"] * 3)
case("count-recalculates", "README: Values always reflect the current contents of all cells. " + COUNT,
     ["SET B1 =COUNT(A1:A3)", "GET B1", "SET A1 5", "GET B1", "SET A2 x", "GET B1", "SET A3 =A1+1", "GET B1", "CLEAR A1", "GET B1", "SET A2 =1<2", "GET B1"],
     ["0", "1", "1", "2", "1", "1"])

# --- Absolute references. ---------------------------------------------------------------------------

case("abs-ranges", ABS,
     ["SET A1 1", "SET A2 2", "SET B1 3", "SET B2 4",
      "SET C1 =SUM($A$1:$B$2)", "SET C2 =SUM($A1:B$2)", "SET C3 =SUM(A$1:$B2)", "SET C4 =SUM($B$2:$A$1)", "SET C5 =SUM($a$1:$b$2)",
      "SET C6 =COUNT($A$1:$B$2)", "SET C7 =MAX($A$1,$B2)", "SET C8 =$A$1+$a2", "SET C9 =$B$2-A$1"]
     + gets("C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9"),
     ["10", "10", "10", "10", "10", "4", "4", "3", "3"])
eval_case("abs-out-of-range", ABS + " README: A reference to a cell outside `A1`-`Z99` is `#REF!`.",
          ["=$AA$1", "=$A$100", "=A$0", "=$AA1+1", "=SUM($A$1:$A$100)", "=$A$0"], ["#REF!"] * 6)
case("abs-cycles", ABS + " README: Every cell whose formula is part of a reference cycle is `#CYCLE!`.",
     ["SET A1 =$A$1+1", "SET B1 =SUM($A1:$B$2)", "SET C1 =B$1"] + gets("A1", "B1", "C1"), ["#CYCLE!"] * 3)
case("abs-recalculates", ABS + " README: Values always reflect the current contents of all cells.",
     ["SET A1 =$B$1", "SET B1 4", "GET A1", "SET B1 5", "GET A1", "SET C1 =A$1*2", "SET B1 6", "GET C1", "GET A1"], ["4", "5", "12", "6"])
eval_case("abs-malformed-markers-are-parse-errors", "README: A formula that cannot be parsed ... is `#PARSE!`. " + ABS,
          ["=$$A1", "=$1", "=A1$", "=$"], ["#PARSE!"] * 4)

# --- COPY and FORMULA. ----------------------------------------------------------------------------------

case("copy-moves-columns-only", COPY, ["SET A1 =B1+SUM(B2:B3)", "COPY A1 C1", "FORMULA C1"], ["=D1+SUM(D2:D3)"])
case("copy-moves-rows-only", COPY, ["SET A1 =A2*B2", "COPY A1 A5", "FORMULA A5"], ["=A6*B6"])
case("copy-moves-up-and-left", COPY, ["SET D5 =E6+F7", "COPY D5 B2", "FORMULA B2"], ["=C3+D4"])
case("copy-each-dollar-part", COPY, ["SET E5 =$A1+A$1+$A$1+A1", "COPY E5 G8", "FORMULA G8"], ["=$A4+C$1+$A$1+C4"])
case("copy-to-itself", COPY, ["SET A1 =B1+1", "COPY A1 A1", "FORMULA A1", "GET A1"], ["=B1+1", "1"])
case("copy-of-a-copy-accumulates", COPY, ["SET A1 =B1", "COPY A1 A2", "COPY A2 A3", "COPY A3 C3", "FORMULA A3", "FORMULA C3"], ["=B3", "=D3"])
case("copy-keeps-spacing-and-function-names", FORMULA,
     ["SET A1 =sum( b1:b2 ) +  c1", "COPY A1 A2", "FORMULA A2", "SET B5 =if( a1 > 0 , \"x\" , b1 )", "COPY B5 B6", "FORMULA B6", "SET C1 = 1 + A1", "COPY C1 C2", "FORMULA C2"],
     ["=sum( B2:B3 ) +  C2", "=if( A2 > 0 , \"x\" , B2 )", "= 1 + A2"])
case("copy-leaves-text-literals-alone", FORMULA + " " + TEXT,
     ["SET A1 =B1&\"A1 \"\"C3\"\" $B$2\"&C1", "COPY A1 A2", "FORMULA A2"], ["=B2&\"A1 \"\"C3\"\" $B$2\"&C2"])
case("copy-out-of-range-each-edge", COPY_REF,
     ["SET Y5 =Z5", "COPY Y5 Z5", "FORMULA Z5", "SET B5 =A5", "COPY B5 A5", "FORMULA A5", "SET C2 =A1", "COPY C2 C1", "FORMULA C1",
      "SET C98 =A99", "COPY C98 C99", "FORMULA C99", "SET D2 =A1+B2", "COPY D2 D1", "FORMULA D1"],
     ["=#REF!", "=#REF!", "=#REF!", "=#REF!", "=#REF!+B1"])
case("copy-dollar-parts-do-not-leave-the-grid", COPY + " " + COPY_REF,
     ["SET B2 =$A1+A$1", "COPY B2 B1", "FORMULA B1", "SET E5 =$A$1+A$1", "COPY E5 E50", "FORMULA E50"], ["=#REF!+A$1", "=$A$1+A$1"])
case("copy-is-a-snapshot", COPY + " README: Values always reflect the current contents of all cells.",
     ["SET A1 =B1", "COPY A1 A2", "SET A1 =C1", "FORMULA A2", "SET B2 7", "GET A2"], ["=B2", "7"])
case("copy-overwrites-and-clears-target", COPY,
     ["SET A1 5", "SET B1 =A1*2", "SET D1 =B1+1", "COPY C9 B1", "GET B1", "GET D1", "COPY A1 B1", "GET B1", "FORMULA B1", "GET D1"],
     ["", "1", "5", "5", "6"])
case("copy-lowercase-source", COPY + " " + FORMULA,
     ["SET A1 =b1+c1", "COPY A1 A2", "FORMULA A2", "FORMULA A1"], ["=B2+C2", "=b1+c1"])
case("copy-invalid-changes-nothing", COPY_ERR,
     ["SET A1 5", "SET B1 6", "COPY A1 AA1", "COPY AA1 B1", "COPY A1", "COPY A1 B1 C1", "COPY A100 B1", "COPY A1 B0", "COPY", "GET A1", "GET B1"],
     ["ERROR"] * 7 + ["5", "6"])
case("copy-and-formula-keywords-case-insensitive", "README: keywords are case-insensitive. " + COPY + " " + FORMULA,
     ["set a1 =b1", "copy a1 c3", "formula c3", "Formula A1", "FoRmUlA a1"], ["=D3", "=b1", "=b1"])
case("copy-prints-nothing-on-success", ONE_LINE, ["SET A1 1", "COPY A1 B1", "COPY C1 B1", "COPY B1 B1", "GET A1"], ["1"])
case("formula-prints-raw-content", FORMULA,
     ["SET A1 2.50", "SET A2 =A1+ 1", "SET A3 Hello  World", "SET A4 +4", "SET A5 7", "CLEAR A5", "FORMULA A1", "FORMULA A2", "FORMULA A3", "FORMULA A4", "FORMULA A5", "FORMULA A6"],
     ["2.50", "=A1+ 1", "Hello  World", "+4", "", ""])
case("formula-invalid-forms", "README: Any other line, a `SET`/`GET`/`CLEAR` with a missing or invalid cell name, prints `ERROR` and changes nothing. " + FORMULA,
     ["FORMULA", "FORMULA A1 extra", "FORMULA A100", "FORMULA 1A", "FORMULA AA1"], ["ERROR"] * 5)
case("formula-does-not-change-the-sheet", FORMULA, ["SET A1 =B1+1", "SET B1 4", "FORMULA A1", "FORMULA B1", "GET A1", "GET B1"], ["=B1+1", "4", "5", "4"])

# --- The `^` operator: not changed by the request, crashes in the starting engine. -------------

POW = ("README: Errors print as their code; the CLI writes one output line for every `GET`. The request says "
       "`Extend it without changing any existing behavior`, and the starting engine already crashes on these inputs.")
SENTINEL = ["SET Z9 5", "GET Z9"]


def crash_case(pid, formulas_in, expected, finding="pow-crash", clause=POW):
    commands = [f"SET A{i} {f}" for i, f in enumerate(formulas_in, 1)] + gets(*[f"A{i}" for i in range(1, len(formulas_in) + 1)]) + SENTINEL
    case(pid, clause, commands, expected + ["5"], "refgap", finding)


crash_case("pow-zero-to-negative-power", ["=0^-1", "=0^(0-2)", "=0^-0.5"], [("#DIV/0!", "#VALUE!")] * 3)
crash_case("pow-negative-base-fractional-power", ["=(-8)^0.5", "=(-8)^(1/3)", "=(0-2)^1.5"], [ERRORS] * 3)
crash_case("pow-crash-inside-new-features", ['="x"&(-8)^0.5', "=IF(0^-1,1,2)", "=0^-1=1", "=COUNT(0^-1)", "=SUM(0^-1,1)", '=IF(1,"ok",(-8)^0.5)'],
           [ERRORS, ERRORS, ERRORS, ERRORS, ERRORS, "ok"], clause=POW + " " + OPERANDS)
def p_overflow():
    commands = ["SET A1 =10^400", "SET A2 =9^9^9", "SET A3 =2^1024", "GET A1", "GET A2", "GET A3"] + SENTINEL
    actual = run(commands)
    ok = len(actual) == 4 and actual[-1] == "5" and all(line and "Traceback" not in line for line in actual[:3])
    return ok, {"actual": [line[:60] for line in actual]}


REG.case("pow-overflow-keeps-the-session-alive", POW, p_overflow, "refgap", "pow-crash")


def p_reference_untouched():
    actual = run(["SET A1 =2^3", "SET A2 =(-2)^3", "SET A3 =2^-1", "SET A4 =0^0", "SET A5 =4^0.5", "GET A1", "GET A2", "GET A3", "GET A4", "GET A5"])
    return actual == ["8", "-8", "0.5", "1", "2"], actual


REG.case("pow-ordinary-values-unchanged", "README: precedence from highest ... `^` (right-associative); `=2^3^2` is `512`", p_reference_untouched)


def main():
    global ROOT
    args = sys.argv[1:]
    if "--list" in args:
        print("\n".join(probekit.listing(REG.probes)))
        return
    only = set(args[args.index("--only") + 1].split(",")) if "--only" in args else None
    ROOT = Path(args[0]).resolve()
    if not (ROOT / "run.sh").exists():
        probekit.emit([{"name": "run.sh exists", "passed": False, "detail": "missing", "group": "request",
                        "finding": None, "clause": ""}])
        return
    probekit.emit(probekit.execute(REG.probes, only))


# Considered and left out, because task.md and the README leave the answer open:
# - a boolean compared with a boolean or a number (only number/text/empty are specified);
# - an empty cell compared with an empty cell;
# - `COUNT()` with no arguments, and a direct reference to an empty cell as a `COUNT` argument;
# - how a range with one corner moved off the grid prints after `COPY` (one `#REF!` or two);
# - what `GET` prints for a formula that holds the text `#REF!` after `COPY`;
# - `0.1+0.2=0.3` (floating point against "compare numerically");
# - the exact error code of `0^-1` (`#DIV/0!` is natural, the README does not say) and of `(-8)^0.5`;
# - non-ASCII text literals, and the length limit of a text literal.
if __name__ == "__main__":
    main()
