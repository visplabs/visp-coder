"""Line-based command interface: SET, GET, CLEAR, INSERTROW, DELETEROW."""
import re
import sys
import threading

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
    row = int(parts[1]) if len(parts) == 2 and re.fullmatch(r"[1-9][0-9]?", parts[1]) else None
    if command == "INSERTROW" and row:
        return None if sheet.insert_row(row) else "ERROR"
    if command == "DELETEROW" and row:
        sheet.delete_row(row)
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


def run_deep(function):
    """Run with room for evaluation as deep as a chain through every cell (26 x 99) of the grid."""
    sys.setrecursionlimit(100_000)
    threading.stack_size(512 * 1024 * 1024)
    thread = threading.Thread(target=function)
    thread.start()
    thread.join()


if __name__ == "__main__":
    run_deep(main)
