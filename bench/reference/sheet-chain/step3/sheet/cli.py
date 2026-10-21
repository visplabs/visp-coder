"""Line-based command interface: SET, GET, CLEAR."""
import sys

from .cells import cell_name
from .engine import Sheet
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
