import { vispError } from "../../core/errors.js";
import { applyFileTransaction, type FileMutation } from "../../core/file-transaction.js";
import { err, ok, type Result } from "../../core/result.js";
import { CHECK_OUTPUT_GUIDANCE } from "../product-output-guidance.js";
import type { WorkspaceState } from "../state.js";
import {
  applicableExecutions,
  finalProductAssessmentGaps,
  outcomeStatuses,
  type ProductOutcomeStatus,
  productEvidenceGaps,
  requirementStatus,
} from "./assessment.js";
import { checkBehaviorChanges } from "./behavior-changes.js";
import { pinnedAcceptanceChecks } from "./check/acceptance-checks.js";
import {
  cancelledExecution,
  executeChecks,
  executionOwnerKey,
  requireExecutionContract,
} from "./check/check-lifecycle.js";
import { ensureProductCheckpoint } from "./checkpoint.js";
import { refreshProductIndex } from "./context.js";
import { correctionChecks } from "./corrections.js";
import { reviewerPointer } from "./critic/critic-capacity.js";
import { requireNoPendingCriticReview } from "./critic/critic-policy.js";
import { environmentNext } from "./environment.js";
import { currentJourneyFeedback } from "./evidence-references.js";
import { productFailureSignature } from "./failures.js";
import { findingAppliesToSlice, outstandingFeedback, productFeedbackPlan } from "./feedback.js";
import { productInputWarnings } from "./input-warnings.js";
import {
  checksFor,
  closedSlice,
  PRODUCT_REVIEW_POLICY,
  type ProductCheck,
  type ProductExecution,
  type ProductSlice,
  type ProductState,
} from "./model.js";
import { changeEscalation, featureProfile, profileSettings } from "./profile.js";
import { runRegressionGate } from "./regression/regression-gate.js";
import {
  type RegressionGateReport,
  type RegressionGateSummary,
  regressionGateCloseout,
} from "./regression/regression-report.js";
import {
  accountedRequirements,
  parseRequirementAccounts,
  requirementAccountMutation,
} from "./requirements.js";
import {
  type PreparedResultImages,
  prepareResultImages,
  publishResultImages,
} from "./result-images.js";
import { reviewBaselineMutations } from "./review/review-baseline.js";
import { withProductMutation } from "./runtime.js";
import { checkProductScope, selectProductSlice } from "./scopes.js";
import { type ProductNext, runProductNext } from "./status.js";
import {
  type ProductRecord,
  type ProductSelection,
  readProductRecord,
  saveProductState,
  statusMutation,
} from "./store.js";
import { productContractDigest, productSourceDigest, productSourceSnapshot } from "./subject.js";
import { reviewerRules } from "./tester/pinned-dispute-model.js";

export type { ProductOutcomeStatus } from "./assessment.js";
export {
  type ProductReviewBundle,
  type ProductReviewOptions,
  runProductReview,
} from "./review/review.js";

export interface ProductVerification {
  readonly warnings?: readonly string[];
  readonly committedChanges?: readonly string[];
  readonly checkpoint?: { candidate: string; provenance: string } | { gap: string };
  readonly delivery?: { status: string; summary: string };
  readonly nextCommand?: string;
  readonly next?: ProductNext;
  readonly recovery?: string;
  readonly feature: string;
  readonly task?: string;
  readonly subjectDigest: string;
  readonly passed: boolean;
  readonly closed?: boolean;
  readonly executions: readonly ProductExecution[];
  readonly flipDurationMs?: number;
  /** `workflow.regressionGate`: existing tests run on the new and the old code. */
  readonly regressionGate?: RegressionGateSummary;
  readonly behaviorChanges?: ReturnType<typeof checkBehaviorChanges>;
  readonly outcomes: readonly ProductOutcomeStatus[];
  readonly gaps: readonly string[];
  readonly journeyFeedback?: ReturnType<typeof currentJourneyFeedback>;
  readonly recommendation?: string;
  readonly feedbackPlan?: ReturnType<typeof productFeedbackPlan>;
}

export const runProductVerify = (
  workspace: WorkspaceState,
  options: ProductSelection = {},
): Promise<Result<ProductVerification>> => execute(workspace, options, false, false);
export const runProductDone = (
  workspace: WorkspaceState,
  options: ProductSelection = {},
): Promise<Result<ProductVerification>> => execute(workspace, options, true, false);
export const runProductAccept = (
  workspace: WorkspaceState,
  options: ProductSelection = {},
): Promise<Result<ProductVerification>> => execute(workspace, options, false, true);

async function execute(
  workspace: WorkspaceState,
  options: ProductSelection,
  close: boolean,
  accept: boolean,
): Promise<Result<ProductVerification>> {
  if (options.signal?.aborted) return cancelledExecution();
  const prepared = await withProductMutation(workspace, () =>
    prepareExecution(workspace, options, close, accept),
  );
  if (!prepared.ok) return prepared;
  const { record, slice, source, snapshot, commands } = prepared.value;
  const checked = await executeChecks(
    workspace,
    record,
    slice,
    source,
    commands,
    close,
    accept,
    options,
    snapshot,
  );
  if (!checked.ok) return checked;
  // Runs commands, like the checks, outside the lock; its report is saved with the closeout.
  const gate =
    close || accept
      ? await runRegressionGate(
          workspace,
          record,
          slice,
          source,
          snapshot,
          commands,
          checked.value,
          options.signal,
        )
      : undefined;
  // Rendering an SVG starts a browser; it happens before the lock, published only if current.
  const pictures = await prepareResultImages(
    workspace,
    record,
    options.signal?.aborted ? [] : checked.value,
    { digest: source, snapshot },
  );
  return withProductMutation(workspace, async () => {
    if (options.signal?.aborted) return cancelledExecution();
    const loaded = await readProductRecord(workspace, { feature: record.brief.feature });
    if (!loaded.ok) return loaded;
    const contract = requireExecutionContract(record, loaded.value);
    if (!contract.ok) return contract;
    const available = await closeoutAvailability(workspace, record.brief.feature, close, accept);
    if (!available.ok) return available;
    const finished = await finishExecution(
      workspace,
      loaded.value,
      slice,
      source,
      snapshot,
      commands,
      checked.value,
      close,
      accept,
      prepared.value.committedChanges,
      prepared.value.changed,
      pictures,
      gate,
      options.signal,
    );
    return finished.ok
      ? ok({ ...finished.value, ...flipBatchTiming(record, loaded.value) })
      : finished;
  });
}

function flipBatchTiming(before: ProductRecord, after: ProductRecord): { flipDurationMs?: number } {
  const prior = new Map(before.state.executions.map((entry) => [entry.id, entry.flipCacheKey]));
  const flipped = after.state.executions.filter(
    (entry) => entry.flip && (!prior.has(entry.id) || prior.get(entry.id) !== entry.flipCacheKey),
  );
  return flipped.length
    ? { flipDurationMs: flipped.reduce((total, entry) => total + (entry.flipDurationMs ?? 0), 0) }
    : {};
}

async function finishExecution(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice | undefined,
  source: string,
  snapshot: Record<string, string>,
  commands: ProductCheck[],
  executions: ProductExecution[],
  close: boolean,
  accept: boolean,
  committedChanges: string[],
  changed: readonly string[],
  prepared: PreparedResultImages,
  gate: RegressionGateReport | undefined,
  signal?: AbortSignal,
): Promise<Result<ProductVerification>> {
  const afterSnapshot = await productSourceSnapshot(workspace, record.brief);
  if (!afterSnapshot.ok) return afterSnapshot;
  const after = await productSourceDigest(workspace, record.brief, afterSnapshot.value);
  if (!after.ok) return after;
  const timestamp = new Date().toISOString();
  // Pictures the product made reach the reviewer as images of the version the checks passed.
  const pictures = await publishResultImages(workspace, record, prepared, after.value);
  const escalation = changeEscalation(workspace, record, changed);
  const next = {
    ...record.state,
    pendingVerification: undefined,
    updatedAt: timestamp,
    executions: record.state.executions,
    captures: [...record.state.captures, ...pictures.captures],
    ...(escalation ? { profileEscalation: escalation } : {}),
  };
  const current: ProductRecord = { ...record, state: next };
  const gaps = await executionGaps(workspace, current, slice, after.value, commands, executions);
  if (source !== after.value)
    gaps.push(changedProductGap(snapshot, afterSnapshot.value, record.brief.checks));
  if (close)
    gaps.push(
      ...outstandingFeedback(current)
        .filter((entry) => entry.required && findingAppliesToSlice(entry, slice))
        .map((entry) => `${entry.id}: ${entry.problem}. ${entry.nextCheck}`),
    );
  if (accept)
    gaps.push(
      ...finalProductAssessmentGaps(current, after.value, undefined, reviewerRules(workspace)),
    );
  const regression = regressionGateCloseout(workspace, gate);
  gaps.push(...regression.gaps);
  const passed = gaps.length === 0;
  const completion = await completionState(workspace, record, next, {
    slice,
    close,
    accept,
    passed,
    subject: after.value,
  });
  if (!completion.ok) return completion;
  if (signal?.aborted) return cancelledExecution();
  const saved = await saveProductState(workspace, record, completion.value.state, [
    ...pictures.mutations,
    ...completion.value.mutations,
    ...regression.mutations,
  ]);
  if (!saved.ok) return saved;
  const checkpoint = await ensureProductCheckpoint(workspace, {
    feature: record.brief.feature,
    task: slice?.id,
  });
  if (close) await refreshProductIndex(workspace, Object.keys(afterSnapshot.value));
  const failed = executions.filter((execution) => execution.status === "failed");
  const repeated = failed.some((execution) =>
    record.state.executions.some(
      (before) =>
        before.id !== execution.id &&
        before.check === execution.check &&
        before.status === "failed" &&
        productFailureSignature(before) === productFailureSignature(execution),
    ),
  );
  const progress = await verificationProgress(workspace, current, slice, after.value);
  return ok({
    ...deliveryResult(
      record.brief.feature,
      slice?.id,
      passed,
      close,
      accept,
      executions
        .filter((entry) => entry.status === "environment-failed" || entry.status === "timed-out")
        .map((entry) => entry.output),
    ),
    checkpoint: checkpointDelivery(checkpoint),
    warnings: await productInputWarnings(workspace, record.brief),
    committedChanges,
    ...progress,
    feature: record.brief.feature,
    ...(slice ? { task: slice.id } : {}),
    subjectDigest: after.value,
    passed,
    ...(close ? { closed: passed } : {}),
    executions,
    ...regression.reply,
    ...(await profileReply(workspace, current, slice, after.value, close || accept)),
    outcomes: outcomeStatuses(current, after.value, slice),
    gaps: [...new Set(gaps)],
    journeyFeedback: currentJourneyFeedback(
      current,
      after.value,
      slice?.id,
      reviewerRules(workspace),
    ),
    behaviorChanges: checkBehaviorChanges(
      record.state.executions.filter(
        (before) => !executions.some((entry) => entry.id === before.id),
      ),
      executions,
    ),
    ...(repeated
      ? {
          recommendation: reviewerRules(workspace)
            ? "The same product failure recurred. Test a different hypothesis; metadata edits do not constitute progress."
            : "The same product failure recurred. Test a different hypothesis or request a focused review; metadata edits do not constitute progress.",
        }
      : {}),
  });
}

/** The profile once the feature left lean, and where each listed requirement stands at closure. */
async function profileReply(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice | undefined,
  subject: string,
  closing: boolean,
) {
  const profile = featureProfile(workspace, record);
  const requirements = closing ? await requirementStatus(workspace, record, slice, subject) : [];
  return {
    ...(profile.name === "full" ? { profile } : {}),
    ...(requirements.length ? { requirements } : {}),
  };
}

/** One scheduler serves verify/done, status and next, including critic-owned assessments. */
async function verificationProgress(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice | undefined,
  subject: string,
) {
  const next = await runProductNext(workspace, { feature: record.brief.feature, task: slice?.id });
  const feedbackPlan = productFeedbackPlan(record, subject, slice, {
    reviewer: await reviewerPointer(workspace, record.brief.feature, subject, slice?.id),
    requiredOnly: profileSettings(workspace, record).requestGaps === "required",
  });
  return {
    feedbackPlan,
    ...(next.ok ? { next: next.value, nextCommand: next.value.command } : {}),
  };
}

function deliveryResult(
  feature: string,
  task: string | undefined,
  passed: boolean,
  close: boolean,
  accept: boolean,
  environmentFailures: string[],
) {
  const environmentFailed = environmentFailures.length > 0;
  const recovery = environmentNext(feature, task, environmentFailures, "verify");
  const delivery = environmentFailed
    ? {
        status: "unresolved-environment",
        summary:
          "Not complete: required execution or review could not run. Recover the environment; product quality remains unverified.",
      }
    : !passed
      ? {
          status: "unresolved-product",
          summary: "Not complete: required product checks or assessments remain unresolved.",
        }
      : accept
        ? {
            status: "accepted",
            summary: "Required product acceptance checks and assessments passed.",
          }
        : close
          ? {
              status: "slice-closed",
              summary: "This slice is closed. Run visp next before reporting the feature complete.",
            }
          : {
              status: "checks-passed",
              summary:
                "Checks passed. Product completion still requires closure and final acceptance.",
            };
  return {
    delivery,
    nextCommand: environmentFailed ? recovery.command : "visp next",
    ...(environmentFailed ? { recovery: recovery.recovery } : {}),
  };
}

interface PreparedExecution {
  committedChanges: string[];
  /** Files the slice changed since its authorization, when it is being closed. */
  changed: string[];
  record: ProductRecord;
  slice?: ProductSlice;
  source: string;
  snapshot: Record<string, string>;
  commands: ProductCheck[];
}
async function prepareExecution(
  workspace: WorkspaceState,
  options: ProductSelection,
  close: boolean,
  accept: boolean,
): Promise<Result<PreparedExecution>> {
  const loaded = await readProductRecord(workspace, options);
  if (!loaded.ok) return loaded;
  const record = loaded.value;
  const editable = await closeoutAvailability(workspace, record.brief.feature, close, accept);
  if (!editable.ok) return editable;
  // Final acceptance is deliberately feature-wide, regardless of active local task.
  const selection = selectProductSlice(workspace, record, options, close);
  if (!selection.ok) return selection;
  const slice = accept ? undefined : selection.value;
  if (close && !slice) return err(vispError("NO_ACTIVE_TASK", "No slice selected for closure"));
  const open = record.brief.slices.filter(
    (entry) => !closedSlice(record.state.slices[entry.id]?.status),
  );
  if (accept && open.length)
    return err(
      vispError(
        "STAGE_BLOCKED",
        `Close the active slices before final product acceptance: ${open.map((entry) => entry.id).join(", ")}`,
        { recovery: `visp next --feature ${record.brief.feature}` },
      ),
    );
  const accounted = await recordRequirementAccounts(workspace, record, options.account);
  if (!accounted.ok) return accounted;
  let committedChanges: string[] = [];
  let changed: string[] = [];
  if (slice && !closedSlice(record.state.slices[slice.id]?.status)) {
    const scope = await checkProductScope(workspace, record, slice);
    if (!scope.ok)
      return err({
        ...scope.error,
        message: `${scope.error.message}; no checks or browser retry were run`,
        details: {
          ...scope.error.details,
          executionAttempted: false,
          browserRetryAttempted: false,
        },
      });
    committedChanges = scope.value.committedChanges;
    changed = scope.value.changed;
  }
  const snapshot = await productSourceSnapshot(workspace, record.brief);
  if (!snapshot.ok) return snapshot;
  const source = await productSourceDigest(workspace, record.brief, snapshot.value);
  if (!source.ok) return source;
  const commands = executionCommands(workspace, record, slice, close, accept, source.value);
  return ok({
    record,
    slice,
    source: source.value,
    snapshot: snapshot.value,
    commands,
    committedChanges,
    changed: close ? changed : [],
  });
}

/** Records the worker's account of listed requirements before the checks it cites run. */
async function recordRequirementAccounts(
  workspace: WorkspaceState,
  record: ProductRecord,
  entries: readonly string[] | undefined,
): Promise<Result<void>> {
  if (!entries?.length) return ok(undefined);
  const parsed = parseRequirementAccounts(entries);
  if (!parsed.ok) return parsed;
  const listed = accountedRequirements(record.brief.originalRequest);
  const mutation = await requirementAccountMutation(
    workspace,
    record.brief.feature,
    listed,
    parsed.value,
  );
  if (!mutation.ok || !mutation.value) return mutation.ok ? ok(undefined) : mutation;
  const saved = await applyFileTransaction(workspace.paths.root, "requirement-accounts", [
    mutation.value,
  ]);
  return saved.ok ? ok(undefined) : saved;
}

function closeoutAvailability(
  workspace: WorkspaceState,
  feature: string,
  close: boolean,
  accept: boolean,
): Promise<Result<void>> {
  return close || accept
    ? requireNoPendingCriticReview(
        workspace,
        feature,
        "Run visp next to wait for the pending review and receive its findings before closing or accepting",
      )
    : Promise.resolve(ok(undefined));
}

function lastOpenSlice(record: ProductRecord, slice: ProductSlice): boolean {
  return record.brief.slices.every(
    (entry) => entry.id === slice.id || closedSlice(record.state.slices[entry.id]?.status),
  );
}

function executionCommands(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice | undefined,
  close: boolean,
  accept: boolean,
  subject: string,
): ProductCheck[] {
  const { brief } = record;
  // The completing VISP review needs current receipts for earlier outcomes too. Checks
  // outside this slice retain feature ownership and the full feature contract.
  const completing = close && slice && reviewerRules(workspace) && lastOpenSlice(record, slice);
  const commands = [
    ...new Map(
      [
        ...checksFor(brief, completing ? undefined : slice),
        ...(slice ? correctionChecks(record, slice, subject) : []),
      ].map((check) => [check.id, check]),
    ).values(),
  ];
  // The last open slice completes the product, so the pinned tests should pass there too. A
  // failed pinned run also selects the suite as a correction check of that slice: run it once.
  if (accept || !slice || lastOpenSlice(record, slice))
    for (const pinned of pinnedAcceptanceChecks(brief))
      if (!commands.some((command) => command.id === pinned.id)) commands.push(pinned);
  for (const [index, command] of workspace.config.workflow.validationCommands.entries())
    commands.push({
      id: `CONFIG_${index + 1}`,
      command,
      outcomes: [],
      files: [],
      environment: "other",
    });
  return commands;
}

async function executionGaps(
  workspace: WorkspaceState,
  current: ProductRecord,
  slice: ProductSlice | undefined,
  subject: string,
  commands: ProductCheck[],
  executions: ProductExecution[],
): Promise<string[]> {
  const gaps = await productEvidenceGaps(workspace, current, subject, slice);
  for (const execution of executions)
    if (execution.status !== "passed")
      gaps.push(`${execution.check}: ${execution.status}: ${execution.output}`);
  const requiredCommands = new Map(
    applicableExecutions(current, subject).map((execution) => [
      executionOwnerKey(execution.check, execution.task),
      execution,
    ]),
  );
  for (const check of commands)
    if (
      requiredCommands.get(
        executionOwnerKey(check.id, slice?.checks.includes(check.id) ? slice.id : undefined),
      )?.status !== "passed"
    )
      gaps.push(`${check.id}: no current passing execution`);
  return gaps;
}

function changedProductGap(
  before: Record<string, string>,
  after: Record<string, string>,
  checks: readonly ProductCheck[],
): string {
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path])
    .sort();
  const prefix =
    "Product changed while checks ran; these executions describe the previous version.";
  if (!changed.length) return `${prefix} Control, runtime or environment inputs changed.`;
  const paths = changed.slice(0, 12).map((path) => JSON.stringify(path.slice(0, 200)));
  const omitted = changed.length > paths.length ? ` (+${changed.length - paths.length} more)` : "";
  return [
    `${prefix} Changed input paths: ${paths.join(", ")}${omitted}. ${CHECK_OUTPUT_GUIDANCE}`,
    ...productImageNotes(changed, checks),
  ].join(" ");
}

/**
 * A declared image that existed before the feature started stays product, so a check that
 * rewrites it, differently each run, changes the product every run; "make the check write it"
 * cannot fix that, a new output path can.
 */
function productImageNotes(changed: readonly string[], checks: readonly ProductCheck[]) {
  return checks.flatMap((check) =>
    (check.images ?? [])
      .filter((image) => changed.includes(image.replace(/\\/g, "/").replace(/^\.\//, "")))
      .map(
        (image) =>
          `${check.id}'s declared image ${image} existed before the feature started, so it is product and writing it changes the product; write the image to a new untracked path, e.g. out/<name>.png, and declare that path.`,
      ),
  );
}

async function completionState(
  workspace: WorkspaceState,
  record: ProductRecord,
  next: ProductState,
  options: {
    slice?: ProductSlice;
    close: boolean;
    accept: boolean;
    passed: boolean;
    subject: string;
  },
): Promise<Result<{ state: ProductState; mutations: FileMutation[] }>> {
  const { slice, close, accept, passed, subject } = options;
  const failedAcceptanceStatus = next.status === "accepted" ? "active" : next.status;
  const extra: FileMutation[] = [];
  if (passed && close && slice) {
    next.sliceHistory = [
      ...next.sliceHistory,
      {
        task: slice.id,
        from: record.state.slices[slice.id]?.status ?? "pending",
        to: "closed",
        createdAt: next.updatedAt,
        subjectDigest: subject,
        reason: "Required slice checks and review passed",
      },
    ];
    next.slices = {
      ...next.slices,
      [slice.id]: {
        status: "closed" as const,
        contractDigest: productContractDigest(record.brief, slice),
      },
    };
    const baseline = await reviewBaselineMutations(workspace, record, slice);
    if (!baseline.ok) return baseline;
    extra.push(...baseline.value);
    const status = await statusMutation(workspace, record.brief.feature, undefined, "done");
    if (!status.ok) return status;
    extra.push(status.value);
  }
  if (accept) {
    Object.assign(
      next,
      passed
        ? {
            status: "accepted",
            acceptedSubject: subject,
            acceptedContract: productContractDigest(record.brief),
            acceptedReviewPolicy: PRODUCT_REVIEW_POLICY,
          }
        : {
            status: failedAcceptanceStatus,
            acceptedSubject: undefined,
            acceptedContract: undefined,
            acceptedReviewPolicy: undefined,
          },
    );
  }
  return ok({ state: next, mutations: extra });
}

function checkpointDelivery(result: Awaited<ReturnType<typeof ensureProductCheckpoint>>) {
  if (!result.ok) return { gap: result.error.message };
  if (!result.value) return undefined;
  return {
    candidate: result.value.candidate,
    provenance:
      "First observed implementation; not a passing quality assessment. Preserve it when correcting behavior or visuals.",
  };
}
