import re

CELL = re.compile(r"^([A-Za-z])([1-9][0-9]?)$")


def cell_name(text):
    """Canonical `A1` name, or None when the text is not a cell inside A1-Z99."""
    match = CELL.match(text)
    return f"{match.group(1).upper()}{int(match.group(2))}" if match else None


def range_cells(first, second):
    """Cells of a rectangle, row by row, left to right within a row."""
    c1, r1, c2, r2 = ord(first[0]), int(first[1:]), ord(second[0]), int(second[1:])
    for row in range(min(r1, r2), max(r1, r2) + 1):
        for col in range(min(c1, c2), max(c1, c2) + 1):
            yield f"{chr(col)}{row}"
