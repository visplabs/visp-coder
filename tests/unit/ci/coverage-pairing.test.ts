import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

type Location = { start: { line: number; column: number }; end: { line: number; column: number } };
type FileCoverage = {
  branchMap: Record<string, { type: string; loc: Location; locations: Location[] }>;
  b: Record<string, number[]>;
  statementMap: Record<string, Location>;
  s: Record<string, number>;
  fnMap: Record<string, { name: string; decl: Location; loc: Location }>;
  f: Record<string, number>;
};

const { addPaired } = (await import(
  pathToFileURL(join(process.cwd(), "scripts/ci/coverage-pairing.mjs")).href
)) as { addPaired(base: FileCoverage, child: FileCoverage): Record<string, number> };

const at = (line: number, column: number, endLine = line, endColumn = column + 10): Location => ({
  start: { line, column },
  end: { line: endLine, column: endColumn },
});

function coverage(columnShift: number, hits: number): FileCoverage {
  const branch = (line: number) => ({
    type: "cond-expr",
    loc: at(line, 4 + columnShift),
    locations: [at(line, 4 + columnShift), at(line, 20 + columnShift)],
  });
  return {
    branchMap: { 0: branch(3), 1: branch(7) },
    b: { 0: [hits, 0], 1: [0, hits] },
    statementMap: { 0: at(3, 2 + columnShift), 1: at(7, 2 + columnShift) },
    s: { 0: hits, 1: hits },
    fnMap: { 0: { name: "run", decl: at(2, 9 + columnShift), loc: at(2, 0, 9, 1) } },
    f: { 0: hits },
  };
}

describe("addPaired", () => {
  it("adds hits to the entry on the same line even when the columns differ", () => {
    const base = coverage(0, 0);
    const dropped = addPaired(base, coverage(6, 2));
    expect(dropped).toEqual({ branches: 0, statements: 0, functions: 0 });
    expect(base.b).toEqual({ 0: [2, 0], 1: [0, 2] });
    expect(base.s).toEqual({ 0: 2, 1: 2 });
    expect(base.f).toEqual({ 0: 2 });
  });

  it("pairs a branch that starts on another line by its last line", () => {
    const base = coverage(0, 0);
    const child = coverage(0, 1);
    const moved = child.branchMap[1];
    if (moved) moved.locations[0] = at(6, 30, 7, 2);
    addPaired(base, child);
    expect(base.b[1]).toEqual([0, 1]);
  });

  it("drops what it cannot pair instead of adding it", () => {
    const base = coverage(0, 0);
    const child = coverage(0, 3);
    child.statementMap[2] = at(40, 0);
    child.s[2] = 5;
    const dropped = addPaired(base, child);
    expect(dropped.statements).toBe(1);
    expect(Object.keys(base.statementMap)).toHaveLength(2);
    expect(base.s).toEqual({ 0: 3, 1: 3 });
  });

  it("leaves a line alone when the two sides have different numbers of entries on it", () => {
    const base = coverage(0, 0);
    const child = coverage(0, 4);
    child.statementMap[2] = at(3, 30);
    child.s[2] = 4;
    const dropped = addPaired(base, child);
    expect(base.s[0]).toBe(0);
    expect(dropped.statements).toBe(2);
  });
});
