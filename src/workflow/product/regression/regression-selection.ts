import { isExternalRef } from "../../../graph/constants.js";
import { isApplicationSource } from "../../../graph/coverage-notes.js";
import {
  isTestPath,
  openProjectStore,
  pathOfEntityId,
  queryGraph,
  refreshRepository,
} from "../../../graph/index.js";
import { getQueryIndex } from "../../../graph/query/index.js";
import type { WorkspaceState } from "../../state.js";
import { pinnedAcceptanceChecks } from "../check/acceptance-checks.js";
import { describeProductCheck, isBrowserCheckCommand } from "../check/check-command.js";
import { waiverEnvironment } from "../check/check-execution.js";
import { checksFor, closedSlice, type ProductCheck, type ProductSlice } from "../model.js";
import { namesExistingTest } from "../regression-command-matching.js";
import type { ProductAuthorization } from "../scopes.js";
import { MISSING_SOURCE_ENTRY } from "../source-entry.js";
import { type ProductRecord, readProductRecord } from "../store.js";
import { productSourceChanges } from "../subject.js";
import { pinnedWaivers } from "../tester/pinned-dispute-model.js";
import { testFileCommand, testRunnerFacts } from "./regression-runner.js";

/** One command the gate may run: an existing test file, or an earlier declared or pinned check. */
export interface RegressionCandidate {
  /** How the report names it: a test path, a check id, or `<feature> <check id>`. */
  readonly label: string;
  readonly origin: "graph" | "feature" | "earlier-feature";
  readonly check: ProductCheck;
  readonly extraEnvironment?: Record<string, string>;
  /** Graph hops from a changed file to the test. */
  readonly distance?: number;
}

/** Hops the impact walk follows from a changed file: its tests, its importers' tests, and one more. */
const GRAPH_DEPTH = 3;
/**
 * A test file that imports no application code (it drives the product through a subprocess or
 * HTTP) may exercise any changed file, so the graph cannot rule it out; it ranks after linked tests.
 */
const BLACK_BOX = GRAPH_DEPTH + 1;
/** Accepted features whose tests the gate considers, newest first. */
const EARLIER_FEATURES = 10;

/**
 * Direct tests of the changed files first, then this feature's earlier slices, then earlier
 * accepted features (newest first), then tests further away in the graph. One command runs once.
 */
export function selectRegressionCandidates(
  candidates: readonly RegressionCandidate[],
  max: number,
): { selected: RegressionCandidate[]; overCap: RegressionCandidate[] } {
  const rank = (entry: RegressionCandidate) =>
    entry.origin === "graph"
      ? (entry.distance ?? GRAPH_DEPTH) <= 1
        ? 0
        : 3
      : entry.origin === "feature"
        ? 1
        : 2;
  const ordered = candidates
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        rank(a.entry) - rank(b.entry) ||
        (a.entry.distance ?? 0) - (b.entry.distance ?? 0) ||
        a.index - b.index,
    )
    .map(({ entry }) => entry);
  const seen = new Set<string>();
  const distinct = ordered.filter((entry) => {
    const command = describeProductCheck(entry.check);
    if (seen.has(command)) return false;
    seen.add(command);
    return true;
  });
  return { selected: distinct.slice(0, max), overCap: distinct.slice(max) };
}

/**
 * Everything the gate could run for this `done` or `accept`, minus commands the call already ran,
 * with notes on what it could not consider (no graph, no baseline, a test it cannot run).
 */
export async function regressionCandidates(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice | undefined,
  auth: ProductAuthorization | undefined,
  snapshot: Record<string, string>,
  ran: readonly ProductCheck[],
): Promise<{ candidates: RegressionCandidate[]; notes: string[]; blind: boolean }> {
  const ranCommands = new Set(ran.map(describeProductCheck));
  const fresh = (entry: RegressionCandidate) =>
    !isBrowserCheckCommand(entry.check.command) &&
    !ranCommands.has(describeProductCheck(entry.check));
  const graph = await graphCandidates(workspace, auth, snapshot, [...ranCommands]);
  const feature = await featureCandidates(workspace, record, slice);
  const earlier = await earlierFeatureCandidates(workspace, record.brief.feature);
  return {
    candidates: [...graph.candidates, ...feature, ...earlier].filter(fresh),
    notes: graph.notes,
    blind: graph.blind,
  };
}

async function graphCandidates(
  workspace: WorkspaceState,
  auth: ProductAuthorization | undefined,
  snapshot: Record<string, string>,
  ranCommands: readonly string[],
): Promise<{ candidates: RegressionCandidate[]; notes: string[]; blind: boolean }> {
  const blind = (note: string) => ({ candidates: [], notes: [note], blind: true });
  if (!auth) return blind("no baseline of the code before this work, so its changes are unknown");
  const changes = await productSourceChanges(workspace, auth.baseline, snapshot);
  if (!changes.ok) return blind(`changed files unknown: ${changes.error.message}`);
  const changed = changes.value.filter(isApplicationSource);
  if (!changed.length) return { candidates: [], notes: [], blind: false };
  const tests = await coveringTests(workspace, changed);
  if (!tests.ok) return blind(`graph unavailable: ${tests.reason}`);
  const existed = (path: string) =>
    auth.baseline[path] !== undefined && auth.baseline[path] !== MISSING_SOURCE_ENTRY;
  const found = new Map(tests.found);
  for (const path of tests.blackBox) if (!found.has(path)) found.set(path, BLACK_BOX);
  const paths = [...found]
    .filter(
      ([path]) =>
        existed(path) &&
        !ranCommands.some((command) => namesExistingTest(command, path, workspace.paths.root)),
    )
    .sort(([a], [b]) => a.localeCompare(b));
  const runnable = await testFileCandidates(workspace, paths);
  const uncovered = tests.uncovered.length === 1 ? tests.uncovered[0] : undefined;
  return {
    candidates: runnable.candidates,
    notes: [
      ...runnable.notes,
      ...(tests.uncovered.length
        ? [
            `no existing test reaches ${uncovered ?? `${tests.uncovered.length} changed files`} in the graph`,
          ]
        : []),
    ],
    blind: false,
  };
}

/** A command for each test file, run the way its project runs tests, or a note why not. */
async function testFileCandidates(
  workspace: WorkspaceState,
  paths: readonly (readonly [string, number])[],
): Promise<{ candidates: RegressionCandidate[]; notes: string[] }> {
  const facts = await testRunnerFacts(workspace.paths.root);
  const candidates: RegressionCandidate[] = [];
  const notes: string[] = [];
  for (const [path, distance] of paths) {
    const source = await workspace.files.readTextIfExists(path);
    const command = source.ok ? testFileCommand(path, source.value ?? "", facts) : undefined;
    if (command)
      candidates.push({
        label: path,
        origin: "graph",
        distance,
        check: { id: "REGRESSION", command, outcomes: [], files: [path], environment: "other" },
      });
    else notes.push(`no known way to run ${path}`);
  }
  return { candidates, notes };
}

/**
 * Test files within GRAPH_DEPTH hops of each changed file, and test files that import no
 * application code, from a refreshed index.
 */
async function coveringTests(
  workspace: WorkspaceState,
  changed: readonly string[],
): Promise<
  | { ok: true; found: Map<string, number>; uncovered: string[]; blackBox: string[] }
  | { ok: false; reason: string }
> {
  const indexed = await refreshRepository(
    workspace.paths.root,
    workspace.config.graph,
    workspace.paths.graphStore,
  );
  if (!indexed.ok) return { ok: false, reason: indexed.error.message };
  const store = await openProjectStore(workspace.files, workspace.paths.graphStore, {
    writable: false,
  });
  if (!store.ok) return { ok: false, reason: store.error.message };
  try {
    const found = new Map<string, number>();
    const uncovered: string[] = [];
    for (const path of changed) {
      const impact = queryGraph(store.value, "impact", { path }, { depth: GRAPH_DEPTH });
      if (!impact.ok) return { ok: false, reason: impact.error.message };
      const tests = impact.value.rows.filter((row) => isTestPath(row.path));
      if (!tests.length) uncovered.push(path);
      for (const row of tests) {
        const distance = row.distance ?? GRAPH_DEPTH;
        found.set(row.path, Math.min(found.get(row.path) ?? distance, distance));
      }
    }
    const index = getQueryIndex(store.value);
    if (!index.ok) return { ok: false, reason: index.error.message };
    const linked = new Set(
      index.value.snapshot.relations
        .filter(
          (relation) =>
            relation.kind === "imports" &&
            !isExternalRef(relation.target) &&
            isApplicationSource(pathOfEntityId(relation.target)),
        )
        .map((relation) => relation.path),
    );
    const blackBox = index.value.snapshot.files
      .map((file) => file.path)
      .filter((path) => isTestPath(path) && !linked.has(path));
    return { ok: true, found, uncovered, blackBox };
  } finally {
    store.value.close();
  }
}

/** This feature's pinned suite and the checks of its other closed slices. */
async function featureCandidates(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice | undefined,
): Promise<RegressionCandidate[]> {
  const closed = record.brief.slices.filter(
    (entry) => entry.id !== slice?.id && closedSlice(record.state.slices[entry.id]?.status),
  );
  const declared = closed.flatMap((entry) => checksFor(record.brief, entry));
  return [
    ...(await pinnedCandidates(workspace, record, "feature")),
    ...declared.map((check) => ({ label: check.id, origin: "feature" as const, check })),
  ];
}

async function pinnedCandidates(
  workspace: WorkspaceState,
  record: ProductRecord,
  origin: RegressionCandidate["origin"],
): Promise<RegressionCandidate[]> {
  const pinned = pinnedAcceptanceChecks(record.brief);
  if (!pinned.length) return [];
  const extraEnvironment = waiverEnvironment(await pinnedWaivers(workspace, record.brief.feature));
  const prefix = origin === "feature" ? "" : `${record.brief.feature} `;
  return pinned.map((check) => ({
    label: `${prefix}${check.id}`,
    origin,
    check,
    ...(Object.keys(extraEnvironment).length ? { extraEnvironment } : {}),
  }));
}

/** Pinned suites, then declared checks, of the most recently accepted features. */
async function earlierFeatureCandidates(
  workspace: WorkspaceState,
  current: string,
): Promise<RegressionCandidate[]> {
  const listed = await workspace.store.listFeatures();
  if (!listed.ok) return [];
  const pinned: RegressionCandidate[] = [];
  const declared: RegressionCandidate[] = [];
  let considered = 0;
  for (const feature of listed.value) {
    if (feature === current || considered >= EARLIER_FEATURES) continue;
    const record = await readProductRecord(workspace, { feature });
    if (!record.ok || record.value.state.status !== "accepted") continue;
    considered++;
    pinned.push(...(await pinnedCandidates(workspace, record.value, "earlier-feature")));
    for (const check of record.value.brief.checks)
      declared.push({ label: `${feature} ${check.id}`, origin: "earlier-feature", check });
  }
  return [...pinned, ...declared];
}
