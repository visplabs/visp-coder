"""Line-based command interface: SET, GET, CLEAR, COPY, FORMULA, INSERTROW, DELETEROW."""
import re
import sys

from .cells import cell_name
from .engine import Sheet
from .parser import move_formula
from .values import show


def execute(sheet, line):
    """The output line for a command, or None when the command prints nothing."""
    parts = line.split(" ", 2)
    command = parts[0].upper()
    cell = cell_name(parts[1]) if len(parts) > 1 else None
    if command == "SET" and cell:
        sheet.set(cell, parts[2] if len(parts) > 2 else "")
        return None
    if command == "CLEAR" and cell and len(parts) == 2:
        sheet.set(cell, "")
        return None
    if command == "GET" and cell and len(parts) == 2:
        return show(sheet.value(cell))
    if command == "FORMULA" and cell and len(parts) == 2:
        return sheet.raw.get(cell, "")
    if command in ("INSERTROW", "DELETEROW") and len(parts) == 2 and re.fullmatch(r"[1-9][0-9]?", parts[1]):
        if command == "DELETEROW":
            sheet.delete_row(int(parts[1]))
            return None
        return None if sheet.insert_row(int(parts[1])) else "ERROR"
    target = cell_name(parts[2]) if len(parts) > 2 else None
    if command == "COPY" and cell and target:
        content = sheet.raw.get(cell, "")
        if content.startswith("="):
            content = move_formula(content, ord(target[0]) - ord(cell[0]), int(target[1:]) - int(cell[1:]))
        sheet.set(target, content)
        return None
    return "ERROR"


def main():
    sheet = Sheet()
    for line in sys.stdin:
        line = line.rstrip("\n")
        if not line.strip():
            continue
        output = execute(sheet, line)
        if output is not None:
            print(output, flush=True)


if __name__ == "__main__":
    main()
