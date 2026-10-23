import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { launchesReviewer } from "../../../config/critic.js";
import { ok, type Result } from "../../../core/result.js";
import { cliCommand } from "../../next-action.js";
import type { WorkspaceState } from "../../state.js";
import { finalProductAssessmentGaps, outcomeStatuses } from "../assessment.js";
import { cancelledExecution } from "../check/check-lifecycle.js";
import { type ProductCriticHost, runProductCritic } from "../critic/critic.js";
import { type ReviewerCapacity, reviewerCapacity } from "../critic/critic-capacity.js";
import { configuredCriticLauncher } from "../critic/critic-exec.js";
import { hasPendingCriticReview } from "../critic/critic-policy.js";
import { type ProductVerification, runProductAccept, runProductDone } from "../evidence.js";
import { openRequiredFindings, outstandingFeedback } from "../findings.js";
import { checksFor, latestExecutionsByOwner } from "../model.js";
import { profileSettings } from "../profile.js";
import type { ProductNext } from "../status.js";
import { runProductNext } from "../status.js";
import { type ProductRecord, type ProductSelection, readProductRecord } from "../store.js";
import {
  type AcceptanceProgress,
  acceptanceProgress,
} from "../tester/independent-tests-progress.js";
import type { PinnedDispute } from "../tester/pinned-dispute-model.js";
import {
  type DisputeInput,
  type DisputeOutcome,
  type DisputeState,
  disputedFailure,
  disputeInput,
  disputeState,
  failingPinned,
  fileDisputes,
  type PinnedTestsReport,
  pinnedTestsReport,
  ranPinned,
  refreshDisputes,
  rulingCurrent,
} from "../tester/pinned-disputes.js";
import { featureReviewCadence, LEAN_MIDDLE_SLICE_REASON } from "./review-cadence.js";
import { completesFeature } from "./review-selection.js";

export interface DoneCriticSummary {
  readonly reviewed: boolean;
  /** The reviewer is still running in the background; `visp next` waits for it. */
  readonly running?: boolean;
  readonly summary?: string;
  readonly findings: readonly { problem: string; nextCheck?: string; required?: boolean }[];
  /** Lean profile (`workflow.requestGaps: required`): advisory findings, which the worker need not act on. */
  readonly notes?: readonly string[];
  readonly notesAdvice?: string;
  readonly callsRemaining?: number;
  /** Why no review happened: no applicable evidence, exhausted budget, or a failed launch. */
  readonly reason?: string;
}
export type ProductDoneReviewed = ProductVerification & {
  readonly acceptanceTests?: readonly AcceptanceProgress[];
  /** Disputes of failing pinned tests: what was filed, the rulings, how to dispute. */
  readonly pinnedTests?: PinnedTestsReport;
  readonly critic?: DoneCriticSummary;
  readonly next?: ProductNext;
};

interface ReviewSelection extends ProductSelection {
  readonly feature: string;
  readonly task?: string;
  /** Running the same command again is cheap and safe: an inline review may wait for it. */
  readonly rerunnable?: boolean;
}

/** What the detached review process writes: its JSON envelope, read back when it exits early. */
const REVIEW_PROCESS_LOG = "review-process.log";

/** Returned reviews took 48 s at the median and 75 s at p90; a review with less left is cut off. */
const MIN_INLINE_REVIEW_MS = 75_000;
/** Slack so a suite cut off at its reserved deadline still leaves a full review window. */
const INFORMATIONAL_MARGIN_MS = 2000;
/** Starts an independent review of the selection and reports what happened so far. */
export type ReviewStarter = (
  workspace: WorkspaceState,
  selection: ReviewSelection,
) => Promise<DoneCriticSummary>;

/**
 * `done`, then independent review when VISP may launch the reviewer. A worker that never
 * orchestrates delegation still gets the critic's findings as its next repair step. The
 * critic's own reservation, budget and freshness rules decide whether a call is spent.
 */
export async function runProductDoneReviewed(
  workspace: WorkspaceState,
  options: ProductSelection,
  startReview?: ReviewStarter,
  waitMs = 0,
): Promise<Result<ProductDoneReviewed>> {
  const dispute = disputeInput(options);
  if (!dispute.ok) return dispute;
  const deadline = callDeadline(options, waitMs);
  const checked = await runProductDone(workspace, options);
  if (!checked.ok) return checked;
  const { feature } = checked.value;
  const rerunnable = rerunnableReview(waitMs);
  const progressDeadline = informationalDeadline(deadline, !!startReview && rerunnable);
  const progress = await acceptanceProgress(
    workspace,
    feature,
    checked.value.executions.map((execution) => execution.check),
    { ...options, deadline: progressDeadline },
  );
  if (options.signal?.aborted) return cancelledExecution();
  const pinned = await pinnedView(workspace, "done", dispute.value, checked.value);
  if (!pinned.ok) return pinned;
  const { state } = pinned.value;
  const done = ok({
    ...(progress.length ? { ...checked.value, acceptanceTests: progress } : checked.value),
    ...pinned.value.initial,
  });
  if (!startReview) return done;
  const { record, owed } = await readForReview(
    workspace,
    feature,
    done.value.task,
    done.value.subjectDigest,
  );
  // A lean feature with no reviewer (D13) closes on its checks; nothing is started or reported.
  if (!checksPassed(done.value, state, owed) || record?.state.criticLeanOff) return done;
  const skipped = await reviewNotNeeded(
    workspace,
    feature,
    done.value.task,
    done.value.subjectDigest,
    state.pending,
    record,
  );
  if (skipped) return ok({ ...done.value, critic: skipped });
  const critic = await launchReview(workspace, options, deadline, startReview, {
    feature,
    // `done` reuses passed checks, so running it again costs little; `accept` re-runs them all.
    rerunnable,
    ...(record && completesFeature(record, done.value.task) ? {} : { task: done.value.task }),
  });
  if (options.signal?.aborted) return cancelledExecution();
  return doneAfterReview(workspace, options, done.value, critic, pinned.value);
}

/** Close against the saved review without launching another review or rerunning passed checks. */
async function doneAfterReview(
  workspace: WorkspaceState,
  options: ProductSelection,
  done: ProductDoneReviewed,
  critic: DoneCriticSummary,
  pinned: PinnedView,
): Promise<Result<ProductDoneReviewed>> {
  const { feature } = done;
  const refreshed =
    critic.reviewed && !critic.running
      ? await runProductDone(workspace, { ...options, feature, task: done.task })
      : ok(done);
  if (!refreshed.ok) return refreshed;
  const next = critic.running ? waitingNext(feature) : await runProductNext(workspace, { feature });
  return ok({
    ...done,
    ...refreshed.value,
    // Preserve executed receipts, replacing any superseded by a post-review rerun (e.g. a waiver).
    executions: latestExecutionsByOwner([...done.executions, ...refreshed.value.executions]),
    behaviorChanges: refreshed.value.executions.length
      ? refreshed.value.behaviorChanges
      : done.behaviorChanges,
    committedChanges: done.committedChanges,
    ...(await pinned.refreshed()),
    critic,
    ...(next.ok ? { next: next.value, nextCommand: next.value.command } : {}),
  });
}

/**
 * `accept`, with VISP's reviewer assessing the assembled product first when acceptance
 * lacks a current assessment. Weak workers were sent to the host review protocol here and
 * stopped. Checks that fail are fixed first; a spent budget leaves acceptance unchanged.
 */
export async function runProductAcceptReviewed(
  workspace: WorkspaceState,
  options: ProductSelection,
  startReview?: ReviewStarter,
  waitMs = 0,
): Promise<
  Result<
    ProductVerification & { readonly critic?: DoneCriticSummary; pinnedTests?: PinnedTestsReport }
  >
> {
  const dispute = disputeInput(options);
  if (!dispute.ok) return dispute;
  const deadline = callDeadline(options, waitMs);
  const accepted = await runProductAccept(workspace, options);
  if (!accepted.ok) return accepted;
  const { feature } = accepted.value;
  const pinned = await pinnedView(workspace, "accept", dispute.value, accepted.value);
  if (!pinned.ok) return pinned;
  const initial = { ...accepted.value, ...pinned.value.initial };
  if (accepted.value.passed || !startReview || !checksPassed(accepted.value, pinned.value.state))
    return ok(initial);
  if (options.signal?.aborted) return cancelledExecution();
  const critic = await launchReview(workspace, options, deadline, startReview, { feature });
  if (critic.running || !critic.reviewed) return ok({ ...initial, critic });
  if (options.signal?.aborted) return cancelledExecution();
  const again = await runProductAccept(workspace, { ...options, reusePassed: true });
  if (!again.ok) return again;
  return ok({ ...again.value, critic, ...(await pinned.value.refreshed()) });
}

interface PinnedView {
  /** Where the disputes stand; pending ones do not stop the reviewer from launching. */
  readonly state: DisputeState;
  readonly initial: { pinnedTests?: PinnedTestsReport };
  /** After a review: this call's filing outcomes with where each dispute stands now. */
  refreshed(): Promise<{ pinnedTests?: PinnedTestsReport }>;
}

/**
 * Brings open disputes up to the failing run just observed, files this call's disputes
 * against it, and reports on them. Only the pinned suite run as a blocking check counts:
 * on earlier slices it is informational and nothing can be disputed.
 */
async function pinnedView(
  workspace: WorkspaceState,
  command: "done" | "accept",
  dispute: DisputeInput | undefined,
  verification: ProductVerification,
): Promise<Result<PinnedView>> {
  const { feature } = verification;
  const failing = failingPinned(verification.executions);
  if (ranPinned(verification.executions)) {
    const refreshed = await refreshDisputes(
      workspace,
      feature,
      failing,
      verification.subjectDigest,
    );
    if (!refreshed.ok) return refreshed;
  }
  // Whether VISP's reviewer can still rule matters to a failing pinned test and to a dispute.
  const capacity = async (): Promise<ReviewerCapacity> =>
    dispute !== undefined ||
    failing.length > 0 ||
    (await disputeState(workspace, feature)).all.some(isOpen)
      ? reviewerCapacity(
          workspace,
          feature,
          verification.subjectDigest,
          verification.closed || !verification.task ? undefined : verification.task,
        )
      : { available: true };
  const filed = dispute
    ? await fileDisputes(
        workspace,
        feature,
        dispute,
        failing,
        verification.subjectDigest,
        await capacity(),
      )
    : undefined;
  if (filed && !filed.ok) return filed;
  const report = async (outcomes?: readonly DisputeOutcome[]) =>
    pinnedTestsReport(workspace, feature, {
      ...(outcomes ? { filed: outcomes } : {}),
      failing: failing.length > 0,
      command,
      failures: failing,
      capacity: await capacity(),
    });
  const wrap = (pinnedTests: PinnedTestsReport | undefined) => (pinnedTests ? { pinnedTests } : {});
  const initial = wrap(await report(filed?.value));
  return ok({
    state: await disputeState(workspace, feature),
    initial,
    refreshed: async () => wrap(await report(filed?.value)),
  });
}

const isOpen = (entry: PinnedDispute) => entry.status === "open";

/** Starts the review and, when it is still running, holds the call for its result. */
async function launchReview(
  workspace: WorkspaceState,
  options: ProductSelection,
  deadline: number | undefined,
  startReview: ReviewStarter,
  selection: { feature: string; task?: string; rerunnable?: boolean },
): Promise<DoneCriticSummary> {
  await options.onProgress?.({
    check: "review",
    status: "starting; run visp next if still pending",
  });
  const critic = await startReview(workspace, { signal: options.signal, deadline, ...selection });
  // Weak workers kept editing while a review ran, and the changed source discarded it.
  // Holding `done` until the review returns delivers findings in the same step.
  if (
    critic.running &&
    !(await pendingReview(workspace, selection.feature, deadline ?? Date.now(), options))
  )
    return withNotes(
      workspace,
      selection.feature,
      summarize(
        await runProductCritic(workspace, { operation: "status", feature: selection.feature }),
      ),
    );
  return withNotes(workspace, selection.feature, critic);
}

const NOTES_ADVICE =
  "Notes are not gaps against the request. Do not edit for them; fix the required findings, if any.";

/** Lean profile: only required findings ask for work; the reviewer's other findings become notes. */
async function withNotes(
  workspace: WorkspaceState,
  feature: string,
  critic: DoneCriticSummary,
): Promise<DoneCriticSummary> {
  const record = await readProductRecord(workspace, { feature });
  if (!record.ok || profileSettings(workspace, record.value).requestGaps !== "required")
    return critic;
  const notes = critic.findings.filter((finding) => finding.required !== true);
  if (!notes.length) return critic;
  return {
    ...critic,
    findings: critic.findings.filter((finding) => finding.required === true),
    notes: notes.map((finding) => finding.problem),
    notesAdvice: NOTES_ADVICE,
  };
}

/** The record after `done`, and whether the slice owes a required review. */
async function readForReview(
  workspace: WorkspaceState,
  feature: string,
  task: string | undefined,
  subject: string,
) {
  const loaded = await readProductRecord(workspace, { feature });
  const record = loaded.ok ? loaded.value : undefined;
  return { record, owed: !!record && !!task && reviewOwed(record, task, subject) };
}

/**
 * Running `done` again is cheap only where a review can ever fit in the call: the MCP wait is
 * shorter than a review, so there it starts with whatever time is left.
 */
function rerunnableReview(waitMs: number): boolean {
  return waitMs === 0 || waitMs >= MIN_INLINE_REVIEW_MS;
}

/** The informational pinned suite of a middle slice must not eat the time the review needs. */
function informationalDeadline(deadline: number | undefined, reserve: boolean) {
  return reserve && deadline !== undefined
    ? deadline - MIN_INLINE_REVIEW_MS - INFORMATIONAL_MARGIN_MS
    : deadline;
}

function callDeadline(options: ProductSelection, waitMs: number) {
  return options.deadline ?? (waitMs > 0 ? Date.now() + waitMs : undefined);
}

/**
 * After a review with no failed assessment and no required open finding, another review of a
 * middle slice rarely found anything in weak-worker runs and cost 1–2 minutes each.
 * The slice that completes the feature is always reviewed.
 */
async function reviewNotNeeded(
  workspace: WorkspaceState,
  feature: string,
  task: string | undefined,
  subject: string,
  pending: readonly PinnedDispute[],
  record: ProductRecord | undefined,
): Promise<DoneCriticSummary | undefined> {
  // A dispute is decided only by a review; once it has ruled on this exact source, another
  // review of it would find nothing new.
  if (
    record &&
    completesFeature(record, task) &&
    finalProductAssessmentGaps(record, subject).length > 0
  )
    return undefined;
  if (pending.length) return undefined;
  if (
    record &&
    openRequiredFindings(
      record,
      record.brief.slices.find((slice) => slice.id === task),
    ).length
  )
    return undefined;
  if (await rulingCurrent(workspace, feature, subject))
    return {
      reviewed: false,
      findings: [],
      reason: "The independent review already ruled on this exact source",
    };
  if (!record || !task) return undefined;
  if (featureReviewCadence(workspace, record) && !completesFeature(record, task))
    return { reviewed: false, findings: [], reason: LEAN_MIDDLE_SLICE_REASON };
  const capacity = await reviewerCapacity(workspace, feature, subject, task);
  if (!skippableReview(record, task, subject, capacity.reserveCompletingReview)) return undefined;
  return {
    reviewed: false,
    findings: [],
    reason: capacity.reserveCompletingReview
      ? "Skipped this non-completing slice review to reserve independent review capacity (one call and its full timeout) for the completing whole-feature review; no call spent"
      : "The previous independent review found no required problems; the next review runs when the last slice is done",
  };
}

/**
 * A required finding needs an explicit disposition, even after outcomes are satisfied.
 * Mandatory review outcomes also owe a review until assessed. Neither obligation can be
 * skipped merely because the slice has no new check to run.
 */
export function reviewOwed(record: ProductRecord, task: string, subject: string): boolean {
  const slice = record.brief.slices.find((entry) => entry.id === task);
  return (
    !!slice &&
    (openRequiredFindings(record, slice).length > 0 ||
      outcomeStatuses(record, subject, slice).some(
        (entry) =>
          entry.priority === "must" &&
          entry.review !== "satisfied" &&
          (entry.requiredReview ||
            entry.review === "failed" ||
            (record.brief.outcomes.some(
              (outcome) => outcome.id === entry.id && outcome.kind !== "functional",
            ) &&
              !checksFor(record.brief, slice).some((check) => check.outcomes.includes(entry.id)))),
      ))
  );
}

/** Optional middle reviews can yield to a clean predecessor or the completing review's reserve. */
export function skippableReview(
  record: ProductRecord,
  task: string,
  subject: string,
  reserveCompletingReview = false,
): boolean {
  if (completesFeature(record, task) || reviewOwed(record, task, subject)) return false;
  if (reserveCompletingReview) return true;
  const { state } = record;
  const last = state.reviews.at(-1);
  if (!last?.reviewer?.model) return false;
  const clean =
    last.assessments.every((assessment) => assessment.status !== "failed") &&
    !outstandingFeedback(record).some((finding) => finding.required && finding.phase === "product");
  return clean;
}

/**
 * `next`, after giving a running background review up to `waitMs` to return, so a worker
 * that simply asks what to do next receives the findings instead of an in-progress notice.
 */
export async function runProductNextAfterReview(
  workspace: WorkspaceState,
  options: ProductSelection,
  channel: "cli" | "mcp" = "cli",
): Promise<Result<ProductNext>> {
  const feature = options.feature ?? workspace.status?.activeFeature;
  if (
    feature &&
    (await pendingReview(
      workspace,
      feature,
      options.deadline ?? Date.now() + reviewWaitMs(workspace, channel),
      options,
    ))
  )
    return waitingNext(feature);
  return runProductNext(workspace, options);
}

/**
 * Reviews usually return in 40–100 s; weak workers asked once and stopped after a 30 s
 * wait. Polling uses the remaining whole-call budget: 100 s on CLI, 50 s on MCP.
 * Checks may need a longer host timeout; they consume this budget before review waits.
 */
const REVIEW_WAIT_MS = { cli: 100_000, mcp: 50_000 } as const;

/** How long `done` and `next` wait for a VISP-launched review on this channel. */
export function reviewWaitMs(workspace: WorkspaceState, channel: "cli" | "mcp"): number {
  return launchesReviewer(workspace.config.critic) ? REVIEW_WAIT_MS[channel] : 0;
}

/** How `done` starts review for this project, or undefined when the host delegates it. */
export function configuredReviewStarter(
  workspace: WorkspaceState,
  channel: "cli" | "mcp" = "cli",
): ReviewStarter | undefined {
  const launcher = configuredCriticLauncher(workspace);
  if (!launcher) return undefined;
  // Codex's sandbox ends background processes when a shell command returns; reviews from a
  // Codex worker's CLI stayed pending forever. They run inside `visp done` there instead.
  if (channel === "cli" && workspace.config.harness === "codex") return inlineReview(launcher);
  // Bundled builds place the CLI entry beside this chunk; source runs review inline.
  const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  return existsSync(cli) ? backgroundReview(cli) : inlineReview(launcher);
}

/**
 * Run the review in this process; used where the caller outlives the reviewer. The review is
 * bounded by the critic's own timeout, not by this command's wait budget: Codex keeps a shell
 * command running after its tool call yields, and reviews took 95-190 s on slow API days, so a
 * 100 s cut spent every call without a result.
 */
export function inlineReview(launcher: ProductCriticHost): ReviewStarter {
  return async (workspace, selection) =>
    summarize(
      await runProductCritic(
        workspace,
        { operation: "review", feature: selection.feature, task: selection.task },
        launcher,
        selection.signal,
      ),
    );
}

/**
 * Run the review in a detached VISP process that records its own result. Agent hosts
 * kill a long shell command or its process group when a turn ends; a review that lived
 * inside `done` died with it and stayed pending until its deadline.
 */
export function backgroundReview(cli: string, startupMs = 15_000): ReviewStarter {
  return async (workspace, selection) => {
    // The feature's own directory keeps the process log: no stray temp directory per review.
    const log = workspace.paths.featureFile(selection.feature, REVIEW_PROCESS_LOG);
    const output = openSync(log, "w", 0o600);
    const child = spawn(
      process.execPath,
      [
        cli,
        "--project",
        workspace.paths.root,
        "critic",
        "--dispatch",
        "--feature",
        selection.feature,
        ...(selection.task ? ["--task", selection.task] : []),
        "--json",
      ],
      { detached: true, stdio: ["ignore", output, output] },
    );
    closeSync(output);
    let exited = false;
    child.on("exit", () => {
      exited = true;
    });
    child.unref();
    const deadline = Math.min(
      Date.now() + startupMs,
      selection.deadline ?? Number.POSITIVE_INFINITY,
    );
    while (Date.now() < deadline && !exited && !selection.signal?.aborted) {
      const pending = await hasPendingCriticReview(workspace, selection.feature);
      if (pending.ok && pending.value) return runningSummary();
      await delay(Math.min(250, Math.max(1, deadline - Date.now())), undefined, {
        signal: selection.signal,
      }).catch(() => undefined);
    }
    if (!exited) return runningSummary();
    return summarizeEnvelope(await readFile(log, "utf8").catch(() => ""));
  };
}

function runningSummary(): DoneCriticSummary {
  return {
    reviewed: false,
    running: true,
    findings: [],
    summary:
      "Independent review is running (usually 1–2 minutes). Editing pauses until it returns. Run `visp next`; it waits for the findings.",
  };
}

function waitingNext(feature: string): Result<ProductNext> {
  return ok({
    action: "wait",
    feature,
    objective:
      "Independent review is still running. Run the command again to wait for its findings; editing pauses until it returns.",
    command: cliCommand("next", { feature }),
    evidence: [],
    mayEdit: false,
  });
}

async function pendingReview(
  workspace: WorkspaceState,
  feature: string,
  deadline: number,
  options: ProductSelection,
) {
  let announced = false;
  for (;;) {
    const pending = await hasPendingCriticReview(workspace, feature);
    if (!pending.ok || !pending.value) return false;
    if (Date.now() >= deadline || options.signal?.aborted) return true;
    if (!announced) {
      await options.onProgress?.({ check: "review", status: "waiting for independent findings" });
      announced = true;
    }
    await delay(Math.min(1000, Math.max(1, deadline - Date.now())), undefined, {
      signal: options.signal,
    }).catch(() => undefined);
  }
}

/**
 * Failing checks are cheaper to fix than to review. `done` may execute nothing new when
 * `verify` already passed the current source; a passed result still warrants review.
 */
function checksPassed(
  result: ProductVerification,
  disputes?: DisputeState,
  reviewOwed = false,
): boolean {
  // A pinned failure the worker has disputed in full must not keep the reviewer from ruling.
  const blocking = result.executions.filter(
    (execution) =>
      execution.status !== "passed" && !(disputes && disputedFailure(execution, disputes)),
  );
  if (blocking.length) return false;
  // A regression the gate blocks on is fixed before anyone reviews the change.
  if (result.regressionGate?.mode === "gate" && result.regressionGate.status === "regression")
    return false;
  // A slice whose required review has no check to run still owes that review.
  return result.executions.length > 0 || result.passed || reviewOwed;
}

function summarizeEnvelope(text: string): DoneCriticSummary {
  try {
    const envelope = JSON.parse(text) as {
      ok: boolean;
      data?: unknown;
      error?: { message: string };
    };
    return envelope.ok
      ? summarize(ok(envelope.data))
      : { reviewed: false, findings: [], reason: envelope.error?.message ?? "Review failed" };
  } catch {
    return { reviewed: false, findings: [], reason: "The review process ended without a result" };
  }
}

interface CriticResult {
  advice?: { summary?: string };
  findings?: { problem: string; nextCheck?: string; required?: boolean }[];
  callsRemaining?: number;
  gaps?: string[];
  /** Why an attempt ended without a review, as the critic recorded it. */
  reason?: string;
  stopped?: string;
  lifecycle?: { acceptedReview?: boolean; status?: string };
}

/** Why no review came back; a review still running is not a failure and needs no worker action. */
function unreviewedReason(value: CriticResult): string {
  const given = [value.reason, ...(value.gaps ?? [])].filter(Boolean).join("; ");
  if (given) return given;
  return value.stopped?.startsWith("review-in-progress") || value.lifecycle?.status === "pending"
    ? RUNNING_REASON
    : "The critic did not review";
}

const RUNNING_REASON = "VISP's reviewer is still running. Wait: run visp next.";

function summarize(result: Result<unknown>): DoneCriticSummary {
  if (!result.ok)
    return {
      reviewed: false,
      findings: [],
      reason: result.error.message.startsWith("review-in-progress")
        ? RUNNING_REASON
        : result.error.message,
    };
  const value = result.value as CriticResult;
  const reviewed = value.lifecycle?.acceptedReview === true;
  return {
    reviewed,
    ...(value.advice?.summary ? { summary: value.advice.summary } : {}),
    findings: (value.findings ?? []).map(({ problem, nextCheck, required }) => ({
      problem,
      ...(nextCheck ? { nextCheck } : {}),
      ...(required !== undefined ? { required } : {}),
    })),
    ...(value.callsRemaining !== undefined ? { callsRemaining: value.callsRemaining } : {}),
    ...(reviewed ? {} : { reason: unreviewedReason(value) }),
  };
}
