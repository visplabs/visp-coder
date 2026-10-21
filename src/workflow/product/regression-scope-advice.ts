import { hashValue, sha256 } from "../../core/hash.js";
import { ok, type Result } from "../../core/result.js";
import { isApplicationSource } from "../../graph/coverage-notes.js";
import { type GraphStore, isTestPath, openProjectStore } from "../../graph/index.js";
import type { WorkspaceState } from "../state.js";
import { describeProductCheck } from "./check/check-command.js";
import { observedProductGraphCurrency } from "./context-graph.js";
import type { ProductSlice } from "./model.js";
import { currentRegressionGate, regressionGateGaps } from "./regression/regression-report.js";
import { namesExistingTest } from "./regression-command-matching.js";
import { type ProductAuthorization, readProductAuthorizationBaseline } from "./scopes.js";
import { sourceEntryHash } from "./source-entry.js";
import type { ProductNext } from "./status.js";
import type { ProductRecord } from "./store.js";
import { productSourceChanges, productSourceSnapshot } from "./subject.js";

const ADVICE_PREFIX = "Existing tests also exercise the files you changed: ";
const MAX_TESTS = 8;
const RELATED_TESTS = new Map<string, ReadonlySet<string>>();
const MAX_CACHED_SCOPES = 32;

/**
 * Advisory only: missing graph or baseline context never becomes a product gate. With
 * `workflow.regressionGate` on, VISP runs these tests itself, so there is no advice to run them.
 */
export async function regressionScopeAdvice(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice?: ProductSlice,
  sourceSnapshot?: Record<string, string>,
): Promise<string | undefined> {
  if (record.state.status !== "active" || workspace.config.workflow.regressionGate !== "off")
    return undefined;
  const authorization = await regressionBaseline(workspace, record);
  if (!authorization.ok || !authorization.value) return undefined;
  const auth = authorization.value;
  const selected = slice ?? record.brief.slices.find((entry) => entry.id === auth.task);
  if (!selected || selected.id !== auth.task) return undefined;
  const missing = sourceEntryHash(undefined);
  const existingTests = new Set(
    Object.entries(auth.baseline)
      .filter(([path, hash]) => isTestPath(path) && hash !== missing)
      .map(([path]) => path),
  );
  if (!existingTests.size) return undefined;
  const store = await openProjectStore(workspace.files, workspace.paths.graphStore);
  if (!store.ok) return undefined;
  try {
    const changed = await changedSourcePaths(workspace, record, auth, sourceSnapshot);
    if (!changed.size) return undefined;
    const related = await coveredRelatedTests(workspace, store.value, changed);
    if (!related) return undefined;
    const commands = sliceCommands(record, selected);
    const paths = [...related]
      .filter(
        (path) =>
          existingTests.has(path) &&
          !commands.some((command) => namesExistingTest(command, path, workspace.paths.root)),
      )
      .sort()
      .slice(0, MAX_TESTS);
    return paths.length
      ? `${ADVICE_PREFIX}${paths.join(", ")}. Run them with your test command before visp done; a new failure there is a regression unless the request changes that behavior.`
      : undefined;
  } finally {
    store.value.close();
  }
}

const regressionBaselinePath = (workspace: WorkspaceState, feature: string) =>
  workspace.paths.stateFile(`state/product-regression-baselines/${feature}.json`);

/** Best-effort context survives authorization revocation; it is never read by scope checks. */
export async function retainRegressionScopeBaseline(
  workspace: WorkspaceState,
  auth: ProductAuthorization,
  saved: boolean,
): Promise<void> {
  if (saved) await workspace.files.writeJson(regressionBaselinePath(workspace, auth.feature), auth);
}

/** The baseline the current slice started from, or the last one `work` retained. */
export async function regressionBaseline(workspace: WorkspaceState, record: ProductRecord) {
  const current = await readProductAuthorizationBaseline(workspace, record);
  if (!current.ok || current.value) return current;
  return readProductAuthorizationBaseline(
    workspace,
    record,
    regressionBaselinePath(workspace, record.brief.feature),
  );
}

async function changedSourcePaths(
  workspace: WorkspaceState,
  record: ProductRecord,
  auth: ProductAuthorization,
  sourceSnapshot?: Record<string, string>,
): Promise<Set<string>> {
  const snapshot =
    sourceSnapshot === undefined
      ? await productSourceSnapshot(workspace, record.brief)
      : ok(sourceSnapshot);
  if (!snapshot.ok) return new Set();
  const changes = await productSourceChanges(workspace, auth.baseline, snapshot.value);
  return new Set(changes.ok ? changes.value.filter(isApplicationSource) : []);
}

/** Hash only changed files, so advice never walks the repository for currency. */
async function coveredRelatedTests(
  workspace: WorkspaceState,
  store: GraphStore,
  changed: ReadonlySet<string>,
): Promise<ReadonlySet<string> | undefined> {
  const identity = store.readHeadIdentity();
  if (!identity.ok || !identity.value) return undefined;
  const snapshotId = identity.value.split("\0")[0] ?? "";
  if (observedProductGraphCurrency(workspace, snapshotId)?.gap) return undefined;
  const hashes = await changedContentHashes(workspace, changed);
  if (!hashes) return undefined;
  const key = `${workspace.paths.root}\0${store.cachePath}\0${identity.value}\0${hashValue([...hashes])}`;
  const cached = RELATED_TESTS.get(key);
  if (cached) return cached;
  const scope = store.readTestScope(snapshotId, [...changed]);
  if (!scope.ok || !scope.value || scope.value.root !== workspace.paths.root) return undefined;
  const recorded = new Map(scope.value.files.map((file) => [file.path, file.hash]));
  if ([...hashes].some(([path, hash]) => recorded.get(path) !== hash)) return undefined;
  const related = scope.value.tests;
  RELATED_TESTS.set(key, related);
  if (RELATED_TESTS.size > MAX_CACHED_SCOPES)
    RELATED_TESTS.delete(RELATED_TESTS.keys().next().value ?? "");
  return related;
}

async function changedContentHashes(workspace: WorkspaceState, changed: ReadonlySet<string>) {
  const hashes = new Map<string, string>();
  for (const path of [...changed].sort()) {
    const metadata = await workspace.files.readMetadata(path);
    if (
      !metadata.ok ||
      metadata.value?.type !== "file" ||
      metadata.value.size > workspace.config.graph.maxFileBytes
    )
      return undefined;
    const bytes = await workspace.files.readBytes(path);
    if (!bytes.ok) return undefined;
    hashes.set(path, sha256(bytes.value));
  }
  return hashes;
}

function sliceCommands(record: ProductRecord, slice: ProductSlice): string[] {
  return [
    ...record.brief.checks
      .filter((check) => slice.checks.includes(check.id))
      .map(describeProductCheck),
    ...record.state.executions
      .filter(
        (entry) => entry.task === slice.id || (!entry.task && slice.checks.includes(entry.check)),
      )
      .map((entry) => entry.command),
  ];
}

export async function regressionScopeLimitations(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice | undefined,
  snapshot: Record<string, string>,
): Promise<{ limitations?: readonly string[] }> {
  const advice = await regressionScopeAdvice(workspace, record, slice, snapshot);
  return advice ? { limitations: [advice] } : {};
}

export async function withRegressionScopeAdviceResult(
  workspace: WorkspaceState,
  record: ProductRecord,
  next: Result<ProductNext>,
  sourceSnapshot?: Record<string, string>,
  subject?: string,
): Promise<Result<ProductNext>> {
  return next.ok
    ? ok(
        await withRegressionScopeAdvice(
          workspace,
          record,
          next.value,
          undefined,
          sourceSnapshot,
          subject,
        ),
      )
    : next;
}

/** The scope advice, or with the regression gate on, the regressions it found in this version. */
export async function withRegressionScopeAdvice(
  workspace: WorkspaceState,
  record: ProductRecord,
  next: ProductNext,
  slice?: ProductSlice,
  sourceSnapshot?: Record<string, string>,
  subject?: string,
): Promise<ProductNext> {
  if (workspace.config.workflow.regressionGate !== "off") {
    const gate = subject && (await currentRegressionGate(workspace, record.brief.feature, subject));
    const lines = gate ? regressionGateGaps(gate).slice(0, 3) : [];
    return lines.length && !next.evidence.includes(lines[0] as string)
      ? { ...next, evidence: [...lines, ...next.evidence] }
      : next;
  }
  if (next.evidence.some((line) => line.startsWith(ADVICE_PREFIX))) return next;
  const advice = await regressionScopeAdvice(workspace, record, slice, sourceSnapshot);
  if (!advice) return next;
  const firstDone = next.evidence[0]?.startsWith("No visp done yet after ") ? 1 : 0;
  return {
    ...next,
    evidence: [...next.evidence.slice(0, firstDone), advice, ...next.evidence.slice(firstDone)],
  };
}
