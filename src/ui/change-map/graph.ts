import { dirname } from "node:path";
import { sha256 } from "../../core/hash.js";
import { isExternalRef } from "../../graph/constants.js";
import { fileEntityId } from "../../graph/ids.js";
import { isTestPath } from "../../graph/paths.js";
import type { SnapshotIndex } from "../../graph/query/index.js";
import type { Entity, Relation } from "../../graph/types.js";
import type { UiMapEdge, UiMapRole } from "../contract.js";
import type { ParsedFile } from "./diff.js";

export const NODE_CAP = 40;

/** A node before VISP's records are attached: what the diff and the index say about it. */
export interface GraphNode {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly kind: string;
  readonly role: UiMapRole;
  readonly distance: number;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly module: string;
  readonly change?: {
    readonly hunks: readonly number[];
    readonly added: number;
    readonly removed: number;
    readonly digest: string;
  };
  /** Whether the index links a test to this node's file. */
  readonly graphTested: boolean;
  readonly unseenCallers: readonly string[];
  readonly dynamicImports: number;
  readonly drawn: boolean;
}

export interface EgoGraph {
  /** Every changed node, then the drawn neighbours. */
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly UiMapEdge[];
  readonly omittedChanged: number;
  readonly omittedNeighbours: number;
}

interface Seed {
  entity?: Entity;
  id: string;
  path: string;
  hunks: Set<number>;
  added: number;
  removed: number;
  digests: string[];
}

/**
 * The diff's changed declarations plus one or two hops of resolved callers, callees and tests,
 * capped at `cap` drawn nodes. Deterministic: every list is ordered by path, line and id.
 */
export function egoGraph(
  index: SnapshotIndex | undefined,
  files: readonly ParsedFile[],
  cap = NODE_CAP,
): EgoGraph {
  const seeds = seedNodes(index, files);
  const ranked = [...seeds.values()].sort(
    (a, b) => b.added + b.removed - (a.added + a.removed) || byPlace(a, b),
  );
  const drawnSeeds = new Set(ranked.slice(0, cap).map((seed) => seed.id));
  const changed = [...seeds.values()]
    .sort(byPlace)
    .map((seed) => changedNode(index, seed, drawnSeeds.has(seed.id)));
  const neighbours = index ? rankedNeighbours(index, seeds, drawnSeeds) : [];
  const room = Math.max(0, cap - drawnSeeds.size);
  const drawnNeighbours = neighbours.slice(0, room);
  const drawn = new Set([...drawnSeeds, ...drawnNeighbours.map((node) => node.id)]);
  return {
    nodes: [...changed, ...drawnNeighbours],
    edges: index ? edgesBetween(index, drawn, [...changed, ...drawnNeighbours]) : [],
    omittedChanged: seeds.size - drawnSeeds.size,
    omittedNeighbours: neighbours.length - drawnNeighbours.length,
  };
}

const byPlace = (
  a: { path: string; id: string; entity?: Entity; startLine?: number },
  b: { path: string; id: string; entity?: Entity; startLine?: number },
) =>
  a.path.localeCompare(b.path) ||
  (a.entity?.startLine ?? a.startLine ?? 0) - (b.entity?.startLine ?? b.startLine ?? 0) ||
  a.id.localeCompare(b.id);

function seedNodes(index: SnapshotIndex | undefined, files: readonly ParsedFile[]) {
  const seeds = new Map<string, Seed>();
  for (const file of files) {
    const entities =
      file.status === "deleted"
        ? []
        : (index?.byPath.get(file.path) ?? []).filter((entity) => entity.kind !== "file");
    const seedFor = (line?: number) => seedAt(seeds, file.path, entities, line);
    if (!file.hunks.length) seedFor();
    for (const [position, hunk] of file.hunks.entries()) {
      // Each changed line counts towards the declaration it falls inside.
      const owners = new Set<Seed>([
        ...hunk.addedAt.map((line) => count(seedFor(line), "added")),
        ...hunk.removedAt.map((line) => count(seedFor(line), "removed")),
      ]);
      for (const owner of owners) {
        owner.hunks.add(position);
        owner.digests.push(hunk.digest);
      }
    }
  }
  return seeds;
}

/** The seed for the declaration around a line, or for the file when no declaration holds it. */
function seedAt(
  seeds: Map<string, Seed>,
  path: string,
  entities: readonly Entity[],
  line: number | undefined,
): Seed {
  const entity = line === undefined ? undefined : innermost(entities, line);
  const id = entity?.id ?? fileEntityId(path);
  const existing = seeds.get(id);
  if (existing) return existing;
  const seed: Seed = {
    ...(entity ? { entity } : {}),
    id,
    path,
    hunks: new Set(),
    added: 0,
    removed: 0,
    digests: [],
  };
  seeds.set(id, seed);
  return seed;
}

function count(seed: Seed, field: "added" | "removed"): Seed {
  seed[field] += 1;
  return seed;
}

/** The smallest declaration containing the line; ties go to the one starting later. */
function innermost(entities: readonly Entity[], line: number): Entity | undefined {
  let best: Entity | undefined;
  for (const entity of entities) {
    if (entity.startLine > line || entity.endLine < line) continue;
    const span = entity.endLine - entity.startLine;
    const bestSpan = best ? best.endLine - best.startLine : Number.POSITIVE_INFINITY;
    if (!best || span < bestSpan || (span === bestSpan && entity.startLine > best.startLine))
      best = entity;
  }
  return best;
}

function changedNode(index: SnapshotIndex | undefined, seed: Seed, drawn: boolean): GraphNode {
  const entity = seed.entity;
  return {
    id: seed.id,
    path: seed.path,
    name: entity?.name ?? basename(seed.path),
    kind: entity?.kind ?? "file",
    role: "changed",
    distance: 0,
    ...(entity ? { startLine: entity.startLine, endLine: entity.endLine } : {}),
    module: moduleOf(seed.path),
    change: {
      hunks: [...seed.hunks].sort((a, b) => a - b),
      added: seed.added,
      removed: seed.removed,
      digest: sha256(seed.digests.join("\n")).slice(0, 16),
    },
    graphTested: index ? testsOf(index, seed.path).length > 0 : false,
    unseenCallers: index && entity ? unseenCallers(index, entity) : [],
    dynamicImports: index ? dynamicImports(index, seed.path) : 0,
    drawn,
  };
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const moduleOf = (path: string) => {
  const directory = dirname(path);
  return directory === "." ? "(root)" : directory;
};

function testsOf(index: SnapshotIndex, path: string) {
  return index
    .out(fileEntityId(path))
    .filter((relation) => relation.kind === "tested_by" && !isExternalRef(relation.target));
}

/** Unresolved calls in other files whose text ends with this name: possibly calls the index missed. */
function unseenCallers(index: SnapshotIndex, entity: Entity): string[] {
  if (!["function", "method", "class", "variable"].includes(entity.kind)) return [];
  const found = new Set<string>();
  for (const unknown of index.snapshot.unknowns) {
    if (unknown.kind !== "unresolved_call" || unknown.path === entity.path) continue;
    if (unknown.detail === entity.name || unknown.detail.endsWith(`.${entity.name}`))
      found.add(`${unknown.path}: ${unknown.detail}`);
  }
  return [...found].sort();
}

const dynamicImports = (index: SnapshotIndex, path: string) =>
  (index.unknownsByPath.get(path) ?? []).filter((unknown) => unknown.kind === "dynamic_import")
    .length;

interface Candidate extends GraphNode {
  readonly rank: number;
}

/** Neighbours found so far; a node keeps the best (lowest) rank it was reached with. */
class Neighbours {
  readonly found = new Map<string, Candidate>();

  constructor(
    private readonly index: SnapshotIndex,
    private readonly seeds: ReadonlyMap<string, Seed>,
  ) {}

  fileOf(path: string): Entity {
    return this.index.entity(fileEntityId(path)) ?? fileStub(path);
  }

  add(reached: Entity | undefined, wanted: UiMapRole, hops: number, order: number): void {
    if (!reached) return;
    // A test's own functions fold into its file, which stands for the test.
    const folded = wanted === "caller" && isTestPath(reached.path);
    const entity = folded ? this.fileOf(reached.path) : reached;
    const rank = folded ? 0 : order;
    if (this.seeds.has(entity.id)) return;
    const existing = this.found.get(entity.id);
    if (existing && existing.rank <= rank) return;
    this.found.set(entity.id, {
      ...neighbourNode(entity, folded ? "test" : wanted, folded ? 1 : hops),
      rank,
    });
  }
}

function neighbourNode(entity: Entity, role: UiMapRole, distance: number): GraphNode {
  return {
    id: entity.id,
    path: entity.path,
    name: entity.kind === "file" ? basename(entity.path) : entity.name,
    kind: entity.kind,
    role,
    distance,
    ...(entity.kind === "file" ? {} : { startLine: entity.startLine, endLine: entity.endLine }),
    module: moduleOf(entity.path),
    graphTested: false,
    unseenCallers: [],
    dynamicImports: 0,
    drawn: true,
  };
}

const calling = (relations: readonly Relation[]) =>
  relations.filter((relation) => relation.kind === "calls" && !isExternalRef(relation.target));

/** Tests, then callers, callees, name-matched callers and second-hop callers. */
function rankedNeighbours(
  index: SnapshotIndex,
  seeds: ReadonlyMap<string, Seed>,
  drawnSeeds: ReadonlySet<string>,
): GraphNode[] {
  const neighbours = new Neighbours(index, seeds);
  for (const seed of [...seeds.values()].filter((entry) => drawnSeeds.has(entry.id))) {
    for (const relation of testsOf(index, seed.path))
      neighbours.add(index.entity(relation.target), "test", 1, 0);
    for (const relation of calling(index.in(seed.id)))
      neighbours.add(index.entity(relation.source), "caller", 1, 1);
    for (const relation of calling(index.out(seed.id)))
      neighbours.add(index.entity(relation.target), "callee", 1, 2);
    for (const caller of seed.entity ? unseenCallers(index, seed.entity) : [])
      neighbours.add(neighbours.fileOf(callerPath(caller)), "caller", 1, 3);
  }
  const firstCallers = [...neighbours.found.values()].filter((node) => node.rank === 1);
  for (const first of firstCallers)
    for (const relation of calling(index.in(first.id)))
      neighbours.add(index.entity(relation.source), "caller", 2, 4);
  return [...neighbours.found.values()]
    .sort((a, b) => a.rank - b.rank || byPlace(a, b))
    .map(({ rank: _rank, ...node }) => node);
}

const callerPath = (caller: string) => caller.slice(0, caller.indexOf(": "));

/** A test file node speaks for the functions in it. */
function outgoing(index: SnapshotIndex, node: GraphNode) {
  if (node.role !== "test") return index.out(node.id);
  return (index.byPath.get(node.path) ?? []).flatMap((entity) =>
    index.out(entity.id).map((relation) => ({ ...relation, source: node.id })),
  );
}

function fileStub(path: string): Entity {
  return {
    id: fileEntityId(path),
    path,
    kind: "file",
    name: basename(path),
    startLine: 1,
    endLine: 1,
  };
}

/** Resolved relations among drawn nodes, and dashed name matches to the files that may call. */
function edgesBetween(
  index: SnapshotIndex,
  drawn: ReadonlySet<string>,
  nodes: readonly GraphNode[],
): UiMapEdge[] {
  const tests = new Set(nodes.filter((node) => node.role === "test").map((node) => node.id));
  const edges = new Map<string, UiMapEdge>();
  for (const node of nodes.filter((entry) => drawn.has(entry.id)))
    for (const edge of [
      ...callEdges(index, node, drawn),
      ...(node.role === "changed" ? changeEdges(index, node, drawn, tests) : []),
    ])
      edges.set(`${edge.source}\u0000${edge.target}\u0000${edge.kind}`, edge);
  return [...edges.values()].sort(
    (a, b) =>
      a.source.localeCompare(b.source) ||
      a.target.localeCompare(b.target) ||
      a.kind.localeCompare(b.kind),
  );
}

function callEdges(index: SnapshotIndex, node: GraphNode, drawn: ReadonlySet<string>): UiMapEdge[] {
  return calling(outgoing(index, node))
    .filter((relation) => drawn.has(relation.target) && relation.target !== node.id)
    .map((relation) => ({
      source: node.id,
      target: relation.target,
      kind: "calls",
      resolved: true,
      at: `${relation.path}:${relation.line}`,
    }));
}

function changeEdges(
  index: SnapshotIndex,
  node: GraphNode,
  drawn: ReadonlySet<string>,
  tests: ReadonlySet<string>,
): UiMapEdge[] {
  const tested: UiMapEdge[] = testsOf(index, node.path)
    .filter((relation) => tests.has(relation.target) && drawn.has(relation.target))
    .map((relation) => ({
      source: node.id,
      target: relation.target,
      kind: "tested_by",
      resolved: true,
      at: `${relation.path}:${relation.line}`,
    }));
  const guessed: UiMapEdge[] = node.unseenCallers
    .filter((caller) => drawn.has(fileEntityId(callerPath(caller))))
    .map((caller) => ({
      source: fileEntityId(callerPath(caller)),
      target: node.id,
      kind: "possible-call",
      resolved: false,
      at: caller,
    }));
  return [...tested, ...guessed];
}
