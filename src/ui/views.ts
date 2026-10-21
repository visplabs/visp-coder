import { basename } from "node:path";
import { vispError } from "../core/errors.js";
import { err, ok, type Result } from "../core/result.js";
import { BUILD_ID, VERSION } from "../core/version.js";
import { runChecks } from "../doctor/checks.js";
import { applicableExecutions } from "../workflow/product/assessment.js";
import { outstandingFeedback } from "../workflow/product/findings.js";
import {
  latestExecutionsByOwner,
  type ProductBrief,
  type ProductCheck,
  type ProductExecution,
  type ProductSlice,
} from "../workflow/product/model.js";
import {
  type ProductNext,
  runProductNext,
  runProductReport,
  runProductStatus,
} from "../workflow/product/status.js";
import { type ProductRecord, readProductRecord } from "../workflow/product/store.js";
import { readTestsRecord } from "../workflow/product/tester/independent-tests-record.js";
import type { WorkspaceState } from "../workflow/state.js";
import { activityFor } from "./activity.js";
import { listCaptures } from "./captures.js";
import {
  type FeatureSummary,
  UI_CONTRACT_VERSION,
  type UiCheck,
  type UiEvidence,
  type UiEvidenceCount,
  type UiExecution,
  type UiExecutionSummary,
  type UiFeature,
  type UiFinding,
  type UiHealth,
  type UiMeta,
  type UiNext,
  type UiOutcome,
  type UiOverview,
  type UiQuestion,
  type UiReview,
  type UiSlice,
  type UiTester,
} from "./contract.js";
import { outputHeadline } from "./output.js";

/** Check output beyond this is cut; the byte count still reports the whole. */
export const MAX_OUTPUT_BYTES = 1_000_000;

export function metaView(state: WorkspaceState, startedAt: string): UiMeta {
  return {
    contractVersion: UI_CONTRACT_VERSION,
    version: VERSION,
    buildId: BUILD_ID,
    repository: { root: state.paths.root, name: basename(state.paths.root) },
    ...(state.status?.activeFeature ? { activeFeature: state.status.activeFeature } : {}),
    startedAt,
  };
}

export async function overviewView(state: WorkspaceState): Promise<Result<UiOverview>> {
  const ids = await state.store.listFeatures();
  if (!ids.ok) return ids;
  const features = await Promise.all(ids.value.map((id) => featureSummary(state, id)));
  return ok({ features: features.sort(byRecency) });
}

function byRecency(a: FeatureSummary, b: FeatureSummary): number {
  return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
}

async function featureSummary(state: WorkspaceState, id: string): Promise<FeatureSummary> {
  const active = state.status?.activeFeature === id;
  const record = await readProductRecord(state, { feature: id });
  if (!record.ok) {
    const legacy = record.error.code === "MIGRATION_REQUIRED";
    return {
      id,
      goal: id,
      lifecycle: legacy ? "legacy" : "unreadable",
      active,
      slices: { total: 0, closed: 0, inProgress: 0 },
      openFindings: 0,
      pendingQuestions: 0,
      problem: {
        message: record.error.message,
        ...(record.error.recovery ? { recovery: record.error.recovery } : {}),
      },
    };
  }
  const { brief, state: product } = record.value;
  const statuses = Object.values(product.slices).map((slice) => slice.status);
  return {
    id,
    goal: brief.goal,
    lifecycle: product.status,
    active,
    updatedAt: product.updatedAt,
    slices: {
      total: brief.slices.length,
      closed: statuses.filter((status) => status === "closed" || status === "legacy-closed").length,
      inProgress: statuses.filter((status) => status === "in-progress").length,
    },
    openFindings: outstandingFeedback(record.value).length,
    pendingQuestions: (product.userFeedback ?? []).filter((entry) => entry.status === "pending")
      .length,
  };
}

export async function featureView(
  state: WorkspaceState,
  feature: string,
): Promise<Result<UiFeature>> {
  const record = await readProductRecord(state, { feature });
  if (!record.ok) return record;
  const status = await runProductStatus(state, { feature });
  if (!status.ok) return status;
  const subject = status.value.subjectDigest;
  const current = new Set(
    subject ? applicableExecutions(record.value, subject).map((entry) => entry.id) : [],
  );
  const { brief, state: product } = record.value;
  const executions = [...product.executions]
    .reverse()
    .map((execution) => executionSummary(execution, current.has(execution.id)));
  const slices = slicesView(record.value, executions);
  return ok({
    id: brief.feature,
    goal: brief.goal,
    originalRequest: brief.originalRequest,
    lifecycle: product.status,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    ...(subject ? { subjectDigest: subject } : {}),
    next: nextView(status.value.next),
    outcomes: outcomesView(brief, status.value.outcomes, slices),
    slices,
    findings: findingsView(record.value),
    reviews: reviewsView(record.value),
    questions: questionsView(record.value),
    executions,
    activity: activityFor(record.value),
    captures: await listCaptures(state.paths.featureDir(feature)),
    decisions: brief.decisions.map((entry) => ({ id: entry.id, statement: entry.statement })),
    uncertainties: brief.uncertainties,
    report: status.value.report,
    tester: await testerView(state, feature, executions),
    readAt: new Date().toISOString(),
  });
}

export function nextView(next: ProductNext): UiNext {
  return {
    action: next.action,
    objective: next.objective,
    ...(next.command ? { command: next.command } : {}),
    ...(next.task ? { task: next.task } : {}),
    mayEdit: next.mayEdit,
    ...(next.completion ? { completion: next.completion } : {}),
    ...(next.recovery ? { recovery: next.recovery } : {}),
    evidence: next.evidence,
  };
}

function outcomesView(
  brief: ProductBrief,
  statuses: readonly {
    id: string;
    behavior: UiOutcome["behavior"];
    review: UiOutcome["review"];
    requiredReview: boolean;
    satisfied: boolean;
  }[],
  slices: readonly UiSlice[],
): UiOutcome[] {
  const byId = new Map(statuses.map((entry) => [entry.id, entry]));
  return brief.outcomes.map((outcome) => {
    const status = byId.get(outcome.id);
    return {
      id: outcome.id,
      kind: outcome.kind,
      statement: outcome.statement,
      priority: outcome.priority,
      provenance: outcome.provenance,
      behavior: status?.behavior ?? "unassessed",
      review: status?.review ?? "unassessed",
      requiredReview: status?.requiredReview ?? false,
      satisfied: status?.satisfied ?? false,
      checks: evidenceCount(outcome.id, slices),
      expectations: outcome.expectations.map((entry) => ({
        id: entry.id,
        statement: entry.statement,
      })),
    };
  });
}

/** Each agent check that names the outcome once, by the latest run any slice records for it. */
function evidenceCount(outcome: string, slices: readonly UiSlice[]): UiEvidenceCount {
  const count = { total: 0, passed: 0, failed: 0, stale: 0, notRun: 0 };
  for (const { latest } of checksNaming(outcome, slices)) {
    count.total += 1;
    if (!latest) count.notRun += 1;
    else if (!latest.current) count.stale += 1;
    else if (latest.status === "passed") count.passed += 1;
    else count.failed += 1;
  }
  return count;
}

/** A check shared by several slices counts once, with its newest run. */
function checksNaming(outcome: string, slices: readonly UiSlice[]): UiCheck[] {
  const checks = new Map<string, UiCheck>();
  for (const check of slices.flatMap((slice) => slice.checks)) {
    if (!check.outcomes.includes(outcome)) continue;
    const seen = checks.get(check.id);
    if (!seen || (check.latest?.createdAt ?? "") > (seen.latest?.createdAt ?? ""))
      checks.set(check.id, check);
  }
  return [...checks.values()];
}

async function testerView(
  state: WorkspaceState,
  feature: string,
  executions: readonly UiExecutionSummary[],
): Promise<UiTester> {
  const latest = executions.find((entry) => entry.source === "tester");
  const withLatest = latest ? { latest } : {};
  const record = await readTestsRecord(state, feature);
  if (!record.ok)
    return { status: "unreadable", tests: 0, ambiguities: 0, reason: record.error.message };
  if (!record.value) return { status: "none", tests: 0, ambiguities: 0, ...withLatest };
  const tester = record.value;
  return {
    status: tester.status,
    ...(tester.model ? { model: tester.model } : {}),
    tests: tester.tests?.length ?? 0,
    ambiguities: tester.ambiguities?.length ?? 0,
    at: tester.finishedAt ?? tester.startedAt,
    ...(tester.reason ? { reason: tester.reason } : {}),
    ...withLatest,
  };
}

/** Pinned acceptance suites run as `PINNED_<n>` checks. */
const testerCheck = (check: string) => check.startsWith("PINNED_");

export function executionSummary(
  execution: ProductExecution,
  current: boolean,
): UiExecutionSummary {
  return {
    id: execution.id,
    check: execution.check,
    ...(execution.task ? { task: execution.task } : {}),
    createdAt: execution.createdAt,
    command: execution.command,
    status: execution.status,
    source: testerCheck(execution.check) ? "tester" : "agent",
    exitCode: execution.exitCode,
    durationMs: execution.durationMs,
    provenance: execution.provenance,
    assertions: execution.assertions,
    current,
    headline: outputHeadline(execution.output, execution.status),
    outputBytes: Buffer.byteLength(execution.output, "utf8"),
  };
}

function slicesView(record: ProductRecord, executions: readonly UiExecutionSummary[]): UiSlice[] {
  const latest = latestRuns(record, executions);
  return record.brief.slices.map((slice) => ({
    id: slice.id,
    goal: slice.goal,
    status: record.state.slices[slice.id]?.status ?? "unknown",
    outcomes: slice.outcomes,
    dependsOn: slice.dependsOn,
    scope: slice.scope,
    approach: slice.approach,
    checks: checksFor(record.brief, slice).map((check) => checkView(check, slice, latest)),
  }));
}

/** Latest run per check and slice, keyed the way the workflow supersedes runs. */
function latestRuns(
  record: ProductRecord,
  executions: readonly UiExecutionSummary[],
): Map<string, UiExecutionSummary> {
  const byId = new Map(executions.map((entry) => [entry.id, entry]));
  const latest = new Map<string, UiExecutionSummary>();
  for (const execution of latestExecutionsByOwner(record.state.executions)) {
    const summary = byId.get(execution.id);
    if (summary) latest.set(runKey(execution.check, execution.task), summary);
  }
  return latest;
}

const runKey = (check: string, task: string | undefined) => `${check}\u0000${task ?? ""}`;

function checksFor(brief: ProductBrief, slice: ProductSlice): ProductCheck[] {
  return brief.checks.filter((check) => slice.checks.includes(check.id));
}

function checkView(
  check: ProductCheck,
  slice: ProductSlice,
  latest: Map<string, UiExecutionSummary>,
): UiCheck {
  const run = latest.get(runKey(check.id, slice.id)) ?? latest.get(runKey(check.id, undefined));
  return {
    id: check.id,
    command: describeCommand(check.command),
    kind: isJourney(check.command) ? "browser-journey" : "command",
    outcomes: check.outcomes,
    ...(run ? { latest: run } : {}),
  };
}

function isJourney(command: ProductCheck["command"]): boolean {
  return typeof command === "object" && !Array.isArray(command) && "kind" in command;
}

function describeCommand(command: ProductCheck["command"]): string {
  if (typeof command === "string") return command;
  // The run's own record keeps the full executable path; the summary names the program.
  if (Array.isArray(command))
    return command.map((part, index) => (index === 0 ? basename(part) : part)).join(" ");
  if ("kind" in command) return "Browser journey";
  return JSON.stringify(command);
}

function findingsView(record: ProductRecord): UiFinding[] {
  return outstandingFeedback(record).map((finding) => ({
    id: finding.id,
    dimension: finding.dimension,
    problem: finding.problem,
    nextCheck: finding.nextCheck,
    required: finding.required,
    outcomes: finding.outcomes,
    evidence: finding.evidence,
    ...(finding.task ? { task: finding.task } : {}),
    repeats: finding.repeats,
    phase: finding.phase,
  }));
}

function reviewsView(record: ProductRecord): UiReview[] {
  return [...record.state.reviews].reverse().map((review) => ({
    createdAt: review.createdAt,
    ...(review.task ? { task: review.task } : {}),
    ...(review.reviewer
      ? {
          reviewer: {
            context: review.reviewer.context,
            ...(review.reviewer.model ? { model: review.reviewer.model } : {}),
          },
        }
      : {}),
    ...(review.feedback?.summary ? { summary: review.feedback.summary } : {}),
    limitations: review.feedback?.limitations ?? [],
    dimensions: (review.feedback?.dimensions ?? []).map((entry) => ({
      dimension: entry.dimension,
      status: entry.status,
      reason: entry.reason,
    })),
    findings: review.feedback?.findings.length ?? 0,
    resolutions: (review.feedback?.resolutions ?? []).map((entry) => ({
      id: entry.id,
      disposition: entry.disposition ?? "repaired",
      explanation: entry.explanation,
    })),
  }));
}

function questionsView(record: ProductRecord): UiQuestion[] {
  return [...(record.state.userFeedback ?? [])].reverse().map((entry) => ({
    id: entry.id,
    ...(entry.task ? { task: entry.task } : {}),
    question: entry.question,
    ...(entry.context ? { context: entry.context } : {}),
    createdAt: entry.createdAt,
    status: entry.status,
    ...(entry.reply ? { reply: entry.reply } : {}),
    ...(entry.respondedAt ? { respondedAt: entry.respondedAt } : {}),
    provenance: entry.provenance,
  }));
}

export async function executionView(
  state: WorkspaceState,
  feature: string,
  executionId: string,
): Promise<Result<UiExecution>> {
  const record = await readProductRecord(state, { feature });
  if (!record.ok) return record;
  const execution = record.value.state.executions.find((entry) => entry.id === executionId);
  if (!execution)
    return err(vispError("ARTIFACT_MISSING", `No execution ${executionId} in ${feature}`));
  const status = await runProductStatus(state, { feature });
  const subject = status.ok ? status.value.subjectDigest : undefined;
  const current =
    subject !== undefined &&
    applicableExecutions(record.value, subject).some((entry) => entry.id === execution.id);
  const bytes = Buffer.from(execution.output, "utf8");
  const truncated = bytes.byteLength > MAX_OUTPUT_BYTES;
  return ok({
    ...executionSummary(execution, current),
    output: truncated
      ? bytes.subarray(bytes.byteLength - MAX_OUTPUT_BYTES).toString("utf8")
      : execution.output,
    truncated,
  });
}

/** The same record `visp pr` prints, so the tab and the pull request never disagree. */
export async function evidenceView(
  state: WorkspaceState,
  feature: string,
): Promise<Result<UiEvidence>> {
  const report = await runProductReport(state, { feature });
  if (!report.ok) return report;
  const { record, markdown } = report.value;
  return record
    ? ok({ record, markdown })
    : err(vispError("ARTIFACT_MISSING", `No evidence record for ${feature}: ${markdown.trim()}`));
}

export async function nextForFeature(
  state: WorkspaceState,
  feature: string,
): Promise<Result<UiNext>> {
  const next = await runProductNext(state, { feature });
  return next.ok ? ok(nextView(next.value)) : next;
}

export async function healthView(state: WorkspaceState): Promise<UiHealth> {
  const report = await runChecks(state);
  return {
    verdict: report.verdict,
    checks: report.checks.map((check) => ({
      name: check.name,
      status: check.status,
      detail: check.detail,
      ...(check.recovery ? { recovery: check.recovery } : {}),
    })),
  };
}
