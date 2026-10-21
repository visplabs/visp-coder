"""Row insertion and deletion: where each row moves, and how formula references follow it."""
ROWS = 99


def inserted(at):
    """Row mover for a row inserted before `at`: None for a row pushed past the last one."""
    return lambda row: row if row < at else (row + 1 if row < ROWS else None)


def deleted(at):
    """Row mover for row `at` deleted: None for the deleted row."""
    return lambda row: row if row < at else (None if row == at else row - 1)


def move_reference(node, move):
    row = move(int(node[1][1:]))
    return ("badref",) if row is None else ("ref", f"{node[1][0]}{row}")


def move_range(node, move, deleted_row):
    """A range's corners move like references; a corner on a deleted row moves inside the range."""
    first, second = node[1], node[2]
    if first[0] != "ref" or second[0] != "ref":
        return node
    rows = int(first[1][1:]), int(second[1][1:])
    if deleted_row is not None and rows[0] == rows[1] == deleted_row:
        return ("range", ("badref",), ("badref",))
    corners = []
    for corner, row in zip((first, second), rows):
        if row == deleted_row:
            # The row below moves up into the deleted row; the row above stays.
            row = deleted_row if row == min(rows) else deleted_row - 1
            corners.append(("ref", f"{corner[1][0]}{row}"))
        else:
            corners.append(move_reference(corner, move))
    if any(corner[0] != "ref" for corner in corners):
        return ("range", ("badref",), ("badref",))
    return ("range", *corners)


def move_formula(node, move, deleted_row=None):
    """The parsed formula with every reference following the rows' move."""
    kind = node[0]
    if kind == "ref":
        return move_reference(node, move)
    if kind == "range":
        return move_range(node, move, deleted_row)
    if kind in ("bin", "cmp"):
        return (kind, node[1], move_formula(node[2], move, deleted_row), move_formula(node[3], move, deleted_row))
    if kind in ("neg", "pos"):
        return (kind, move_formula(node[1], move, deleted_row))
    if kind == "cat":
        return (kind, move_formula(node[1], move, deleted_row), move_formula(node[2], move, deleted_row))
    if kind == "fn":
        return (kind, node[1], [move_formula(arg, move, deleted_row) for arg in node[2]])
    return node
