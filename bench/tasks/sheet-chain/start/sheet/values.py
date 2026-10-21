class Err(Exception):
    """A spreadsheet error value such as #DIV/0!."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


class Text(str):
    """Text content, distinct from numbers."""


def show(value):
    if value is None:
        return ""
    if isinstance(value, Err):
        return value.code
    if isinstance(value, Text):
        return str(value)
    rounded = round(value, 6)
    if rounded == int(rounded):
        return str(int(rounded))
    return f"{rounded:.6f}".rstrip("0").rstrip(".")
