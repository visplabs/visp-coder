"""Hidden tests for the spreadsheet audit: two checks per deviation the start code has from its README, plus regression. Usage: hidden_test.py <project_dir>"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(sys.argv[1]).resolve()
RESULTS = []

# (name, commands, expected output lines). Expected values follow the README contract of the start
# code; they were written by hand and cross-checked against bench/reference/spreadsheet-audit.
# Each "fix:" pair targets one place where the start code deviates from that contract.
CASES = [
    # Behaviour the start code already gets right and a fix must not break.
    ("precedence", ["SET A1 =2+3*4", "SET A2 =(2+3)*4", "SET A3 =10-4-3", "SET A4 =12/3/2", "GET A1", "GET A2", "GET A3", "GET A4"], ["14", "20", "3", "2"]),
    ("unary binds tighter than power", ["SET A1 =-2^2", "SET A2 =-(2^2)", "SET A3 =2*-3", "GET A1", "GET A2", "GET A3"], ["4", "-4", "-6"]),
    ("sum range", ["SET A1 1", "SET A2 2", "SET B1 3", "SET B2 x", "SET C1 =SUM(A1:B2)", "GET C1"], ["6"]),
    ("cycle members and dependents", ["SET A1 =B1", "SET B1 =C1+1", "SET C1 =A1", "SET D1 =A1*2", "SET E1 5", "GET A1", "GET B1", "GET C1", "GET D1", "GET E1"], ["#CYCLE!", "#CYCLE!", "#CYCLE!", "#CYCLE!", "5"]),
    ("recalculation", ["SET A1 1", "SET A2 =A1*10", "SET A3 =A2+A1", "GET A3", "SET A1 2", "GET A3", "CLEAR A1", "GET A3"], ["11", "22", "0"]),
    ("invalid commands", ["HELLO", "GET", "GET AA1", "SET A100 5", "CLEAR", "GET A1 extra", "SET A1 1", "GET A1"], ["ERROR", "ERROR", "ERROR", "ERROR", "ERROR", "ERROR", "1"]),
    ("if evaluates one branch", ["SET A1 =IF(1<2, 7, 1/0)", "SET A2 =IF(1>2, AA1, 3)", "GET A1", "GET A2"], ["7", "3"]),
    ("copy moves relative parts", ["SET A1 1", "SET A2 2", "SET B1 =A1*10", "COPY B1 B2", "GET B2", "FORMULA B2"], ["20", "=A2*10"]),
    ("insert rewrites references", ["SET A1 1", "SET A2 2", "SET B5 =A1+A2*10", "INSERTROW 2", "GET B6", "FORMULA B6"], ["21", "=A1+A3*10"]),
    ("delete rewrites references below", ["SET A3 3", "SET B1 =A3*2", "DELETEROW 2", "FORMULA B1", "GET B1"], ["=A2*2", "6"]),
    ("comparison criteria", ["SET A1 1", "SET A2 5", "SET A3 10", "SET A4 x", "SET B1 =COUNTIF(A1:A4,\">=5\")", "SET B2 =SUMIF(A1:A4,\"<5\")", "GET B1", "GET B2"], ["2", "1"]),
    ("text criterion with a star", ["SET A1 apple", "SET A2 ample", "SET A3 ap", "SET B1 =COUNTIF(A1:A3,\"a*e\")", "GET B1"], ["2"]),
    # Negative zero prints 0.
    ("fix: negative zero from arithmetic", ["SET A1 =0*-5", "GET A1"], ["0"]),
    ("fix: negative zero from a negated sum", ["SET A1 -2", "SET A2 2", "SET A3 =-SUM(A1:A2)", "GET A3"], ["0"]),
    # ^ is right-associative.
    ("fix: power is right-associative", ["SET A1 =2^3^2", "GET A1"], ["512"]),
    ("fix: chained powers", ["SET A1 =2^1^3", "SET A2 =4^0.5^2", "GET A1", "GET A2"], ["2", "1.414214"]),
    # Inside a range the first error in row order wins.
    ("fix: range error in row order", ["SET B1 =1/0", "SET A2 =AA1", "SET C1 =SUM(A1:B2)", "GET C1"], ["#DIV/0!"]),
    ("fix: range error in row order for MAX and MIN", ["SET B2 =AA1", "SET A3 =1/0", "SET C1 =MAX(A1:B3)", "SET C2 =MIN(B3:A1)", "GET C1", "GET C2"], ["#REF!", "#REF!"]),
    # COUNT ignores booleans.
    ("fix: COUNT ignores booleans in a range", ["SET A1 =1<2", "SET A2 3", "SET B1 =COUNT(A1:A2)", "GET B1"], ["1"]),
    ("fix: COUNT with booleans and text", ["SET A1 =1=1", "SET A2 =2>1", "SET A3 x", "SET B1 =COUNT(A1:A3, 5)", "GET B1"], ["1"]),
    # COPY keeps a $ row.
    ("fix: copy keeps an absolute row", ["SET B2 =A$1*2", "COPY B2 C5", "FORMULA C5"], ["=B$1*2"]),
    ("fix: copy keeps an absolute row in a range", ["SET A1 7", "SET B2 =SUM(A$1:A$1)", "COPY B2 B9", "GET B9", "FORMULA B9"], ["7", "=SUM(A$1:A$1)"]),
    # .5 and 5. are text.
    ("fix: leading dot is text", ["SET A1 .5", "SET B1 =A1*2", "GET A1", "GET B1"], [".5", "#VALUE!"]),
    ("fix: trailing dot is text", ["SET A1 5.", "SET B1 =A1+1", "GET B1"], ["#VALUE!"]),
    # Text comparisons are case-sensitive.
    ("fix: text equality is case-sensitive", ["SET A1 =\"abc\"=\"ABC\"", "GET A1"], ["FALSE"]),
    ("fix: text order by character code", ["SET B1 Zebra", "SET A1 =B1<\"apple\"", "SET A2 =\"a\"<>\"A\"", "GET A1", "GET A2"], ["TRUE", "TRUE"]),
    # INSERTROW refuses when row 99 is used.
    ("fix: insert refused for text in row 99", ["SET C99 x", "INSERTROW 1", "GET C99"], ["ERROR", "x"]),
    ("fix: insert refused for a formula in row 99", ["SET A99 =1+1", "SET A1 5", "INSERTROW 1", "GET A1", "GET A99"], ["ERROR", "5", "2"]),
    # A range corner on a deleted row moves inside the range.
    ("fix: delete a range's bottom row", ["SET A2 2", "SET A3 3", "SET A4 4", "SET C1 =SUM(A2:A4)", "DELETEROW 4", "FORMULA C1", "GET C1"], ["=SUM(A2:A3)", "5"]),
    ("fix: delete a corner written first", ["SET A1 1", "SET A2 2", "SET A3 3", "SET C9 =SUM(A3:A1)", "DELETEROW 3", "FORMULA C8", "GET C8"], ["=SUM(A2:A1)", "3"]),
    # <> with a number matches every cell that is not that number.
    ("fix: not equal to a number counts text and empty", ["SET A1 5", "SET A2 x", "SET A4 7", "SET B1 =COUNTIF(A1:A4,\"<>5\")", "GET B1"], ["3"]),
    ("fix: not equal to a number counts booleans", ["SET A1 =1<2", "SET A2 1", "SET B1 =SUMIF(A1:A3,\"<>2\")", "SET B2 =COUNTIF(A1:A3,\"<>1\")", "GET B1", "GET B2"], ["1", "2"]),
    # ~ makes a wildcard literal.
    ("fix: tilde before a question mark", ["SET A1 what?", "SET A2 whatx", "SET B1 =COUNTIF(A1:A2,\"what~?\")", "GET B1"], ["1"]),
    ("fix: tilde before a star", ["SET A1 50%*", "SET A2 50%x", "SET B1 =COUNTIF(A1:A2,\"50%~*\")", "GET B1"], ["1"]),
    # Row commands write every reference in upper case.
    ("fix: delete upper-cases references", ["SET B1 =a1+b2", "DELETEROW 5", "FORMULA B1"], ["=A1+B2"]),
    ("fix: insert upper-cases moved references", ["SET C1 =sum(a2:a3)&\"a2\"", "INSERTROW 1", "FORMULA C2"], ["=sum(A3:A4)&\"a2\""]),
    # The first error left to right wins.
    ("fix: left operand error first", ["SET A1 =1/0", "SET A2 =AA1", "SET B1 =A2*A1", "GET B1"], ["#REF!"]),
    ("fix: left operand error before a text operand", ["SET A1 x", "SET B1 =A1-1/0", "SET B2 =(1/0)^A1", "GET B1", "GET B2"], ["#VALUE!", "#DIV/0!"]),
    # Text order criteria lower-case both sides.
    ("fix: text order criterion ignores case", ["SET A1 apple", "SET A2 Mango", "SET A3 pear", "SET B1 =COUNTIF(A1:A3,\"<M\")", "GET B1"], ["1"]),
    ("fix: text order criterion upper-case operand", ["SET A1 Kiwi", "SET A2 kiwi", "SET B1 =COUNTIF(A1:A2,\"<=KIWI\")", "GET B1"], ["2"]),
    # An empty criterion cell matches empty cells only.
    ("fix: empty criterion cell", ["SET A1 5", "SET A3 x", "SET B1 =COUNTIF(A1:A3,C1)", "GET B1"], ["1"]),
    ("fix: empty criterion cell is not zero", ["SET A1 0", "SET A2 0", "SET B1 =COUNTIF(A1:A5,Z9)", "GET B1"], ["3"]),
    # Row numbers run from 1 to 99.
    ("fix: insert row 0 is invalid", ["SET A1 1", "INSERTROW 0", "GET A1", "GET A2"], ["ERROR", "1", ""]),
    ("fix: delete row 0 is invalid", ["SET A1 1", "DELETEROW 00", "DELETEROW 0", "GET A1"], ["ERROR", "ERROR", "1"]),
    # An empty cell is "" in &.
    ("fix: empty cell concatenates as empty text", ["SET A1 =\"[\"&B1&\"]\"", "GET A1"], ["[]"]),
    ("fix: two empty cells concatenate to empty text", ["SET A1 =C5&C6", "SET A2 =A1=\"\"", "GET A1", "GET A2"], ["", "TRUE"]),
    # An empty IF condition is false.
    ("fix: empty condition is false", ["SET A1 =IF(B1, \"yes\", \"no\")", "GET A1"], ["no"]),
    ("fix: empty condition inside arithmetic", ["SET A1 =IF(C3, 1, 2)+1", "GET A1"], ["3"]),
]
def run(commands):
    completed = subprocess.run(
        ["./run.sh"], cwd=ROOT, input="\n".join(commands) + "\n", capture_output=True, text=True, timeout=30
    )
    completed.check_returncode()
    return completed.stdout.split("\n")[:-1] if completed.stdout.endswith("\n") else completed.stdout.split("\n")


def main():
    if not (ROOT / "run.sh").exists():
        RESULTS.append({"name": "run.sh exists", "passed": False, "detail": "missing"})
    else:
        for name, commands, expected in CASES:
            try:
                actual = run(commands)
                ok = actual == expected
                detail = None if ok else {"expected": expected, "actual": actual[:20]}
            except Exception as error:  # noqa: BLE001
                ok, detail = False, repr(error)
            RESULTS.append({"name": name, "passed": ok, "detail": detail})
    passed = sum(1 for r in RESULTS if r["passed"])
    print(json.dumps({"passed": passed, "total": len(RESULTS), "results": RESULTS}, indent=1))


main()
