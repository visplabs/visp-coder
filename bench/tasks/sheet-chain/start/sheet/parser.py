"""Formula tokenizer and recursive-descent parser producing tuple nodes."""
import re

from .values import Err

TOKEN = re.compile(r"\s*(?:(\d+(?:\.\d+)?)|([A-Za-z]+\d*)|(.))")
FUNCTIONS = ("SUM", "MIN", "MAX")


def tokenize(source):
    tokens, position = [], 0
    while position < len(source):
        match = TOKEN.match(source, position)
        if not match or match.end() == position:
            break
        position = match.end()
        number, word, symbol = match.groups()
        if number is not None:
            tokens.append(("num", float(number)))
        elif word is not None:
            tokens.append(("word", word.upper()))
        elif symbol is not None and not symbol.isspace():
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
        node = self.additive()
        if self.i != len(self.tokens):
            raise Err("#PARSE!")
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
        base = self.unary()
        if self.peek() == ("sym", "^"):
            self.take()
            return ("bin", "^", base, self.power())
        return base

    def unary(self):
        if self.peek() in (("sym", "+"), ("sym", "-")):
            return ("neg" if self.take()[1] == "-" else "pos", self.unary())
        return self.primary()

    def primary(self):
        kind, value = self.peek()
        if kind == "num":
            self.take()
            return ("num", value)
        if kind == "sym" and value == "(":
            self.take()
            node = self.additive()
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
        return self.additive()


def parse_formula(source):
    """The parsed formula, or ("err", code) when it cannot be parsed."""
    try:
        return Parser(tokenize(source)).parse()
    except Err as error:
        return ("err", error.code)
