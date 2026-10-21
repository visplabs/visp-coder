import { matchesAny } from "../../core/patterns.js";
import { fileEntityId } from "../../graph/ids.js";
import { isTestPath } from "../../graph/index.js";
import type { SnapshotIndex } from "../../graph/query/index.js";
import { describeProductCheck } from "../../workflow/product/check/check-command.js";
import { namesExistingTest } from "../../workflow/product/regression-command-matching.js";
import type { ProductRecord } from "../../workflow/product/store.js";
import type {
  UiCheck,
  UiFeature,
  UiMapCheckLink,
  UiMapEdge,
  UiMapFindingLink,
  UiMapNode,
  UiMapSliceLink,
} from "../contract.js";
import type { FileHistory } from "./checkpoints.js";
import type { GraphNode } from "./graph.js";

export interface RecordContext {
  readonly record: ProductRecord;
  readonly view: UiFeature;
  readonly index: SnapshotIndex | undefined;
  readonly root: string;
  readonly history: ReadonlyMap<string, FileHistory>;
  readonly behind: ReadonlySet<string>;
}

/** Attaches what VISP recorded about a node's file: slices, outcomes, checks and findings. */
export function annotate(node: GraphNode, context: RecordContext): UiMapNode {
  const { graphTested, ...rest } = node;
  const changed = node.role === "changed";
  const history = context.history.get(node.path);
  const slices = changed ? sliceLinks(node.path, context, history) : [];
  const outcomes = [
    ...new Set(
      slices.flatMap(
        (link) => context.view.slices.find((slice) => slice.id === link.id)?.outcomes ?? [],
      ),
    ),
  ].sort();
  const checks = checkLinks(node.path, context);
  return {
    ...rest,
    slices,
    outcomes,
    checks,
    findings: findingLinks(node, context.view),
    untested: changed && !graphTested && checks.length === 0 && !isTestPath(node.path),
    indexBehind: context.behind.has(node.path),
    afterCheckpoints: changed && (history?.afterCheckpoints ?? false),
  };
}

function sliceLinks(
  path: string,
  context: RecordContext,
  history: FileHistory | undefined,
): UiMapSliceLink[] {
  const links: UiMapSliceLink[] = [];
  for (const slice of context.record.brief.slices) {
    const { allowed, expected, forbidden } = slice.scope;
    if (matchesAny(path, [...allowed, ...expected]) && !matchesAny(path, forbidden))
      links.push({ id: slice.id, via: "scope" });
  }
  for (const id of history?.slices ?? [])
    if (!links.some((link) => link.id === id && link.via === "checkpoint"))
      links.push({ id, via: "checkpoint" });
  return links;
}

/** Each check once, by the newest run any slice records, as the Now tab counts them. */
function latestChecks(view: UiFeature): Map<string, UiCheck> {
  const checks = new Map<string, UiCheck>();
  for (const check of view.slices.flatMap((slice) => slice.checks)) {
    const seen = checks.get(check.id);
    if (!seen || (check.latest?.createdAt ?? "") > (seen.latest?.createdAt ?? ""))
      checks.set(check.id, check);
  }
  return checks;
}

function checkLinks(path: string, context: RecordContext): UiMapCheckLink[] {
  const latest = latestChecks(context.view);
  const tests = context.index
    ? context.index
        .out(fileEntityId(path))
        .filter((relation) => relation.kind === "tested_by")
        .map((relation) => relation.path)
    : [];
  const links: UiMapCheckLink[] = [];
  for (const check of context.record.brief.checks) {
    const declared = matchesAny(path, check.files);
    const command = describeProductCheck(check);
    const runsTest =
      !declared &&
      [path, ...tests].some(
        (test) => isTestPath(test) && namesExistingTest(command, test, context.root),
      );
    if (!declared && !runsTest) continue;
    const run = latest.get(check.id)?.latest;
    links.push({
      id: check.id,
      via: declared ? "declared" : "test-command",
      status: run?.status ?? "not-run",
      current: run?.current ?? false,
      ...(run ? { execution: run.id } : {}),
    });
  }
  return links;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Open findings whose text names this file, a line inside this node, or this declaration as a call. */
function findingLinks(node: GraphNode, view: UiFeature): UiMapFindingLink[] {
  const links: UiMapFindingLink[] = [];
  for (const finding of view.findings) {
    const text = `${finding.problem}\n${finding.nextCheck}`;
    const lines = [...text.matchAll(new RegExp(`${escapeRegExp(node.path)}:(\\d+)`, "g"))].map(
      (match) => Number(match[1]),
    );
    const inside = lines.some(
      (line) =>
        node.startLine !== undefined &&
        node.endLine !== undefined &&
        line >= node.startLine &&
        line <= node.endLine,
    );
    const symbol =
      node.kind !== "file" &&
      node.name.length >= 3 &&
      new RegExp(`(^|[^\\w$.])${escapeRegExp(node.name)}\\(`).test(text);
    const via = inside
      ? "names-line"
      : symbol
        ? "names-symbol"
        : text.includes(node.path) && (lines.length === 0 || node.kind === "file")
          ? "names-file"
          : undefined;
    if (via)
      links.push({ id: finding.id, required: finding.required, problem: finding.problem, via });
  }
  return links;
}

/**
 * Changed nodes by the first slice that explains them (brief order), unexplained last; inside
 * a group, changed callees before their changed callers, code before tests, then path and line.
 */
export function readingOrder(
  nodes: readonly UiMapNode[],
  edges: readonly UiMapEdge[],
  sliceOrder: readonly string[],
): string[] {
  const changed = nodes.filter((node) => node.role === "changed");
  const group = (node: UiMapNode) => {
    const positions = node.slices
      .map((link) => sliceOrder.indexOf(link.id))
      .filter((at) => at >= 0);
    return positions.length ? Math.min(...positions) : sliceOrder.length;
  };
  const place = (a: UiMapNode, b: UiMapNode) =>
    group(a) - group(b) ||
    Number(isTestPath(a.path)) - Number(isTestPath(b.path)) ||
    a.path.localeCompare(b.path) ||
    (a.startLine ?? 0) - (b.startLine ?? 0) ||
    a.id.localeCompare(b.id);
  const ids = new Set(changed.map((node) => node.id));
  const callees = new Map<string, string[]>();
  for (const edge of edges)
    if (edge.kind === "calls" && ids.has(edge.source) && ids.has(edge.target))
      callees.set(edge.source, [...(callees.get(edge.source) ?? []), edge.target]);
  const byId = new Map(changed.map((node) => [node.id, node]));
  const order: string[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (node: UiMapNode) => {
    if (done.has(node.id) || visiting.has(node.id)) return;
    visiting.add(node.id);
    // A callee in a later slice waits for its own group; cycles fall back to place order.
    const before = (callees.get(node.id) ?? [])
      .map((id) => byId.get(id))
      .filter((callee): callee is UiMapNode => callee !== undefined && group(callee) <= group(node))
      .sort(place);
    for (const callee of before) visit(callee);
    visiting.delete(node.id);
    done.add(node.id);
    order.push(node.id);
  };
  for (const node of [...changed].sort(place)) visit(node);
  return order;
}
