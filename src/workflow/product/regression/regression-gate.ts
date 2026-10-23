import { realpath } from "node:fs/promises";
import type { CommandOutput } from "../../../core/exec.js";
import { resolvedProductExecutionEnvironment } from "../../../core/execution-environment.js";
import { hashValue } from "../../../core/hash.js";
import { outputRedactor } from "../../../core/redaction.js";
import type { Result } from "../../../core/result.js";
import type { WorkspaceState } from "../../state.js";
import { describeProductCheck } from "../check/check-command.js";
import { runProductCheckCommand } from "../check/check-execution.js";
import { configuredMissingTool } from "../check/configured-checks.js";
import { comparisonBlocker, flipRunEnvironmentFailure } from "../flip/flip-check.js";
import {
  captureFlipEnvironment,
  disposeFlipEnvironment,
  reboundFlipEnvironment,
} from "../flip/flip-environment.js";
import { inFlipTree, recoverFlipBaseline } from "../flip/flip-tree.js";
import { flipValidationPaths } from "../flip/flip-validation.js";
import type { ProductCheck, ProductExecution, ProductSlice } from "../model.js";
import { regressionBaseline } from "../regression-scope-advice.js";
import { reviewCheckPaths } from "../review/review-check-context.js";
import { sandboxDenial } from "../sandbox-denial.js";
import type { ProductAuthorization } from "../scopes.js";
import type { ProductRecord } from "../store.js";
import { productSourceChanges } from "../subject.js";
import {
  classifyRegression,
  failureIdentities,
  type RegressionRun,
  rejectedCommandLine,
} from "./regression-failures.js";
import {
  type RegressionGateReport,
  type RegressionGateResult,
  type RegressionSelection,
  readRegressionGate,
} from "./regression-report.js";
import {
  type RegressionCandidate,
  regressionCandidates,
  selectRegressionCandidates,
} from "./regression-selection.js";

/** Commands one gate runs at most, and the wall-clock all its runs share. */
const MAX_COMMANDS = 12;
const BUDGET_MS = 180_000;
const RUN_TIMEOUT_MS = 90_000;
const MIN_RUN_MS = 2_000;
/** A missing test runner is an environment, not a product failure. */
const RUNNER_MISSING = /No module named '?(?:pytest|unittest)\b/;

interface Entry {
  readonly candidate: RegressionCandidate;
  readonly now: RegressionRun;
  rerun?: RegressionRun;
  before?: RegressionRun;
  skipped?: string;
}

/** What every run of one gate shares: the workspace, the deadline, redaction and cancellation. */
interface GateRun {
  readonly workspace: WorkspaceState;
  readonly deadline: number;
  readonly redact: (text: string) => string;
  readonly signal?: AbortSignal;
}

const spent = (run: GateRun) =>
  run.signal?.aborted === true || run.deadline - Date.now() < MIN_RUN_MS;

/**
 * `workflow.regressionGate`: after a `done` or `accept` whose checks passed, run the existing tests
 * the change can reach and earlier work's checks, then compare each failure with the old code.
 * Never edits or discards work: old code runs only in a disposable tree. Returns undefined when
 * the gate is off or does not apply; the caller saves a report with its closeout.
 */
export async function runRegressionGate(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice | undefined,
  subjectDigest: string,
  snapshot: Record<string, string>,
  ran: readonly ProductCheck[],
  executions: readonly ProductExecution[],
  signal?: AbortSignal,
): Promise<RegressionGateReport | undefined> {
  if (workspace.config.workflow.regressionGate === "off" || signal?.aborted) return undefined;
  // Failing checks are fixed first; the gate judges a change whose own checks pass.
  if (executions.some((execution) => execution.status !== "passed")) return undefined;
  const baseline = await regressionBaseline(workspace, record);
  const auth = baseline.ok ? baseline.value : undefined;
  const found = await regressionCandidates(workspace, record, slice, auth, snapshot, ran);
  const { selected, overCap } = selectRegressionCandidates(found.candidates, MAX_COMMANDS);
  const key = gateKey(workspace, subjectDigest, auth, selected);
  // `done` runs again after its review: an unchanged product and selection is not run twice.
  const saved = await readRegressionGate(workspace, record.brief.feature);
  if (saved?.key === key) return saved;
  const started = Date.now();
  const run: GateRun = {
    workspace,
    deadline: started + BUDGET_MS,
    redact: await outputRedactor(workspace.paths.root),
    signal,
  };
  const entries: Entry[] = [];
  const unrun: string[] = [];
  for (const candidate of selected)
    if (spent(run)) unrun.push(candidate.label);
    else entries.push({ candidate, now: await runOnce(run, candidate) });
  await compare(run, entries, auth, snapshot);
  const results = entries.map(resultOf);
  return {
    version: 1,
    feature: record.brief.feature,
    subjectDigest,
    key,
    status: overallStatus(results, found.blind),
    results,
    selection: selectionOf(entries.map((entry) => entry.candidate)),
    leftOut: [
      ...found.notes,
      ...(overCap.length
        ? [`${overCap.length} more over the ${MAX_COMMANDS}-command cap: ${labels(overCap)}`]
        : []),
      ...(unrun.length ? [`not run, time budget spent: ${unrun.join(", ")}`] : []),
      ...(selected.length || found.blind ? [] : ["no existing test covers this change"]),
    ],
    durationMs: Date.now() - started,
  };
}

function gateKey(
  workspace: WorkspaceState,
  subjectDigest: string,
  auth: ProductAuthorization | undefined,
  selected: readonly RegressionCandidate[],
) {
  return hashValue({
    version: 1,
    subjectDigest,
    baseline: auth ? hashValue({ files: auth.baseline, head: auth.headCommit }) : null,
    commands: selected.map((entry) => [
      describeProductCheck(entry.check),
      entry.extraEnvironment ?? {},
    ]),
    flipCheck: workspace.config.workflow.flipCheck,
  });
}

/** A regression, else unchecked when anything was undecided or unseen, else clear. */
function overallStatus(
  results: readonly RegressionGateResult[],
  blind: boolean,
): RegressionGateReport["status"] {
  if (results.some((result) => result.status === "regression")) return "regression";
  return blind || !results.length || results.some((result) => result.status === "unchecked")
    ? "unchecked"
    : "clear";
}

function selectionOf(candidates: readonly RegressionCandidate[]): RegressionSelection {
  const count = (...origins: RegressionCandidate["origin"][]) =>
    candidates.filter((candidate) => origins.includes(candidate.origin)).length;
  return {
    linked: count("graph", "convention"),
    earlierWork: count("feature", "earlier-feature"),
    unlinked: count("unlinked"),
  };
}

function labels(entries: readonly RegressionCandidate[]) {
  const shown = entries.slice(0, 3).map((entry) => entry.label);
  return entries.length > shown.length ? `${shown.join(", ")}, …` : shown.join(", ");
}

/**
 * A failure is run once more on the new code (a difference is flaky) and then on the old code in
 * one disposable tree. With `workflow.flipCheck: off` nothing runs twice, so nothing is compared.
 */
async function compare(
  run: GateRun,
  entries: Entry[],
  auth: ProductAuthorization | undefined,
  snapshot: Record<string, string>,
) {
  const failing = entries.filter((entry) => entry.now.kind === "failed");
  if (!auth || run.workspace.config.workflow.flipCheck === "off") {
    const skipped = auth
      ? "not compared: workflow.flipCheck is off, so no command runs twice"
      : "not compared: no baseline of the old code";
    for (const entry of failing) entry.skipped = skipped;
    return;
  }
  for (const entry of failing)
    if (spent(run)) entry.skipped = "not compared: time budget spent";
    else entry.rerun = await runOnce(run, entry.candidate);
  const consistent = failing.filter((entry) => entry.rerun?.kind === "failed");
  if (!consistent.length) return;
  const reason = await runOnOldCode(run, consistent, auth, snapshot);
  for (const entry of consistent)
    if (reason && !entry.before) entry.before = { kind: "environment", reason };
}

/** Runs each entry in one tree holding the old implementation and the current tests. */
async function runOnOldCode(
  run: GateRun,
  entries: Entry[],
  auth: ProductAuthorization,
  snapshot: Record<string, string>,
): Promise<string | undefined> {
  const { workspace } = run;
  const environment = await captureFlipEnvironment(workspace.paths.root);
  try {
    const baseline = await recoverFlipBaseline(workspace, auth);
    const preserved = await flipValidationPaths(
      workspace,
      await testsCheck(workspace, entries, snapshot),
      snapshot,
      baseline,
      auth.baseline,
    );
    const changes = await productSourceChanges(workspace, auth.baseline, snapshot);
    if (!changes.ok) return changes.error.message;
    const reverted = changes.value.filter((path) => !preserved.has(path));
    // Only tests changed: the old implementation is the current one, so nothing regressed.
    if (!reverted.length) {
      for (const entry of entries) entry.before = entry.now;
      return undefined;
    }
    const blocker = await comparisonBlocker(workspace, auth, baseline, preserved, snapshot);
    if (blocker) return blocker;
    const inherited = await resolvedProductExecutionEnvironment();
    const inTree = async (tree: string) => {
      const old = {
        cwd: tree,
        environment: reboundFlipEnvironment(inherited, workspace.paths.root, tree),
        reverted,
        roots: [tree, await realpath(tree).catch(() => tree)],
      };
      for (const entry of entries)
        entry.before = spent(run)
          ? { kind: "environment", reason: "time budget spent" }
          : await runOnce(run, entry.candidate, old);
    };
    await inFlipTree(workspace, auth, baseline, preserved, snapshot, inTree, environment);
    return undefined;
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  } finally {
    await disposeFlipEnvironment(environment).catch(() => undefined);
  }
}

/** One check naming every file the selected commands read, so all of them stay current. */
async function testsCheck(
  workspace: WorkspaceState,
  entries: readonly Entry[],
  snapshot: Record<string, string>,
): Promise<ProductCheck> {
  const checks = entries.map((entry) => entry.candidate.check);
  return {
    id: "REGRESSION",
    command: ["regression-gate"],
    outcomes: [],
    files: await reviewCheckPaths(workspace, checks, snapshot),
    environment: "other",
  };
}

interface OldTree {
  readonly cwd: string;
  readonly environment?: Record<string, string>;
  readonly reverted: string[];
  readonly roots: string[];
}

async function runOnce(
  run: GateRun,
  candidate: RegressionCandidate,
  old?: OldTree,
): Promise<RegressionRun> {
  const { workspace } = run;
  const timeoutMs = Math.max(
    MIN_RUN_MS,
    Math.min(candidate.check.timeoutMs ?? RUN_TIMEOUT_MS, run.deadline - Date.now()),
  );
  const check = { ...candidate.check, timeoutMs };
  const output = await runProductCheckCommand(workspace, check, {
    cwd: old?.cwd,
    environment: old?.environment,
    extraEnvironment: candidate.extraEnvironment,
    signal: run.signal,
  });
  const environment = runEnvironmentFailure(
    output,
    check,
    old?.cwd ?? workspace.paths.root,
    old?.reverted,
  );
  if (environment) return { kind: "environment", reason: run.redact(environment).slice(0, 300) };
  if (!output.ok || output.value.exitCode === 0) return { kind: "passed" };
  const raw = `${output.value.stdout}\n${output.value.stderr}`;
  const failures = failureIdentities(run.redact(raw), [
    workspace.paths.root,
    ...(old?.roots ?? []),
  ]);
  // A runner that rejects the command exits non-zero on the old code too, which would read as a
  // failure both versions share: no test ran, so nothing is known.
  const rejected = failures.every((failure) => !failure.name) && rejectedCommandLine(raw);
  if (rejected)
    return {
      kind: "environment",
      reason: `the runner rejected the command: ${run.redact(rejected).slice(0, 200)}`,
    };
  return { kind: "failed", failures };
}

function runEnvironmentFailure(
  output: Result<CommandOutput>,
  check: ProductCheck,
  root: string,
  reverted?: string[],
): string | undefined {
  if (!output.ok) return output.error.message.split("\n")[0] ?? "could not run";
  if (output.value.timedOut)
    return `timed out after ${Math.round((check.timeoutMs ?? 0) / 1000)} s`;
  if (output.value.aborted) return "interrupted";
  if (output.value.exitCode === 0) return undefined;
  const raw = `${output.value.stdout}\n${output.value.stderr}`;
  if (reverted) return flipRunEnvironmentFailure(output, check, raw, reverted, root);
  if (RUNNER_MISSING.test(raw)) return "the test runner is not installed";
  if (sandboxDenial(raw, root) === "denied") return "the sandbox denied the run";
  return configuredMissingTool(check, raw, output.value.exitCode);
}

function resultOf(entry: Entry): RegressionGateResult {
  const verdict = classifyRegression(entry);
  return {
    label: entry.candidate.label,
    command: describeProductCheck(entry.candidate.check),
    status: verdict.status,
    tests: [...verdict.tests],
    ...(verdict.reason ? { reason: verdict.reason } : {}),
  };
}
