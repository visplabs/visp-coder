import type { UiMapEdge, UiMapNode } from "../../src/ui/contract.js";

/**
 * A fixed, deterministic layout for the Map tab: columns by relation to the change, modules
 * (directories) as groups inside a column, nodes by path and line. The same nodes always land in
 * the same place, so a live update never moves what a person is looking at.
 */

export const BOX_WIDTH = 208;
export const BOX_HEIGHT = 36;
const COLUMN_GAP = 72;
const ROW_GAP = 8;
const HEADER_HEIGHT = 22;
const GROUP_GAP = 14;
const TOP = 28;

const COLUMNS = [
  { key: "caller-2", title: "Callers of callers" },
  { key: "caller-1", title: "Callers" },
  { key: "changed", title: "Changed" },
  { key: "callee-1", title: "Called by the change" },
  { key: "test-1", title: "Tests" },
] as const;

type ColumnKey = (typeof COLUMNS)[number]["key"];

export interface LayoutBox {
  /** A node id, or `module:<column>:<module>` for a collapsed module. */
  readonly key: string;
  readonly kind: "node" | "module";
  readonly x: number;
  readonly y: number;
  readonly module: string;
  readonly column: ColumnKey;
  /** For a node box, the node; for a module box, every node it holds. */
  readonly nodes: readonly UiMapNode[];
}

export interface LayoutLabel {
  readonly x: number;
  readonly y: number;
  readonly module: string;
  readonly open: boolean;
  readonly count: number;
}

export interface LayoutLink {
  readonly from: string;
  readonly to: string;
  readonly kind: UiMapEdge["kind"];
  readonly resolved: boolean;
  /** How many relations this line stands for once modules are collapsed. */
  readonly count: number;
  readonly path: string;
  readonly labelX: number;
  readonly labelY: number;
  readonly edges: readonly UiMapEdge[];
}

export interface MapLayout {
  readonly width: number;
  readonly height: number;
  readonly columns: readonly { readonly title: string; readonly x: number }[];
  readonly boxes: readonly LayoutBox[];
  readonly labels: readonly LayoutLabel[];
  readonly links: readonly LayoutLink[];
}

function columnOf(node: UiMapNode): ColumnKey {
  if (node.role === "changed") return "changed";
  if (node.role === "test") return "test-1";
  if (node.role === "callee") return "callee-1";
  return node.distance >= 2 ? "caller-2" : "caller-1";
}

const byPlace = (a: UiMapNode, b: UiMapNode) =>
  a.path.localeCompare(b.path) ||
  (a.startLine ?? 0) - (b.startLine ?? 0) ||
  a.id.localeCompare(b.id);

export function layoutMap(
  nodes: readonly UiMapNode[],
  edges: readonly UiMapEdge[],
  isOpen: (module: string) => boolean,
): MapLayout {
  const drawn = nodes.filter((node) => node.drawn);
  const used = COLUMNS.filter((column) => drawn.some((node) => columnOf(node) === column.key));
  const boxes: LayoutBox[] = [];
  const labels: LayoutLabel[] = [];
  const boxOf = new Map<string, string>();
  let height = TOP;
  for (const [index, column] of used.entries()) {
    const x = index * (BOX_WIDTH + COLUMN_GAP);
    let y = TOP;
    const inColumn = drawn.filter((node) => columnOf(node) === column.key);
    const modules = [...new Set(inColumn.map((node) => node.module))].sort();
    for (const module of modules) {
      const members = inColumn.filter((node) => node.module === module).sort(byPlace);
      const open = isOpen(module);
      labels.push({ x, y, module, open, count: members.length });
      y += HEADER_HEIGHT;
      if (open)
        for (const node of members) {
          boxes.push({
            key: node.id,
            kind: "node",
            x,
            y,
            module,
            column: column.key,
            nodes: [node],
          });
          boxOf.set(node.id, node.id);
          y += BOX_HEIGHT + ROW_GAP;
        }
      else {
        const key = `module:${column.key}:${module}`;
        boxes.push({ key, kind: "module", x, y, module, column: column.key, nodes: members });
        for (const node of members) boxOf.set(node.id, key);
        y += BOX_HEIGHT + ROW_GAP;
      }
      y += GROUP_GAP;
    }
    height = Math.max(height, y);
  }
  const width = Math.max(BOX_WIDTH, used.length * (BOX_WIDTH + COLUMN_GAP) - COLUMN_GAP);
  return {
    width,
    height,
    columns: used.map((column, index) => ({
      title: column.title,
      x: index * (BOX_WIDTH + COLUMN_GAP),
    })),
    boxes,
    labels,
    links: links(edges, boxOf, new Map(boxes.map((box) => [box.key, box]))),
  };
}

/** Edges between boxes; collapsed modules merge theirs and count them. A box's own edges are hidden. */
function links(
  edges: readonly UiMapEdge[],
  boxOf: ReadonlyMap<string, string>,
  boxes: ReadonlyMap<string, LayoutBox>,
): LayoutLink[] {
  const merged = new Map<string, { from: string; to: string; edge: UiMapEdge; all: UiMapEdge[] }>();
  for (const edge of edges) {
    const from = boxOf.get(edge.source);
    const to = boxOf.get(edge.target);
    if (!from || !to || from === to) continue;
    const key = `${from}\u0000${to}\u0000${edge.kind}\u0000${edge.resolved}`;
    const existing = merged.get(key);
    if (existing) existing.all.push(edge);
    else merged.set(key, { from, to, edge, all: [edge] });
  }
  return [...merged.values()]
    .map(({ from, to, edge, all }) => {
      const source = boxes.get(from) as LayoutBox;
      const target = boxes.get(to) as LayoutBox;
      return {
        from,
        to,
        kind: edge.kind,
        resolved: edge.resolved,
        count: all.length,
        edges: all,
        ...curve(source, target),
      };
    })
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

/** Left to right between columns; an arc on the right inside one column. */
function curve(source: LayoutBox, target: LayoutBox) {
  const sy = source.y + BOX_HEIGHT / 2;
  const ty = target.y + BOX_HEIGHT / 2;
  if (source.x === target.x) {
    const x = source.x + BOX_WIDTH;
    const bend = 28 + Math.min(40, Math.abs(ty - sy) / 6);
    return {
      path: `M${x} ${sy} C${x + bend} ${sy} ${x + bend} ${ty} ${x} ${ty}`,
      labelX: x + bend * 0.75,
      labelY: (sy + ty) / 2,
    };
  }
  const forward = source.x < target.x;
  const sx = forward ? source.x + BOX_WIDTH : source.x;
  const tx = forward ? target.x : target.x + BOX_WIDTH;
  const mid = (sx + tx) / 2;
  return {
    path: `M${sx} ${sy} C${mid} ${sy} ${mid} ${ty} ${tx} ${ty}`,
    labelX: mid,
    labelY: (sy + ty) / 2,
  };
}
