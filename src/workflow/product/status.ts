import type { VispError } from "../../core/errors.js";
import { sha256 } from "../../core/hash.js";
import { err, ok, type Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { outcomeStatuses, type ProductOutcomeStatus } from "./assessment.js";
import { criticNext } from "./critic/critic-guidance.js";
import { isStopHookObserver } from "./environment-model.js";
import { renderEvidenceRecord } from "./evidence-record/record-markdown.js";
import { productEvidenceRecord } from "./evidence-record/record-read.js";
import type { EvidenceRecord } from "./evidence-record/record-types.js";
import { withFlipAdvice } from "./flip/flip-advice.js";
import { featureStartingAge, hasUntakenPrompts } from "./host-prompts.js";
import { productInputWarnings } from "./input-warnings.js";
import type { ProductBrief, ProductState } from "./model.js";
import { productReviewDocument, reviewTitle } from "./review/review-document.js";
import { earlierSessionGrant, staleTaskNote } from "./scopes.js";
import type { ProductIdentity } from "./status-history.js";
import { nextFromRecord } from "./status-next.js";
import {
  briefPath,
  type ProductRecord,
  type ProductSelection,
  readProductRecord,
} from "./store.js";
import {
  productImplementationDigest,
  productSourceDigest,
  productSourceSnapshot,
} from "./subject.js";
import { userFeedbackPlan } from "./user-feedback.js";

export type ProductAction =
  | "understand"
  | "implement"
  | "fix"
  | "refine"
  | "accept"
  | "complete"
  | "wait";
export interface ProductNext {
  readonly action: ProductAction;
  readonly objective: string;
  readonly command?: string;
  readonly feature?: string;
  readonly task?: string;
  readonly evidence: readonly string[];
  readonly mayEdit: boolean;
  /** `handoff`: the review budget is spent; the open findings go to a human reviewer. */
  readonly completion?: "unresolved-environment" | "unresolved-product" | "handoff";
  readonly recovery?: string;
  /** Only for the Stop hook (`VISP_OBSERVER=stop-hook`): changes when the feature's state or source does. */
  readonly progress?: string;
  readonly criticAdvice?: {
    status: "suggested" | "unavailable" | "feedback";
    command?: string;
    guidance: string;
    findings?: readonly unknown[];
    comparisons?: readonly unknown[];
    evidenceRequest?: string;
    limitations?: readonly string[];
  };
  readonly userFeedback?: ReturnType<typeof userFeedbackPlan>;
}

export async function hasProductFeature(
  workspace: WorkspaceState,
  feature?: string,
): Promise<boolean> {
  const id = feature ?? workspace.status?.activeFeature;
  if (!id) return false;
  const exists = await workspace.files.exists(briefPath(workspace, id));
  return exists.ok && exists.value;
}

export async function runProductNext(
  workspace: WorkspaceState,
  options: ProductSelection = {},
): Promise<Result<ProductNext>> {
  const starting = await featureStartingNext(workspace, options);
  if (starting) return ok(starting);
  const loaded = await readProductRecord(workspace, options);
  if (!loaded.ok) return unavailableNext(loaded.error, workspace, options);
  const untaken = await newSessionRequestNext(workspace, loaded.value, options);
  if (!untaken.ok || untaken.value) return untaken.ok ? ok(untaken.value as ProductNext) : untaken;
  // The Stop hook needs the subject twice: for the plan and for its progress token.
  const observer = isStopHookObserver();
  let snapshot: Promise<Result<ProductIdentity>> | undefined;
  const getIdentity = () => {
    if (!observer) return currentProductIdentity(workspace, loaded.value.brief);
    snapshot ??= currentProductIdentity(workspace, loaded.value.brief);
    return snapshot;
  };
  const observed = async (result: Result<ProductNext>): Promise<Result<ProductNext>> => {
    if (!observer || !result.ok) return result;
    const identity = await getIdentity();
    return identity.ok
      ? ok({
          ...result.value,
          progress: sha256(`${loaded.value.stateText}\0${identity.value.subject}`),
        })
      : result;
  };
  const next = await nextFromRecord(workspace, loaded.value, options, getIdentity);
  if (!next.ok) return next;
  const warnings = await productInputWarnings(workspace, loaded.value.brief);
  const result = await criticNext(workspace, {
    ...withFlipAdvice(loaded.value, {
      ...next.value,
      evidence: [...next.value.evidence, ...warnings, ...staleTaskNote(workspace, loaded.value)],
    }),
  });
  if (!result.ok || (!loaded.value.state.criticManual && !loaded.value.state.userFeedback?.length))
    return observed(result);
  const subject = await productSourceDigest(workspace, loaded.value.brief);
  if (!subject.ok) return subject;
  const slice = loaded.value.brief.slices.find((entry) => entry.id === next.value.task);
  return observed(
    ok({
      ...result.value,
      userFeedback: userFeedbackPlan(workspace, loaded.value, slice, subject.value),
    }),
  );
}

export interface ProductStatus {
  readonly feature?: string;
  readonly brief?: ProductBrief;
  readonly state?: ProductState;
  readonly subjectDigest?: string;
  readonly outcomes: readonly ProductOutcomeStatus[];
  readonly next: ProductNext;
  readonly report: string;
}

async function currentProductIdentity(
  workspace: WorkspaceState,
  brief: ProductBrief,
): Promise<Result<ProductIdentity>> {
  const snapshot = await productSourceSnapshot(workspace, brief);
  if (!snapshot.ok) return snapshot;
  const subject = await productSourceDigest(workspace, brief, snapshot.value);
  return subject.ok
    ? ok({
        subject: subject.value,
        implementation: productImplementationDigest(workspace, snapshot.value),
        sourceSnapshot: snapshot.value,
      })
    : subject;
}

/** The selected feature's record, the version it is checked against, its outcomes and next step. */
type StatusRead =
  | { readonly kind: "unavailable"; readonly next: ProductNext }
  | {
      readonly kind: "feature";
      readonly record: ProductRecord;
      readonly subject: string;
      readonly outcomes: ProductOutcomeStatus[];
      readonly next: ProductNext;
    };

async function readStatus(
  workspace: WorkspaceState,
  options: ProductSelection,
): Promise<Result<StatusRead>> {
  const record = await readProductRecord(workspace, options);
  if (!record.ok) {
    const next = unavailableNext(record.error, workspace, options);
    return next.ok ? ok({ kind: "unavailable", next: next.value }) : next;
  }
  // One operation-local snapshot. Subsequent calls still refresh from disk.
  let snapshot: Promise<Result<ProductIdentity>> | undefined;
  const getIdentity = () => (snapshot ??= currentProductIdentity(workspace, record.value.brief));
  const planned = await nextFromRecord(workspace, record.value, options, getIdentity);
  if (!planned.ok) return planned;
  const next = await criticNext(workspace, {
    ...planned.value,
    evidence: [...planned.value.evidence, ...staleTaskNote(workspace, record.value)],
  });
  if (!next.ok) return next;
  const identity = await getIdentity();
  if (!identity.ok) return identity;
  const subject = identity.value.subject;
  return ok({
    kind: "feature",
    record: record.value,
    subject,
    outcomes: outcomeStatuses(record.value, subject),
    next: next.value,
  });
}

const unavailableReport = (next: ProductNext) => `${next.objective}\n\n${next.command}\n`;

export async function runProductStatus(
  workspace: WorkspaceState,
  options: ProductSelection = {},
): Promise<Result<ProductStatus>> {
  const status = await readStatus(workspace, options);
  if (!status.ok) return status;
  if (status.value.kind === "unavailable") {
    const { next } = status.value;
    return ok({ feature: next.feature, outcomes: [], next, report: unavailableReport(next) });
  }
  const { record, subject, outcomes, next } = status.value;
  const report = await productReviewDocument(workspace, record, outcomes, next);
  return ok({
    feature: record.brief.feature,
    brief: record.brief,
    state: record.state,
    subjectDigest: subject,
    outcomes,
    next,
    report,
  });
}

export interface ProductReport {
  readonly feature?: string;
  readonly markdown: string;
  /** Absent only when no feature can be read; `markdown` then says what to do. */
  readonly record?: EvidenceRecord;
  readonly next: ProductNext;
}

/** `visp pr`: the evidence record, and with `full` the whole handoff document after it. */
export async function runProductReport(
  workspace: WorkspaceState,
  options: ProductSelection & { readonly full?: boolean } = {},
): Promise<Result<ProductReport>> {
  const status = await readStatus(workspace, options);
  if (!status.ok) return status;
  if (status.value.kind === "unavailable") {
    const { next } = status.value;
    return ok({ feature: next.feature, markdown: unavailableReport(next), next });
  }
  const { record, subject, outcomes, next } = status.value;
  const evidence = await productEvidenceRecord(workspace, record, outcomes, subject, next);
  const page = renderEvidenceRecord(evidence, reviewTitle(record.brief.goal));
  const markdown = options.full
    ? `${page}\n---\n\n${await productReviewDocument(workspace, record, outcomes, next)}`
    : page;
  return ok({ feature: record.brief.feature, markdown, record: evidence, next });
}

/**
 * While `visp feature` is still recording a request, the answer is to wait. Workers whose
 * tool returned before `feature` printed asked `next`, were told to start a feature, and
 * started a second one (23 of 27 such runs).
 */
export async function featureStartingNext(
  workspace: WorkspaceState,
  options: ProductSelection,
): Promise<ProductNext | undefined> {
  if (options.feature || options.task) return undefined;
  const age = await featureStartingAge(workspace);
  if (age === undefined) return undefined;
  return {
    action: "wait",
    objective: `visp feature is still recording the request (running ${Math.round(age / 1000)} s). Wait for it to print its result; do not run it again`,
    command: "visp next",
    evidence: [],
    mayEdit: false,
  };
}

/**
 * A later session's request goes to a feature of its own. Workers in a new session asked
 * `visp next`, were sent to the earlier session's open task, and built the new request there,
 * without its rules, recalled decisions or a review of its own. A prompt no feature has taken,
 * sent after the open task's authorization lapsed with its session, is that new request. So
 * is one sent after the feature was accepted: told the old feature was complete, a later
 * session stopped with its request unbuilt (bench run co1-conventions-carryover-prose).
 */
export async function newSessionRequestNext(
  workspace: WorkspaceState,
  record: ProductRecord,
  options: ProductSelection,
): Promise<Result<ProductNext | undefined>> {
  // A worker that names the feature or task has already chosen to continue it.
  if (options.feature || options.task) return ok(undefined);
  const earlier = await earlierSessionGrant(workspace, record);
  if (!earlier.ok) return earlier;
  if (!earlier.value) return acceptedFeatureRequestNext(workspace, record);
  const untaken = await hasUntakenPrompts(workspace);
  if (!untaken.ok || !untaken.value) return untaken.ok ? ok(undefined) : untaken;
  const { task } = earlier.value;
  return ok({
    action: "understand",
    objective: `The user's request in this session is not part of ${record.brief.feature}, which an earlier session left open: start it as its own feature`,
    command: 'visp feature "<the user\'s request>"',
    evidence: [
      `Only if the user asked to continue "${record.brief.goal}": visp work --feature ${record.brief.feature} --task ${task}`,
    ],
    mayEdit: false,
  });
}

/** Acceptance is the feature's last state change: a prompt recorded after it is newer than the acceptance. */
async function acceptedFeatureRequestNext(
  workspace: WorkspaceState,
  record: ProductRecord,
): Promise<Result<ProductNext | undefined>> {
  if (record.state.status !== "accepted") return ok(undefined);
  const untaken = await hasUntakenPrompts(workspace, record.state.updatedAt);
  if (!untaken.ok || !untaken.value) return untaken.ok ? ok(undefined) : untaken;
  return ok({
    action: "understand",
    objective: `The user's latest message came after ${record.brief.feature} was accepted, and no feature has taken it. If it asks for a change, start it as its own feature`,
    command: 'visp feature "<the user\'s request>"',
    evidence: [],
    mayEdit: false,
  });
}

function unavailableNext(
  error: VispError,
  workspace: WorkspaceState,
  options: ProductSelection,
): Result<ProductNext> {
  if (error.code === "NO_ACTIVE_FEATURE")
    return ok({
      action: "understand",
      objective:
        workspace.checkoutNotice ??
        "Record the original request and define the next useful outcome",
      command: workspace.checkoutNotice ? "git switch -" : 'visp feature "<goal>"',
      evidence: [],
      mayEdit: false,
    });
  if (error.code === "MIGRATION_REQUIRED")
    return ok({
      action: "understand",
      objective: "Preview and migrate this feature to the product workflow",
      command: error.recovery ?? "visp migrate --dry-run",
      feature: options.feature ?? workspace.status?.activeFeature,
      evidence: ["MIGRATION_REQUIRED: legacy artifacts remain historical and unchanged"],
      mayEdit: false,
    });
  return err(error);
}
