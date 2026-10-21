import { describe, expect, it } from "vitest";
import type { UiMapEdge, UiMapNode } from "../../../src/ui/contract.js";
import { layoutMap } from "../../../ui/src/map-layout.js";

const node = (id: string, role: UiMapNode["role"], module: string, distance = 1): UiMapNode => ({
  id,
  path: `${module}/${id}.ts`,
  name: id,
  kind: "function",
  role,
  distance: role === "changed" ? 0 : distance,
  startLine: 1,
  module,
  slices: [],
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
const calls = (source: string, target: string): UiMapEdge => ({
  source,
  target,
  kind: "calls",
  resolved: true,
});

const nodes = [
  node("b", "changed", "src/ui"),
  node("a", "changed", "src/ui"),
  node("c", "caller", "src/cli"),
  node("d", "caller", "src/cli"),
  node("t", "test", "tests"),
];
const edges = [calls("c", "a"), calls("d", "a"), calls("d", "b")];

describe("layoutMap", () => {
  it("is the same for the same nodes in any order", () => {
    const open = () => true;
    expect(layoutMap([...nodes].reverse(), edges, open)).toEqual(layoutMap(nodes, edges, open));
  });

  it("puts callers left of the change and tests to the right", () => {
    const layout = layoutMap(nodes, edges, () => true);
    expect(layout.columns.map((column) => column.title)).toEqual(["Callers", "Changed", "Tests"]);
    const x = (key: string) => layout.boxes.find((box) => box.key === key)?.x ?? -1;
    expect(x("c")).toBeLessThan(x("a"));
    expect(x("a")).toBeLessThan(x("t"));
    const y = (key: string) => layout.boxes.find((box) => box.key === key)?.y ?? -1;
    expect(y("a")).toBeLessThan(y("b"));
  });

  it("collapses a module into one box and counts the edges it merges", () => {
    const layout = layoutMap(nodes, edges, (module) => module !== "src/cli");
    const box = layout.boxes.find((entry) => entry.kind === "module");
    expect(box?.key).toBe("module:caller-1:src/cli");
    expect(box?.nodes.map((entry) => entry.id)).toEqual(["c", "d"]);
    expect(layout.links.map((link) => [link.from, link.to, link.count])).toEqual([
      ["module:caller-1:src/cli", "a", 2],
      ["module:caller-1:src/cli", "b", 1],
    ]);
  });

  it("leaves out nodes past the drawing limit", () => {
    const layout = layoutMap(
      [...nodes, { ...node("hidden", "changed", "src/ui"), drawn: false }],
      edges,
      () => true,
    );
    expect(layout.boxes.some((box) => box.key === "hidden")).toBe(false);
  });
});
