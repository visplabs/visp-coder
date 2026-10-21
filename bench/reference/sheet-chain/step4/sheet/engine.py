"""Cell storage, dependency cycles and evaluation."""
import re
import sys

from .cells import range_cells
from .parser import parse_formula
from .rows import ROWS, deleted, inserted, move_formula
from .values import Bool, Err, Text, show

NUMBER = re.compile(r"^[+-]?\d+(\.\d+)?$")


def references(node):
    kind = node[0]
    if kind == "ref":
        yield node[1]
    elif kind in ("bin", "cmp"):
        yield from references(node[2])
        yield from references(node[3])
    elif kind in ("neg", "pos"):
        yield from references(node[1])
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
        self.raw = {}  # number and text content
        self.formulas = {}  # parsed formulas

    def set(self, cell, content):
        self.raw.pop(cell, None)
        self.formulas.pop(cell, None)
        if content.startswith("="):
            self.formulas[cell] = parse_formula(content[1:])
        elif content:
            self.raw[cell] = content

    def insert_row(self, row):
        """Insert an empty row before `row`; False, changing nothing, when the last row is used."""
        if any(int(cell[1:]) == ROWS for cell in (*self.raw, *self.formulas)):
            return False
        self.move_rows(inserted(row))
        return True

    def delete_row(self, row):
        self.move_rows(deleted(row), row)

    def move_rows(self, move, deleted_row=None):
        def moved(cells):
            for cell, content in cells.items():
                row = move(int(cell[1:]))
                if row is not None:
                    yield f"{cell[0]}{row}", content

        self.raw = dict(moved(self.raw))
        self.formulas = {cell: move_formula(node, move, deleted_row) for cell, node in moved(self.formulas)}

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
        elif cell in self.sheet.formulas:
            node = self.sheet.formulas[cell]
            result = Err(node[1]) if node[0] == "err" else self.top(node)
        else:
            content = self.sheet.raw.get(cell)
            if content is None:
                result = None
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
            return self.join(node)
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
        if kind == "cmp":
            return self.compare(node)
        if kind == "fn":
            return self.function(node)
        raise Err("#PARSE!")

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

    def text(self, value):
        """A value as `&` joins it: as GET prints it, an empty cell as nothing."""
        return value if isinstance(value, Err) else Text(show(value))

    def join(self, node):
        left = self.text(self.evaluate(node[1]))
        if isinstance(left, Err):
            return left
        right = self.text(self.evaluate(node[2]))
        return right if isinstance(right, Err) else Text(left + right)

    def compare(self, node):
        left = self.number(self.evaluate(node[2]))
        if isinstance(left, Err):
            return left
        right = self.number(self.evaluate(node[3]))
        if isinstance(right, Err):
            return right
        return Bool({"=": left == right, "<>": left != right, "<": left < right, ">": left > right,
                     "<=": left <= right, ">=": left >= right}[node[1]])

    def condition(self, value):
        """IF's choice: a boolean, or a number that is not 0; text is #VALUE!."""
        if isinstance(value, Bool):
            return value.value
        value = self.number(value)
        return value if isinstance(value, Err) else value != 0

    def function(self, node):
        if node[1] == "IF":
            chosen = self.condition(self.evaluate(node[2][0]))
            if isinstance(chosen, Err):
                return chosen
            return self.evaluate(node[2][1] if chosen else node[2][2])
        if node[1] == "LEN":
            value = self.text(self.evaluate(node[2][0]))
            return value if isinstance(value, Err) else float(len(value))
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
        if node[1] == "COUNT":
            return float(len(numbers))
        if node[1] == "AVERAGE":
            return sum(numbers) / len(numbers) if numbers else Err("#DIV/0!")
        if not numbers:
            return 0.0
        return min(numbers) if node[1] == "MIN" else max(numbers)
