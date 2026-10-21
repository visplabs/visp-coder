import { describe, expect, it } from "vitest";
import { SnapshotIndex } from "../../../src/graph/query/index.js";
import type { Entity, GraphSnapshot, Relation, UnknownRecord } from "../../../src/graph/types.js";
import { egoGraph } from "../../../src/ui/change-map/graph.js";
import { readingOrder } from "../../../src/ui/change-map/records.js";
import type { UiMapEdge, UiMapNode } from "../../../src/ui/contract.js";
import { MAX_HUNK_LINES, parseUnifiedDiff } from "../../../src/workflow/product/feature-diff.js";

describe("parseUnifiedDiff", () => {
  it("reads modified, added, deleted and binary files", () => {
    const files = parseUnifiedDiff(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "index 1..2 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,3 +1,3 @@",
        " one",
        "-two",
        "+TWO",
        " three",
        "diff --git a/src/new.ts b/src/new.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/new.ts",
        "@@ -0,0 +1 @@",
        "+fresh",
        "diff --git a/old.ts b/old.ts",
        "deleted file mode 100644",
        "--- a/old.ts",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "-gone",
        "-too",
        "diff --git a/logo.png b/logo.png",
        "deleted file mode 100644",
        "Binary files a/logo.png and /dev/null differ",
        "",
      ].join("\n"),
    );
    expect(
      files.map(({ path, status, added, removed, binary }) => ({
        path,
        status,
        added,
        removed,
        binary,
      })),
    ).toEqual([
      { path: "src/a.ts", status: "modified", added: 1, removed: 1, binary: false },
      { path: "src/new.ts", status: "added", added: 1, removed: 0, binary: false },
      { path: "old.ts", status: "deleted", added: 0, removed: 2, binary: false },
      { path: "logo.png", status: "deleted", added: 0, removed: 0, binary: true },
    ]);
    expect(files[0]?.hunks[0]).toMatchObject({ addedAt: [2], removedAt: [2], newStart: 1 });
    expect(files[2]?.hunks[0]).toMatchObject({ newStart: 0, newLines: 0, removedAt: [1, 1] });
  });

  it("unquotes paths git quotes", () => {
    const [file] = parseUnifiedDiff(
      [
        'diff --git "a/src/say \\"hi\\".ts" "b/src/say \\"hi\\".ts"',
        '--- "a/src/say \\"hi\\".ts"',
        '+++ "b/src/say \\"hi\\".ts"',
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ].join("\n"),
    );
    expect(file?.path).toBe('src/say "hi".ts');
  });

  it("keeps every changed line number past the shown-lines limit", () => {
    const lines = Array.from({ length: MAX_HUNK_LINES + 30 }, (_, index) => `+line ${index}`);
    const [file] = parseUnifiedDiff(
      [
        "diff --git a/x.ts b/x.ts",
        "--- a/x.ts",
        "+++ b/x.ts",
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines,
      ].join("\n"),
    );
    const hunk = file?.hunks[0];
    expect(hunk?.lines).toHaveLength(MAX_HUNK_LINES);
    expect(hunk?.omittedLines).toBe(30);
    expect(hunk?.addedAt).toHaveLength(MAX_HUNK_LINES + 30);
    expect(file?.added).toBe(MAX_HUNK_LINES + 30);
  });

  it("does not let a blank line seed anything when real lines changed", () => {
    const [file] = parseUnifiedDiff(
      [
        "diff --git a/x.ts b/x.ts",
        "--- a/x.ts",
        "+++ b/x.ts",
        "@@ -1,2 +1,4 @@",
        " a",
        "+",
        "+const b = 1;",
        " c",
      ].join("\n"),
    );
    expect(file?.hunks[0]?.addedAt).toEqual([3]);
  });
});

const entity = (
  path: string,
  kind: Entity["kind"],
  name: string,
  startLine = 1,
  endLine = 1,
): Entity => ({
  id: kind === "file" ? `${path}#file` : `${path}#${kind}:${name}`,
  path,
  kind,
  name,
  startLine,
  endLine,
});
const calls = (source: Entity, target: Entity, line = 1): Relation => ({
  source: source.id,
  target: target.id,
  kind: "calls",
  path: source.path,
  line,
});

function snapshot(entities: Entity[], relations: Relation[], unknowns: UnknownRecord[] = []) {
  return new SnapshotIndex({
    id: "S1",
    root: "/repo",
    createdAt: "2026-10-21T00:00:00.000Z",
    fingerprint: "f",
    schemaVersion: 1,
    files: [],
    entities,
    relations,
    unknowns,
    entrypoints: [],
    languageCoverage: [],
  } as GraphSnapshot);
}

const change = (path: string, newStart: number, added: number[]) =>
  parseUnifiedDiff(
    [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -${newStart},1 +${newStart},${added.length} @@`,
      ...added.map((line) => `+line ${line}`),
    ].join("\n"),
  );

describe("egoGraph", () => {
  const file = entity("src/a.ts", "file", "a.ts", 1, 40);
  const outer = entity("src/a.ts", "class", "Outer", 1, 30);
  const inner = entity("src/a.ts", "method", "inner", 10, 15);
  const caller = entity("src/b.ts", "function", "useInner", 3, 8);
  const callerOfCaller = entity("src/c.ts", "function", "main", 1, 4);
  const callee = entity("src/d.ts", "function", "helper", 1, 2);
  const testFile = entity("test/a.test.ts", "file", "a.test.ts");
  const testFn = entity("test/a.test.ts", "function", "check");
  const index = snapshot(
    [file, outer, inner, caller, callerOfCaller, callee, testFile, testFn],
    [
      calls(caller, inner, 5),
      calls(callerOfCaller, caller, 2),
      calls(inner, callee, 12),
      calls(testFn, inner, 1),
      { source: file.id, target: testFile.id, kind: "tested_by", path: testFile.path, line: 1 },
    ],
    [{ kind: "unresolved_call", path: "src/e.ts", detail: "service.inner" }],
  );

  it("seeds the innermost declaration and reaches one or two hops out", () => {
    const graph = egoGraph(index, change("src/a.ts", 11, [11]));
    expect(graph.nodes.map((node) => [node.id, node.role, node.distance])).toEqual([
      ["src/a.ts#method:inner", "changed", 0],
      ["test/a.test.ts#file", "test", 1],
      ["src/b.ts#function:useInner", "caller", 1],
      ["src/d.ts#function:helper", "callee", 1],
      ["src/e.ts#file", "caller", 1],
      ["src/c.ts#function:main", "caller", 2],
    ]);
    expect(graph.nodes[0]?.unseenCallers).toEqual(["src/e.ts: service.inner"]);
  });

  it("marks only the name match as unresolved", () => {
    const graph = egoGraph(index, change("src/a.ts", 11, [11]));
    expect(graph.edges.filter((edge) => !edge.resolved)).toEqual([
      {
        source: "src/e.ts#file",
        target: "src/a.ts#method:inner",
        kind: "possible-call",
        resolved: false,
        at: "src/e.ts: service.inner",
      },
    ]);
    expect(
      graph.edges.filter((edge) => edge.resolved).every((edge) => edge.kind !== "possible-call"),
    ).toBe(true);
  });

  it("caps drawn nodes, keeping the largest changes and listing the rest", () => {
    const many = Array.from({ length: 6 }, (_, at) =>
      entity("src/m.ts", "function", `f${at}`, at * 10 + 1, at * 10 + 9),
    );
    const files = parseUnifiedDiff(
      [
        "diff --git a/src/m.ts b/src/m.ts",
        "--- a/src/m.ts",
        "+++ b/src/m.ts",
        ...many.flatMap((_, at) => [
          `@@ -${at * 10 + 2},0 +${at * 10 + 2},${at + 1} @@`,
          ...Array.from({ length: at + 1 }, () => "+x"),
        ]),
      ].join("\n"),
    );
    const graph = egoGraph(snapshot(many, []), files, 3);
    expect(graph.nodes.filter((node) => node.drawn).map((node) => node.name)).toEqual([
      "f3",
      "f4",
      "f5",
    ]);
    expect(graph.nodes).toHaveLength(6);
    expect(graph.omittedChanged).toBe(3);
  });

  it("falls back to file nodes without an index", () => {
    const graph = egoGraph(undefined, change("src/a.ts", 11, [11]));
    expect(graph.nodes.map((node) => node.id)).toEqual(["src/a.ts#file"]);
    expect(graph.edges).toEqual([]);
  });
});

const node = (id: string, slices: string[], path = id.split("#")[0] ?? id): UiMapNode => ({
  id,
  path,
  name: id,
  kind: "function",
  role: "changed",
  distance: 0,
  module: "src",
  slices: slices.map((slice) => ({ id: slice, via: "scope" })),
  outcomes: [],
  checks: [],
  findings: [],
  untested: false,
  unseenCallers: [],
  dynamicImports: 0,
  indexBehind: false,
  afterCheckpoints: false,
  drawn: true,
});
const edge = (source: string, target: string): UiMapEdge => ({
  source,
  target,
  kind: "calls",
  resolved: true,
});

describe("readingOrder", () => {
  it("groups by slice, puts changed callees first, tests after code, unexplained last", () => {
    const order = readingOrder(
      [
        node("src/z.ts#caller", ["T001"]),
        node("src/y.ts#callee", ["T001"]),
        node("test/a.test.ts#t", ["T001"]),
        node("src/a.ts#second", ["T002"]),
        node("src/b.ts#loose", []),
      ],
      [edge("src/z.ts#caller", "src/y.ts#callee")],
      ["T001", "T002"],
    );
    expect(order).toEqual([
      "src/y.ts#callee",
      "src/z.ts#caller",
      "test/a.test.ts#t",
      "src/a.ts#second",
      "src/b.ts#loose",
    ]);
  });

  it("survives a call cycle", () => {
    const order = readingOrder(
      [node("src/a.ts#a", ["T001"]), node("src/b.ts#b", ["T001"])],
      [edge("src/a.ts#a", "src/b.ts#b"), edge("src/b.ts#b", "src/a.ts#a")],
      ["T001"],
    );
    expect([...order].sort()).toEqual(["src/a.ts#a", "src/b.ts#b"]);
  });
});
