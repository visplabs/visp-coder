"""Formula tokenizer and recursive-descent parser producing tuple nodes."""
import re

from .values import Err

TOKEN = re.compile(r'\s*(?:(\d+(?:\.\d+)?)|(\$?[A-Za-z]+\$?\d+|[A-Za-z]+)|("(?:[^"]|"")*")|(#REF!)|(<=|>=|<>)|(.))')
FUNCTIONS = ("SUM", "MIN", "MAX", "COUNT", "IF", "SUMIF", "COUNTIF")
COMPARISONS = ("=", "<>", "<", ">", "<=", ">=")


def tokenize(source):
    tokens, position = [], 0
    while position < len(source):
        match = TOKEN.match(source, position)
        if not match or match.end() == position:
            break
        position = match.end()
        number, word, text, badref, pair, symbol = match.groups()
        if number is not None:
            tokens.append(("num", float(number)))
        elif word is not None:
            tokens.append(("word", word.upper().replace("$", "")))
        elif text is not None:
            tokens.append(("text", text[1:-1].replace('""', '"')))
        elif badref is not None:
            tokens.append(("badword", badref))
        elif pair is not None:
            tokens.append(("sym", pair))
        elif symbol is not None and not symbol.isspace():
            if symbol == '"':
                raise Err("#PARSE!")
            tokens.append(("sym", symbol))
    return tokens


def reference(word):
    """("ref", name), ("badref",) for a reference outside A1-Z99, or None."""
    match = re.match(r"^([A-Z]+)(\d+)$", word)
    if not match:
        return None
    letters, row = match.group(1), int(match.group(2))
    if len(letters) != 1 or not 1 <= row <= 99:
        return ("badref",)
    return ("ref", f"{letters}{row}")


class Parser:
    def __init__(self, tokens):
        self.tokens, self.i = tokens, 0

    def peek(self):
        return self.tokens[self.i] if self.i < len(self.tokens) else (None, None)

    def take(self, kind=None, value=None):
        token = self.peek()
        if token[0] is None or (kind and token[0] != kind) or (value and token[1] != value):
            raise Err("#PARSE!")
        self.i += 1
        return token

    def parse(self):
        node = self.comparison()
        if self.i != len(self.tokens):
            raise Err("#PARSE!")
        return node

    def comparison(self):
        node = self.concatenation()
        if self.peek()[0] == "sym" and self.peek()[1] in COMPARISONS:
            node = ("cmp", self.take()[1], node, self.concatenation())
            if self.peek()[0] == "sym" and self.peek()[1] in COMPARISONS:
                raise Err("#PARSE!")
        return node

    def concatenation(self):
        node = self.additive()
        while self.peek() == ("sym", "&"):
            self.take()
            node = ("cat", node, self.additive())
        return node

    def additive(self):
        node = self.term()
        while self.peek() in (("sym", "+"), ("sym", "-")):
            node = ("bin", self.take()[1], node, self.term())
        return node

    def term(self):
        node = self.power()
        while self.peek() in (("sym", "*"), ("sym", "/")):
            node = ("bin", self.take()[1], node, self.power())
        return node

    def power(self):
        node = self.unary()
        while self.peek() == ("sym", "^"):
            self.take()
            node = ("bin", "^", node, self.unary())
        return node

    def unary(self):
        if self.peek() in (("sym", "+"), ("sym", "-")):
            return ("neg" if self.take()[1] == "-" else "pos", self.unary())
        return self.primary()

    def primary(self):
        kind, value = self.peek()
        if kind == "num":
            self.take()
            return ("num", value)
        if kind == "text":
            self.take()
            return ("text", value)
        if kind == "badword":
            self.take()
            return ("badref",)
        if kind == "sym" and value == "(":
            self.take()
            node = self.comparison()
            self.take("sym", ")")
            return node
        if kind == "word":
            self.take()
            if self.peek() == ("sym", "("):
                if value not in FUNCTIONS:
                    raise Err("#PARSE!")
                self.take()
                args = [self.argument()]
                while self.peek() == ("sym", ","):
                    self.take()
                    args.append(self.argument())
                self.take("sym", ")")
                if value == "IF" and len(args) != 3:
                    raise Err("#PARSE!")
                if value in ("SUMIF", "COUNTIF") and (
                        len(args) != 2 or args[0][0] not in ("range", "badref") or args[1][0] == "range"):
                    raise Err("#PARSE!")
                return ("fn", value, args)
            node = reference(value)
            if node is None:
                raise Err("#PARSE!")
            return node
        raise Err("#PARSE!")

    def argument(self):
        kind, value = self.peek()
        if kind == "word" and self.i + 1 < len(self.tokens) and self.tokens[self.i + 1] == ("sym", ":"):
            first = reference(value)
            self.i += 2
            second = reference(self.take("word")[1])
            if first is None or second is None:
                raise Err("#PARSE!")
            return ("range", first, second)
        return self.comparison()


def parse_formula(source):
    """The parsed formula, or ("err", code) when it cannot be parsed."""
    try:
        return Parser(tokenize(source)).parse()
    except Err as error:
        return ("err", error.code)


REFERENCE_TEXT = re.compile(r'("(?:[^"]|"")*")|(\$?)([A-Za-z])(\$?)([1-9][0-9]?)(?![0-9A-Za-z])')


def move_formula(content, columns, rows):
    """The formula with every relative reference part moved; `#REF!` where it leaves A1-Z99."""

    def replace(match):
        if match.group(1) is not None:
            return match.group(1)
        start = match.start()
        if start > 0 and (content[start - 1].isalpha() or content[start - 1] == "$" and start > 1 and content[start - 2].isalpha()):
            return match.group(0)
        col_abs, letter, row_abs, row = match.group(2), match.group(3).upper(), match.group(4), int(match.group(5))
        col = ord(letter) if col_abs else ord(letter) + columns
        new_row = row if row_abs and col_abs else row + rows
        if not ord("A") <= col <= ord("Z") or not 1 <= new_row <= 99:
            return "#REF!"
        return f"{col_abs}{chr(col)}{row_abs}{new_row}"

    return REFERENCE_TEXT.sub(replace, content)


PART = r"(\$?)([A-Za-z])(\$?)([1-9][0-9]?)(?![0-9A-Za-z])"
ROW_TEXT = re.compile(r'("(?:[^"]|"")*")|' + PART + ":" + PART + "|" + PART)


def guarded(content, start):
    """A match that continues a longer word, such as the `A1` in `AA1`, is not a reference."""
    return start > 0 and (content[start - 1].isalpha() or
                          content[start - 1] == "$" and start > 1 and content[start - 2].isalpha())


def rewrite_rows(content, row_map, range_map):
    """The formula with every reference's row mapped; `#REF!` where the map gives None.

    row_map(row) maps a single reference; range_map(first, second) maps a range's two corner
    rows together. References are written in upper case and `$` signs are kept.
    """

    def part(dollar_col, letter, dollar_row, row):
        return f"{dollar_col}{letter}{dollar_row}{row}"

    def replace(match):
        groups = match.groups()
        if groups[0] is not None or guarded(content, match.start()):
            return match.group(0)
        if groups[1] is not None:
            rows = range_map(int(groups[4]), int(groups[8]))
            if rows is None:
                return "#REF!"
            return part(*groups[1:4], rows[0]) + ":" + part(*groups[5:8], rows[1])
        row = row_map(int(groups[12]))
        return "#REF!" if row is None else part(*groups[9:12], row)

    return ROW_TEXT.sub(replace, content)


def inserted(n):
    """Row maps for inserting an empty row before row n."""
    def row_map(row):
        moved = row + 1 if row >= n else row
        return moved if moved <= 99 else None

    def range_map(first, second):
        rows = row_map(first), row_map(second)
        return None if None in rows else rows

    return row_map, range_map


def deleted(n):
    """Row maps for deleting row n: a range keeps its remaining rows, or is gone."""
    def row_map(row):
        return None if row == n else row - 1 if row > n else row

    def range_map(first, second):
        top, bottom = min(first, second), max(first, second)
        if n in (top, bottom):
            return None
        top, bottom = top - 1 if top > n else top, bottom - 1 if bottom >= n else bottom
        return (top, bottom) if first <= second else (bottom, top)

    return row_map, range_map
