"""Cell storage, dependency cycles and evaluation."""
import re
import sys

from .cells import range_cells
from .parser import deleted, inserted, parse_formula, rewrite_rows
from .values import Bool, Err, Text

NUMBER = re.compile(r"^[+-]?\d+(\.\d+)?$")


def references(node):
    kind = node[0]
    if kind == "ref":
        yield node[1]
    elif kind == "bin":
        yield from references(node[2])
        yield from references(node[3])
    elif kind in ("neg", "pos"):
        yield from references(node[1])
    elif kind in ("cmp",):
        yield from references(node[2])
        yield from references(node[3])
    elif kind == "cat":
        yield from references(node[1])
        yield from references(node[2])
    elif kind == "fn":
        for arg in node[2]:
            yield from references(arg)
    elif kind == "range" and node[1][0] == "ref" and node[2][0] == "ref":
        yield from range_cells(node[1][1], node[2][1])


class Sheet:
    def __init__(self):
        self.raw = {}
        self.formulas = {}

    def set(self, cell, content):
        self.raw.pop(cell, None)
        self.formulas.pop(cell, None)
        if content == "":
            return
        self.raw[cell] = content
        if content.startswith("="):
            self.formulas[cell] = parse_formula(content[1:])

    def insert_row(self, n):
        """Insert an empty row before row n; False (and no change) when row 99 has content."""
        if any(int(cell[1:]) == 99 for cell in self.raw):
            return False
        self.move_rows(lambda row: row + 1 if row >= n else row, inserted(n))
        return True

    def delete_row(self, n):
        self.move_rows(lambda row: None if row == n else row - 1 if row > n else row, deleted(n))

    def move_rows(self, cell_row, maps):
        """Move every cell's content by cell_row (None drops it) and rewrite every formula."""
        contents = {}
        for cell, content in self.raw.items():
            row = cell_row(int(cell[1:]))
            if row is not None:
                contents[f"{cell[0]}{row}"] = rewrite_rows(content, *maps) if content.startswith("=") else content
        self.raw, self.formulas = {}, {}
        for cell, content in contents.items():
            self.set(cell, content)

    def cycle_members(self):
        """Cells on a reference cycle (Tarjan's strongly connected components)."""
        graph = {cell: set(references(node)) for cell, node in self.formulas.items()}
        members, index, low, stack, on_stack, counter = set(), {}, {}, [], set(), [0]

        def visit(v):
            index[v] = low[v] = counter[0]
            counter[0] += 1
            stack.append(v)
            on_stack.add(v)
            for w in graph.get(v, ()):
                if w not in graph:
                    continue
                if w not in index:
                    visit(w)
                    low[v] = min(low[v], low[w])
                elif w in on_stack:
                    low[v] = min(low[v], index[w])
            if low[v] == index[v]:
                component = []
                while True:
                    w = stack.pop()
                    on_stack.discard(w)
                    component.append(w)
                    if w == v:
                        break
                if len(component) > 1 or v in graph.get(v, ()):
                    members.update(component)

        sys.setrecursionlimit(10000)
        for v in graph:
            if v not in index:
                visit(v)
        return members

    def value(self, cell):
        return Evaluation(self).value(cell)


class Evaluation:
    """One consistent read of the sheet: values are memoized for this read only."""

    def __init__(self, sheet):
        self.sheet = sheet
        self.memo = {}
        self.cycles = sheet.cycle_members()

    def value(self, cell):
        if cell in self.memo:
            return self.memo[cell]
        if cell in self.cycles:
            result = Err("#CYCLE!")
        else:
            content = self.sheet.raw.get(cell)
            if content is None:
                result = None
            elif cell in self.sheet.formulas:
                node = self.sheet.formulas[cell]
                result = Err(node[1]) if node[0] == "err" else self.top(node)
            elif NUMBER.match(content):
                result = float(content)
            else:
                result = Text(content)
        self.memo[cell] = result
        return result

    def top(self, node):
        """A formula that is only a reference takes the referenced value, text included."""
        if node[0] == "ref":
            value = self.value(node[1])
            return 0.0 if value is None else value
        return self.evaluate(node)

    def number(self, value):
        if isinstance(value, Err):
            return value
        if value is None:
            return 0.0
        if isinstance(value, (Text, Bool)):
            return Err("#VALUE!")
        return value

    def evaluate(self, node):
        kind = node[0]
        if kind == "num":
            return node[1]
        if kind == "text":
            return Text(node[1])
        if kind == "cat":
            return self.concatenate(node)
        if kind == "cmp":
            return self.compare(node)
        if kind == "badref":
            return Err("#REF!")
        if kind == "ref":
            return self.value(node[1])
        if kind in ("neg", "pos"):
            value = self.number(self.evaluate(node[1]))
            if isinstance(value, Err):
                return value
            return -value if kind == "neg" else value
        if kind == "bin":
            return self.binary(node)
        if kind == "fn":
            return self.function(node)
        return Err("#VALUE!")  # a range used as a single value

    def binary(self, node):
        left = self.number(self.evaluate(node[2]))
        if isinstance(left, Err):
            return left
        right = self.number(self.evaluate(node[3]))
        if isinstance(right, Err):
            return right
        op = node[1]
        if op == "+":
            return left + right
        if op == "-":
            return left - right
        if op == "*":
            return left * right
        if op == "/":
            return Err("#DIV/0!") if right == 0 else left / right
        return left ** right

    def concatenate(self, node):
        parts = []
        for operand in (node[1], node[2]):
            value = self.evaluate(operand)
            if isinstance(value, Err):
                return value
            parts.append(show_text(value))
        return Text(parts[0] + parts[1])

    def compare(self, node):
        left = self.evaluate(node[2])
        if isinstance(left, Err):
            return left
        right = self.evaluate(node[3])
        if isinstance(right, Err):
            return right
        if isinstance(left, Bool) or isinstance(right, Bool):
            return Err("#VALUE!")
        if left is None:
            left = Text("") if isinstance(right, Text) else 0.0
        if right is None:
            right = Text("") if isinstance(left, Text) else 0.0
        if isinstance(left, Text) != isinstance(right, Text):
            return Err("#VALUE!")
        op = node[1]
        result = {
            "=": left == right,
            "<>": left != right,
            "<": left < right,
            ">": left > right,
            "<=": left <= right,
            ">=": left >= right,
        }[op]
        return Bool(result)

    def condition(self, value):
        if isinstance(value, Err):
            return value
        if isinstance(value, Bool):
            return value.value
        if value is None:
            return False
        if isinstance(value, Text):
            return Err("#VALUE!")
        return value != 0

    def function(self, node):
        if node[1] == "IF":
            chosen = self.condition(self.evaluate(node[2][0]))
            if isinstance(chosen, Err):
                return chosen
            return self.evaluate(node[2][1] if chosen else node[2][2])
        if node[1] == "COUNT":
            return self.count(node[2])
        if node[1] in ("SUMIF", "COUNTIF"):
            return self.conditional(node[1], *node[2])
        numbers = []
        for arg in node[2]:
            if arg[0] == "range":
                if arg[1][0] != "ref" or arg[2][0] != "ref":
                    return Err("#REF!")
                for cell in range_cells(arg[1][1], arg[2][1]):
                    value = self.value(cell)
                    if isinstance(value, Err):
                        return value
                    if value is None or isinstance(value, (Text, Bool)):
                        continue
                    numbers.append(value)
            else:
                value = self.evaluate(arg)
                if isinstance(value, Err):
                    return value
                if isinstance(value, (Text, Bool)):
                    return Err("#VALUE!")
                numbers.append(0.0 if value is None else value)
        if node[1] == "SUM":
            return sum(numbers)
        if not numbers:
            return 0.0
        return min(numbers) if node[1] == "MIN" else max(numbers)

    def count(self, args):
        total = 0
        for arg in args:
            if arg[0] == "range":
                if arg[1][0] != "ref" or arg[2][0] != "ref":
                    return Err("#REF!")
                for cell in range_cells(arg[1][1], arg[2][1]):
                    if isinstance(self.value(cell), float):
                        total += 1
            else:
                value = self.evaluate(arg)
                if isinstance(value, Err):
                    return value
                if isinstance(value, float):
                    total += 1
        return float(total)

    def conditional(self, name, cells, criterion):
        if cells[0] != "range" or cells[1][0] != "ref" or cells[2][0] != "ref":
            return Err("#REF!")
        wanted = self.evaluate(criterion)
        if isinstance(wanted, Err):
            return wanted
        matches = matcher(wanted)
        total = 0.0
        for cell in range_cells(cells[1][1], cells[2][1]):
            value = self.value(cell)
            if isinstance(value, Err) or not matches(value):
                continue
            if name == "COUNTIF":
                total += 1
            elif isinstance(value, float):
                total += value
        return total


OPERATORS = ("<=", ">=", "<>", "<", ">", "=")
ORDER = {"<": lambda a, b: a < b, ">": lambda a, b: a > b, "<=": lambda a, b: a <= b, ">=": lambda a, b: a >= b}


def matcher(wanted):
    """The test a COUNTIF/SUMIF criterion applies to each non-error cell value."""
    if wanted is None:
        return lambda value: value is None
    if isinstance(wanted, Bool):
        return lambda value: isinstance(value, Bool) and value.value == wanted.value
    if isinstance(wanted, float):
        return lambda value: isinstance(value, float) and value == wanted
    op = next((op for op in OPERATORS if wanted.startswith(op)), "")
    operand = wanted[len(op):]
    op = op or "="
    if NUMBER.match(operand):
        number = float(operand)
        if op == "=":
            return lambda value: isinstance(value, float) and value == number
        if op == "<>":
            return lambda value: not (isinstance(value, float) and value == number)
        return lambda value: isinstance(value, float) and ORDER[op](value, number)
    if operand == "":
        return {"=": lambda value: value is None, "<>": lambda value: value is not None}.get(op, lambda value: False)
    if op in ("=", "<>"):
        pattern = wildcard(operand.lower())
        equal = lambda value: isinstance(value, Text) and pattern.fullmatch(value.lower()) is not None
        return equal if op == "=" else lambda value: not equal(value)
    return lambda value: isinstance(value, Text) and ORDER[op](value.lower(), operand.lower())


def wildcard(operand):
    """A regular expression for a criterion's text: `*`, `?`, and `~` before them or itself."""
    parts, i = [], 0
    while i < len(operand):
        char = operand[i]
        if char == "~" and i + 1 < len(operand) and operand[i + 1] in "*?~":
            parts.append(re.escape(operand[i + 1]))
            i += 2
            continue
        parts.append(".*" if char == "*" else "." if char == "?" else re.escape(char))
        i += 1
    return re.compile("".join(parts), re.DOTALL)


def show_text(value):
    from .values import show

    return "" if value is None else show(value)
