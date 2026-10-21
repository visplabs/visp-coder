import type { WorkspaceState } from "../../state.js";
import { pinnedAcceptanceChecks } from "../check/acceptance-checks.js";
import { describeProductCheck, isBrowserCheckCommand } from "../check/check-command.js";
import { waiverEnvironment } from "../check/check-execution.js";
import { checksFor, closedSlice, type ProductCheck, type ProductSlice } from "../model.js";
import type { ProductAuthorization } from "../scopes.js";
import { type ProductRecord, readProductRecord } from "../store.js";
import { pinnedWaivers } from "../tester/pinned-dispute-model.js";
import { changeCandidates, projectRunners } from "./regression-coverage.js";

/** One command the gate may run: an existing test file, or an earlier declared or pinned check. */
export interface RegressionCandidate {
  /** How the report names it: a test path, a check id, or `<feature> <check id>`. */
  readonly label: string;
  readonly origin: "graph" | "convention" | "unlinked" | "feature" | "earlier-feature";
  readonly check: ProductCheck;
  readonly extraEnvironment?: Record<string, string>;
  /** How far the test is from a changed file: import hops, or a convention's strength. */
  readonly distance?: number;
}

/** Accepted features whose tests the gate considers, newest first. */
const EARLIER_FEATURES = 10;

const RANK: Record<RegressionCandidate["origin"], number> = {
  graph: 0,
  convention: 0,
  feature: 1,
  "earlier-feature": 2,
  unlinked: 4,
};

/**
 * Direct tests of the changed files first, then this feature's earlier slices, then earlier
 * accepted features (newest first), then tests further from the change, then tests linked to
 * no code. One command runs once.
 */
export function selectRegressionCandidates(
  candidates: readonly RegressionCandidate[],
  max: number,
): { selected: RegressionCandidate[]; overCap: RegressionCandidate[] } {
  const rank = (entry: RegressionCandidate) =>
    RANK[entry.origin] === 0 && (entry.distance ?? 1) > 1 ? 3 : RANK[entry.origin];
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
  const feature = await featureCandidates(workspace, record, slice);
  const earlier = await earlierFeatureCandidates(workspace, record.brief.feature);
  // Tests run through the project's own runner, as the checks this call and earlier work declared.
  const runners = projectRunners(workspace.paths.root, [
    ...ran,
    ...[...feature, ...earlier].map((entry) => entry.check),
  ]);
  const change = await changeCandidates(workspace, auth, snapshot, [...ranCommands], runners);
  return {
    candidates: [...change.candidates, ...feature, ...earlier].filter(fresh),
    notes: change.notes,
    blind: change.blind,
  };
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
