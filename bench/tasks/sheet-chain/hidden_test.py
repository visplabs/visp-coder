"""Sheet chain oracle: hidden_test.py <project_dir> [--step 0..5].

Runs the checks of every step up to --step (default 5): step 0 is the starting contract in
start/README.md, step k the request in steps/step<k>.md. A check never relies on behaviour a
later step changes, so every earlier check stays valid after every later step: a check that
passed after its own step and fails after a later one is a regression. Each result carries its
step. Each script gets a fresh CLI process, so checks never share state.
"""
import argparse
import json
import subprocess
import time
from pathlib import Path

GRID = [f"{chr(column)}{row}" for column in range(ord("A"), ord("Z") + 1) for row in range(1, 100)]
# A1 is a number and every later cell adds 1 to the one before it, down each column.
CHAIN = [f"SET {GRID[0]} 1"] + [f"SET {cell} ={previous}+1" for previous, cell in zip(GRID, GRID[1:])]
SECONDS = 10
# Edits at the end of the chain: recomputing the whole chain after each one takes over a minute.
EDITS = 2000

# Each check is (step, name, commands, expected output lines).
CHECKS = [
    (0, "values and formatting", ["SET A1 2.50", "SET A2 hello world", "SET A3 =1/3", "GET A1", "GET A2", "GET A3", "GET A4"], ["2.5", "hello world", "0.333333", ""]),
    (0, "precedence and unary", ["SET A1 =2+3*4", "SET A2 =-2^2", "SET A3 =2^3^2", "SET A4 =(1+2)*-3", "GET A1", "GET A2", "GET A3", "GET A4"], ["14", "4", "512", "-9"]),
    (0, "number content rules", ["SET A1 .5", "SET A2 =A1+1", "SET A3 1e3", "SET A4 =0*-1", "GET A1", "GET A2", "GET A3", "GET A4"], [".5", "#VALUE!", "1e3", "0"]),
    (0, "empty and direct text", ["SET B1 text", "SET A1 =B1", "SET A2 =B1+1", "SET A3 =B2+1", "GET A1", "GET A2", "GET A3"], ["text", "#VALUE!", "1"]),
    (0, "sum reversed range", ["SET A1 2", "SET B1 4", "SET A2 text", "SET C1 =sum(B2:A1,3)", "GET C1"], ["9"]),
    (0, "min max over no numbers", ["SET A1 =MIN(B1:B3)", "SET A2 =MAX(B1:B3)", "SET A3 =MIN(4,-2,8)+MAX(4,-2,8)", "GET A1", "GET A2", "GET A3"], ["0", "0", "6"]),
    (0, "error order", ["SET A1 =AA1+1/0", "SET B1 =1/0", "SET A2 =AA1", "SET C1 =SUM(A1:B2)", "SET C2 =SUM(B1,A2)", "GET A1", "GET C1", "GET C2"], ["#REF!", "#REF!", "#DIV/0!"]),
    (0, "parse and missing arguments", ["SET A1 =BOGUS(1)", "SET A2 =SUM()", "SET A3 =1+", "SET A4 =(1", "GET A1", "GET A2", "GET A3", "GET A4"], ["#PARSE!"] * 4),
    (0, "cycles and recovery", ["SET A1 =B1", "SET B1 =A1", "SET C1 =A1+1", "GET C1", "SET B1 4", "GET C1", "GET A1"], ["#CYCLE!", "5", "4"]),
    (0, "cycle through a range", ["SET A1 =SUM(A1:A3)", "SET B1 =A1+1", "GET A1", "GET B1", "SET A1 5", "GET B1"], ["#CYCLE!", "#CYCLE!", "6"]),
    (0, "updates and clearing", ["set a1 3", "SET B1 =A1*2", "GET B1", "SET A1 5", "GET B1", "CLEAR A1", "GET B1", "SET A1 7", "SET A1 ", "GET A1"], ["6", "10", "0", ""]),
    (0, "dependents update transitively", ["SET A1 1", "SET A2 =A1*2", "SET A3 =A2+A1", "GET A3", "SET A1 4", "GET A3", "GET A2"], ["3", "12", "8"]),
    (0, "ranges see cells set later", ["SET B1 =SUM(A1:A3)", "GET B1", "SET A2 4", "GET B1", "SET A3 =A2*2", "GET B1", "CLEAR A2", "GET B1"], ["0", "4", "12", "0"]),
    (0, "a formula replaced by a number", ["SET B1 2", "SET A1 =B1", "GET A1", "SET A1 5", "SET B1 3", "GET A1", "SET A1 =B1*2", "GET A1"], ["2", "5", "6"]),
    (0, "breaking a cycle from inside", ["SET A1 =B1+1", "SET B1 =C1+1", "SET C1 =A1+1", "SET D1 =C1", "GET D1", "SET B1 1", "GET D1", "GET A1"], ["#CYCLE!", "3", "2"]),
    (0, "invalid commands", ["HELLO", "GET AA1", "GET A1 extra", "CLEAR", "SET A100 2", "GET A1"], ["ERROR"] * 5 + [""]),

    (1, "average values", ["SET A1 =AVERAGE(2,4,9)", "SET A2 =average(-2,2,6)", "SET A3 =AVERAGE(1,2)", "SET A4 =AVERAGE(1,1,2)", "GET A1", "GET A2", "GET A3", "GET A4"], ["5", "2", "1.5", "1.333333"]),
    (1, "average ranges ignore text and empty", ["SET A1 2", "SET B1 6", "SET A2 text", "SET C1 =AVERAGE(B2:A1,10)", "GET C1"], ["6"]),
    (1, "average direct text", ["SET A1 text", "SET B1 =AVERAGE(A1,2)", "GET B1"], ["#VALUE!"]),
    (1, "average over no numbers", ["SET A1 text", "SET C1 =AVERAGE(B1:B3)", "SET C2 =AVERAGE(A1:A2)", "GET C1", "GET C2"], ["#DIV/0!"] * 2),
    (1, "average propagates errors", ["SET B1 =1/0", "SET A2 =AA1", "SET C1 =AVERAGE(A1:B2)", "SET C2 =AVERAGE(AA1,1/0)", "GET C1", "GET C2"], ["#DIV/0!", "#REF!"]),
    (1, "count in ranges", ["SET A1 1", "SET A2 text", "SET A4 =2*3", "SET B1 4", "SET C1 =COUNT(A1:B4)", "SET C2 =count(B4:A1)", "GET C1", "GET C2"], ["3", "3"]),
    (1, "count direct numbers", ["SET A1 =COUNT(1,2,3)", "SET A2 =COUNT(1+1,5)", "GET A1", "GET A2"], ["3", "2"]),
    (1, "count follows updates", ["SET A1 1", "SET B1 =COUNT(A1:A3)", "GET B1", "SET A2 5", "GET B1", "CLEAR A1", "GET B1"], ["1", "2", "1"]),
    (1, "average and count follow range edits", ["SET C1 =AVERAGE(A1:B2)", "SET C2 =COUNT(A1:B2)", "SET B2 4", "GET C1", "GET C2", "SET A1 2", "GET C1", "GET C2", "CLEAR B2", "GET C1"], ["4", "1", "3", "2", "2"]),
    (1, "functions combine", ["SET A1 4", "SET A2 8", "SET B1 =AVERAGE(SUM(A1:A2),COUNT(A1:A2))", "SET B2 =COUNT(A1:A2)*AVERAGE(A1:A2)", "GET B1", "GET B2"], ["7", "12"]),

    (2, "comparisons", ["SET A1 =1<2", "SET A2 =2<=1", "SET A3 =3=3", "SET A4 =3<>3", "SET A5 =4>=4", "SET A6 =5>6", "GET A1", "GET A2", "GET A3", "GET A4", "GET A5", "GET A6"], ["TRUE", "FALSE", "TRUE", "FALSE", "TRUE", "FALSE"]),
    (2, "comparisons bind loosest", ["SET A1 =1+1=2", "SET A2 =2*3>5", "SET A3 =-1<0", "SET A4 =2^2<>4", "GET A1", "GET A2", "GET A3", "GET A4"], ["TRUE", "TRUE", "TRUE", "FALSE"]),
    (2, "comparisons in parentheses", ["SET A1 =(1<2)", "SET A2 =(1<2)+1", "GET A1", "GET A2"], ["TRUE", "#VALUE!"]),
    (2, "comparisons do not chain", ["SET A1 =1<2<3", "SET A2 =1<", "SET A3 =<1", "GET A1", "GET A2", "GET A3"], ["#PARSE!"] * 3),
    (2, "comparisons with cells and empty", ["SET A1 5", "SET B1 =A1>4", "SET B2 =C9=0", "SET B3 =C9<A1", "GET B1", "GET B2", "GET B3"], ["TRUE", "TRUE", "TRUE"]),
    (2, "comparing text", ["SET B1 abc", "SET A1 =B1>1", "SET A2 =B1=B1", "SET A3 =1<>B1", "GET A1", "GET A2", "GET A3"], ["#VALUE!"] * 3),
    (2, "comparison errors in order", ["SET A1 =AA1<1/0", "SET A2 =1/0>AA1", "GET A1", "GET A2"], ["#REF!", "#DIV/0!"]),
    (2, "if picks a branch", ["SET A1 -3", "SET B1 =IF(1,5,6)", "SET B2 =IF(0,5,6)", "SET B3 =IF(2>1,10,20)", "SET B4 =if(A1<0,1,2)", "SET B5 =IF(A1,7,8)", "GET B1", "GET B2", "GET B3", "GET B4", "GET B5"], ["5", "6", "10", "1", "7"]),
    (2, "if evaluates only the chosen branch", ["SET A1 =IF(1,5,1/0)", "SET A2 =IF(0,1/0,7)", "SET A3 =IF(1,1/0,7)", "SET A4 =IF(0,AA1,SUM(1,2))", "GET A1", "GET A2", "GET A3", "GET A4"], ["5", "7", "#DIV/0!", "3"]),
    (2, "if conditions", ["SET B1 text", "SET A1 =IF(1/0,1,2)", "SET A2 =IF(B1,1,2)", "SET A3 =IF(C9,1,2)", "GET A1", "GET A2", "GET A3"], ["#DIV/0!", "#VALUE!", "2"]),
    (2, "if argument count", ["SET A1 =IF(1,2)", "SET A2 =IF(1,2,3,4)", "SET A3 =IF()", "GET A1", "GET A2", "GET A3"], ["#PARSE!"] * 3),
    (2, "booleans are not numbers", ["SET A1 =1<2", "SET B1 =A1+1", "SET B2 =-A1", "SET B3 =SUM(A1,1)", "SET B4 =A1", "SET B5 =AVERAGE(A1)", "GET B1", "GET B2", "GET B3", "GET B4", "GET B5"], ["#VALUE!", "#VALUE!", "#VALUE!", "TRUE", "#VALUE!"]),
    (2, "functions skip booleans in ranges", ["SET A1 =1<2", "SET A2 3", "SET B1 =SUM(A1:A2)", "SET B2 =COUNT(A1:A2)", "SET B3 =AVERAGE(A1:A2)", "SET B4 =MAX(A1:A2)", "GET B1", "GET B2", "GET B3", "GET B4"], ["3", "1", "3", "3"]),
    (2, "comparisons follow updates", ["SET A1 =B1>2", "SET B1 3", "GET A1", "SET B1 1", "GET A1", "SET C1 =IF(A1,1,2)", "GET C1"], ["TRUE", "FALSE", "2"]),
    (2, "if follows both branches", ["SET A1 =IF(B1,C1,D1)", "SET B1 1", "SET C1 5", "SET D1 6", "GET A1", "SET C1 7", "GET A1", "SET B1 0", "GET A1", "SET D1 8", "GET A1"], ["5", "7", "6", "8"]),

    (3, "text literals", ['SET A1 ="hello world"', 'SET A2 ="say ""hi"""', 'SET A3 =""', "GET A1", "GET A2", "GET A3"], ["hello world", 'say "hi"', ""]),
    (3, "joining text", ["SET A1 3", 'SET B1 =A1&" kg"', 'SET B2 ="a"&"b"&"c"', 'SET B3 =C9&"x"', "GET B1", "GET B2", "GET B3"], ["3 kg", "abc", "x"]),
    (3, "numbers join as printed", ['SET A1 =1/4&""', 'SET A2 =1/3&"x"', 'SET A3 =2.50&""', 'SET A4 =-0&"!"', "GET A1", "GET A2", "GET A3", "GET A4"], ["0.25", "0.333333x", "2.5", "0!"]),
    (3, "booleans join as words", ['SET A1 =(1<2)&"!"', 'SET A2 ="is "&(2<1)', "GET A1", "GET A2"], ["TRUE!", "is FALSE"]),
    (3, "join precedence", ['SET A1 =1+2&"x"', 'SET A2 ="a"&1+2', 'SET A3 =2*3&4', "GET A1", "GET A2", "GET A3"], ["3x", "a3", "64"]),
    (3, "join errors", ['SET A1 =1/0&"x"', "SET A2 =AA1&1/0", 'SET A3 ="x"&1/0', "GET A1", "GET A2", "GET A3"], ["#DIV/0!", "#REF!", "#DIV/0!"]),
    (3, "len", ['SET A1 =LEN("abc")', "SET A2 =LEN(12.5)", "SET A3 =LEN(C9)", 'SET A4 =len("")', "SET A5 =LEN(1/3)", 'SET A6 =LEN("a"&"bc")', "GET A1", "GET A2", "GET A3", "GET A4", "GET A5", "GET A6"], ["3", "4", "0", "0", "8", "3"]),
    (3, "len of an error", ["SET A1 =LEN(1/0)", "SET A2 =LEN(AA1)", "GET A1", "GET A2"], ["#DIV/0!", "#REF!"]),
    (3, "text results in other formulas", ['SET A1 ="x"&"y"', "SET B1 =A1", "SET B2 =A1+1", "SET B3 =SUM(A1,1)", "SET B4 =LEN(A1)", "GET B1", "GET B2", "GET B3", "GET B4"], ["xy", "#VALUE!", "#VALUE!", "2"]),
    (3, "a literal is not a reference", ['SET A1 ="A1"', 'SET B1 ="B1"&B2', "SET B2 5", "GET A1", "GET B1"], ["A1", "B15"]),
    (3, "unterminated literal", ['SET A1 ="abc', 'SET A2 ="a"&', "GET A1", "GET A2"], ["#PARSE!", "#PARSE!"]),
    (3, "ranges skip text results", ['SET A1 ="5"', "SET A2 2", "SET B1 =SUM(A1:A2)", "SET B2 =COUNT(A1:A2)", "GET B1", "GET B2"], ["2", "1"]),

    (3, "joined text follows updates", ["SET A1 x", 'SET B1 =A1&"!"', "SET C1 =LEN(B1)", "GET B1", "SET A1 abc", "GET B1", "GET C1"], ["x!", "abc!", "4"]),

    (4, "insert moves cells down", ["SET A1 1", "SET A2 2", "SET A3 3", "SET C2 x", "INSERTROW 2", "GET A1", "GET A2", "GET A3", "GET A4", "GET C3"], ["1", "", "2", "3", "x"]),
    (4, "insert keeps references", ["SET A1 5", "SET B1 =A1*2", "SET A3 =B1+1", "INSERTROW 1", "GET B2", "GET A4", "SET A2 7", "GET B2", "GET A4"], ["10", "11", "14", "15"]),
    (4, "delete moves cells up", ["SET A1 1", "SET A2 2", "SET A3 3", "DELETEROW 2", "GET A1", "GET A2", "GET A3"], ["1", "3", ""]),
    (4, "reference to a deleted row", ["SET A1 5", "SET A2 =A1+1", "SET A3 =A2*2", "SET B5 =A3", "DELETEROW 1", "GET A1", "GET A2", "GET B4"], ["#REF!", "#REF!", "#REF!"]),
    (4, "insert inside a range grows it", ["SET A1 1", "SET A2 2", "SET A3 3", "SET B1 =SUM(A1:A3)", "INSERTROW 2", "SET A2 10", "GET B1"], ["16"]),
    (4, "delete at range edges shrinks it", ["SET A1 1", "SET A2 2", "SET A3 3", "SET A4 4", "SET C10 =SUM(A1:A4)", "DELETEROW 4", "GET C9", "DELETEROW 1", "GET C8", "SET A3 6", "GET C8"], ["6", "5", "5"]),
    (4, "range on deleted rows only", ["SET A5 3", "SET B1 =SUM(A5:A5)+1", "SET B2 =COUNT(A5:C5)", "DELETEROW 5", "GET B1", "GET B2"], ["#REF!", "#REF!"]),
    (4, "insert refused when row 99 is used", ["SET A99 x", "SET A1 1", "INSERTROW 1", "GET A1", "GET A2", "GET A99"], ["ERROR", "1", "", "x"]),
    (4, "reference pushed past row 99", ["SET B1 =A99+1", "GET B1", "INSERTROW 1", "GET B2"], ["1", "#REF!"]),
    (4, "invalid row numbers", ["SET A1 1", "INSERTROW 0", "INSERTROW 100", "DELETEROW x", "INSERTROW", "DELETEROW 1 2", "GET A1"], ["ERROR"] * 5 + ["1"]),
    (4, "text literals stay as they are", ["SET A1 5", 'SET B2 ="A1"&A1', "INSERTROW 1", "GET B3", "DELETEROW 1", "GET B2"], ["A15", "A15"]),
    (4, "cycles survive moves", ["SET A1 =A2", "SET A2 =A1", "INSERTROW 1", "GET A2", "GET A3", "SET A3 4", "GET A2"], ["#CYCLE!", "#CYCLE!", "4"]),
    (4, "row commands are case-insensitive", ["SET A1 1", "insertrow 1", "GET A2", "DeleteRow 1", "GET A1"], ["1", "1"]),
    (4, "edits after row moves", ["SET A1 1", "SET A2 2", "SET B3 =SUM(A1:A2)", "GET B3", "INSERTROW 2", "GET B4", "SET A2 5", "GET B4", "SET A3 4", "GET B4", "DELETEROW 1", "GET B3", "SET A1 10", "GET B3"], ["3", "3", "8", "10", "9", "14"]),
    (4, "last row", ["SET A98 1", "SET A99 2", "SET B1 =SUM(A98:A99)", "INSERTROW 99", "DELETEROW 99", "GET A99", "GET B1", "GET A98"], ["ERROR", "", "1", "1"]),
]


def check(root, step, name, commands, expected, seconds=None):
    started = time.monotonic()
    try:
        completed = subprocess.run(["./run.sh"], cwd=root, input="\n".join(commands) + "\n",
                                   capture_output=True, text=True, timeout=60 if seconds else 30)
        took = time.monotonic() - started
        actual = completed.stdout.splitlines()
        ok = completed.returncode == 0 and actual == expected and (seconds is None or took <= seconds)
        wrong = [(i, want, got) for i, (want, got) in enumerate(zip(expected, actual)) if want != got]
        detail = None if ok else {"lines": len(actual), "expectedLines": len(expected), "firstWrong": wrong[:5],
                                  "seconds": round(took, 2), "limit": seconds, "returncode": completed.returncode,
                                  "stderr": completed.stderr[-1000:]}
    except Exception as error:  # noqa: BLE001
        ok, detail = False, repr(error)
    return {"name": f"{'base' if step == 0 else f's{step}'}: {name}", "step": step, "passed": ok, "detail": detail}


def chain_values(first=1):
    return [str(first + index) for index in range(len(GRID))]


def performance():
    """Step 5: the whole grid as one chain, read and edited within SECONDS each."""
    whole = CHAIN + [f"GET {cell}" for cell in GRID]
    updates, expected = [], []
    for first in range(101, 121):
        updates += [f"SET A1 {first}", "GET Z99"]
        expected.append(str(first + len(GRID) - 1))
    middle = GRID.index("M50")
    cleared = chain_values()[:middle] + [""] + [str(index + 1) for index in range(len(GRID) - middle - 1)]
    cycle = ["SET A1 =Z99", "GET Z99", "GET A1", "GET M50", "SET A1 1", "GET Z99"]
    tail = ["GET Z99"] + [command for value in range(EDITS) for command in (f"SET Z99 {value}", "GET Z98")]
    tail += ["SET Z99 =Z98+1", "GET Z99"]
    edits = [str(len(GRID))] + [str(len(GRID) - 1)] * EDITS + [str(len(GRID))]
    wide = [f"SET {cell} 2" for cell in GRID[:-99]] + ["SET Z1 =SUM(A1:Y99)", "SET Z2 =COUNT(A1:Y99)", "GET Z1", "GET Z2",
                                                       "SET A1 3", "GET Z1"]
    return [
        (5, "whole-grid chain reads fast", whole, chain_values(), SECONDS),
        (5, "whole-grid chain updates fast", CHAIN + updates, expected, SECONDS),
        (5, "clearing the middle of the chain", CHAIN + ["CLEAR M50"] + [f"GET {cell}" for cell in GRID], cleared, SECONDS),
        (5, "a cycle through the whole chain", CHAIN + cycle, ["#CYCLE!"] * 3 + [str(len(GRID))], SECONDS),
        (5, "edits at the end of the chain stay fast", CHAIN + tail, edits, SECONDS),
        (5, "a range over most of the grid", wide, [str(2 * 2475), "2475", str(2 * 2475 + 1)], SECONDS),
    ]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project_dir", type=Path)
    parser.add_argument("--step", type=int, choices=range(6), default=5)
    args = parser.parse_args()
    root = args.project_dir.resolve()
    cases = [(step, name, commands, expected, None) for step, name, commands, expected in CHECKS]
    cases += performance()
    results = [check(root, *case) for case in cases if case[0] <= args.step]
    print(json.dumps({"passed": sum(r["passed"] for r in results), "total": len(results), "step": args.step,
                      "results": results}, indent=2))


if __name__ == "__main__":
    main()
