"""Cell storage, dependency cycles and evaluation."""
import re
import sys

from .cells import range_cells
from .parser import parse_formula
from .values import Err, Text

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
        if isinstance(value, Text):
            return Err("#VALUE!")
        return value

    def evaluate(self, node):
        kind = node[0]
        if kind == "num":
            return node[1]
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

    def function(self, node):
        numbers = []
        for arg in node[2]:
            if arg[0] == "range":
                if arg[1][0] != "ref" or arg[2][0] != "ref":
                    return Err("#REF!")
                for cell in range_cells(arg[1][1], arg[2][1]):
                    value = self.value(cell)
                    if isinstance(value, Err):
                        return value
                    if value is None or isinstance(value, Text):
                        continue
                    numbers.append(value)
            else:
                value = self.evaluate(arg)
                if isinstance(value, Err):
                    return value
                if isinstance(value, Text):
                    return Err("#VALUE!")
                numbers.append(0.0 if value is None else value)
        if node[1] == "SUM":
            return sum(numbers)
        if not numbers:
            return 0.0
        return min(numbers) if node[1] == "MIN" else max(numbers)
