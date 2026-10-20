import { join } from "node:path";
import { fromUnknown, vispError } from "../../../core/errors.js";
import type { FileMutation } from "../../../core/file-transaction.js";
import { hashValue } from "../../../core/hash.js";
import { err, ok, type Result } from "../../../core/result.js";
import { cliCommand } from "../../next-action.js";
import type { WorkspaceState } from "../../state.js";
import { finalProductAssessmentGaps, productEvidenceGaps } from "../assessment.js";
import { independentJudgments, independentReviewSchema } from "../review/independent-review.js";
import { deliveredReviewEvidenceIds } from "../review/review-context.js";
import {
  type DeliveredReviewEvidence,
  generatedSourceReferences,
  reviewCitationGap,
} from "../review/review-delivery-validation.js";
import { runProductReviewRequest } from "../review/review-request.js";
import { productSourceDigest } from "../subject.js";
import { reviewerRules } from "../tester/pinned-dispute-model.js";
import { applyDisputeRulings } from "../tester/pinned-disputes.js";
import type { ProductCriticHost } from "./critic.js";
import {
  type CriticAdapterCall,
  type CriticRequest,
  type CriticResponse,
  type CriticState,
  criticResponseSchema,
} from "./critic-model.js";
import { type CriticPacket, SOURCE_ADVICE_LIMITATION } from "./critic-packet.js";
import { criticStatus, hasFindings } from "./critic-status.js";
import {
  type CriticSelection,
  criticSelection,
  readCriticState,
  saveCriticState,
} from "./critic-store.js";

type HostResponse = Awaited<ReturnType<ProductCriticHost["review"]>>;
type Attempt = CriticState["attempts"][number];

export async function finishReview(
  workspace: WorkspaceState,
  request: CriticRequest,
  id: string,
  response: HostResponse | undefined,
  failure?: string,
  adapterReturnedAt?: number,
  adapterCall?: CriticAdapterCall,
): Promise<Result<unknown>> {
  const selected = await criticSelection(workspace, request);
  if (!selected.ok) return selected;
  const stored = await readCriticState(workspace, selected.value);
  if (!stored.ok) return stored;
  const state = stored.value.state;
  let pending = state?.attempts.find((a) => a.id === id && a.status === "pending");
  if (!state || !pending)
    return err(vispError("STATE_BUSY", "Critic reservation no longer exists"));
  const delivery = await legacyDeliveredEvidence(workspace, state, pending);
  if (!delivery.ok) return delivery;
  pending = {
    ...pending,
    ...attemptDelivery(delivery.value),
  };
  const subject = await productSourceDigest(workspace, selected.value.record.brief);
  if (!subject.ok) return subject;
  const validated = failure
    ? err(vispError("EVIDENCE_FAILED", failure))
    : validateResult(
        state,
        pending,
        selected.value,
        subject.value,
        response,
        false,
        adapterCompletionTime(request, pending, adapterReturnedAt),
        workspace.config.workflow.requestGaps === "required",
      );
  const { result, current, message } = await applyValidatedReview(
    workspace,
    selected.value,
    state,
    validated,
    delivery.value,
  );
  const disputes = await recordDisputeRulings(
    workspace,
    current,
    state,
    pending,
    request,
    response,
    result,
  );
  const gaps = [
    ...(result
      ? await reviewGaps(workspace, current, subject.value, result, pending.sourceOnly)
      : []),
    ...disputes.gaps,
  ];
  const advisoryResponse = lateUnderstandingAdvice(
    state,
    pending,
    selected.value,
    subject.value,
    response,
    failure,
  );
  const completion: Pick<
    Attempt,
    "status" | "message" | "response" | "gaps" | "failureKind" | "disputeRulings"
  > = {
    status: result ? "reviewed" : "unavailable",
    failureKind: result ? undefined : rejectedResponseKind(request, response),
    message,
    response: result,
    gaps,
    ...disputes.completion,
  };
  const next: CriticState = {
    ...state,
    attempts: state.attempts.map((attempt) =>
      attempt.id === id
        ? finishExecution(
            { ...attempt, ...completion },
            request,
            response,
            advisoryResponse,
            adapterCall,
          )
        : attempt,
    ),
    preferredCandidate:
      pending.phase === "understanding"
        ? state.preferredCandidate
        : preferredCandidate(state, pending.candidate, result, gaps),
  };
  const responseRecord = returnedResponseRecord(workspace, state, pending, request, response);
  const saved = await saveCriticState(
    workspace,
    current,
    stored.value.text,
    next,
    responseRecord?.mutations ?? [],
  );
  if (!saved.ok) return saved;
  const status = await criticStatus(workspace, { ...current.selection, phase: current.phase });
  if (!status.ok) return status;
  return ok({
    ...status.value,
    ...resultNavigation(current, result, gaps),
    comparison: result?.comparison,
    reason: message,
    ...(responseRecord
      ? {
          responseRecord: {
            path: responseRecord.path,
            provenance:
              "Adapter-returned object, serialized by VISP; no raw provider bytes were supplied",
          },
        }
      : {}),
  });
}

/**
 * The reviewer's rulings on disputed pinned tests. Only a review VISP itself launched and
 * observed (an attached adapter's `review`, never a native or host-submitted result) may
 * rule, and only on the disputes recorded on the attempt at reservation. A review without
 * rulings still uses up one of each dispute's reviews. If the disputes cannot be saved they
 * stay open and the gap says so.
 */
async function recordDisputeRulings(
  workspace: WorkspaceState,
  selected: CriticSelection,
  state: CriticState,
  pending: Attempt,
  request: CriticRequest,
  response: HostResponse | undefined,
  accepted: CriticResponse | undefined,
): Promise<{ completion: Pick<Attempt, "disputeRulings">; gaps: string[] }> {
  const asked = pending.disputes ?? [];
  if (
    !accepted ||
    pending.sourceOnly ||
    (pending.phase ?? "product") !== "product" ||
    !asked.length
  )
    return { completion: {}, gaps: [] };
  const independent =
    request.operation === "review" &&
    pending.execution?.provenance === "adapter-observed" &&
    pending.execution.claimed === true;
  const parsed = independentReviewSchema.safeParse(response?.response);
  const rulings = independent && parsed.success ? (parsed.data.disputes ?? []) : [];
  const applied = await applyDisputeRulings(workspace, selected.record.brief.feature, {
    attempt: pending.id,
    ...(selected.selection.task ? { task: selected.selection.task } : {}),
    subject: pending.subject,
    evidence: pending.evidenceDigest,
    model: state.config.model,
    asked,
    rulings,
  });
  return applied.ok
    ? { completion: rulings.length ? { disputeRulings: rulings } : {}, gaps: [] }
    : {
        completion: {},
        gaps: [
          `Pinned-test dispute rulings could not be recorded (${applied.error.message}); the disputes stay open. Run visp pr to hand them to the human reviewer`,
        ],
      };
}

async function applyValidatedReview(
  workspace: WorkspaceState,
  selected: CriticSelection,
  state: CriticState,
  validated: Result<CriticResponse>,
  deliveredEvidence?: DeliveredReviewEvidence,
): Promise<{ current: CriticSelection; result?: CriticResponse; message?: string }> {
  if (!validated.ok) return { current: selected, message: validated.error.message };
  const recorded = await recordResponse(
    workspace,
    selected,
    state,
    validated.value,
    deliveredEvidence,
  );
  return recorded.ok
    ? {
        current: recorded.value,
        result: {
          ...validated.value,
          review: {
            ...validated.value.review,
            feedback: recorded.value.record.state.reviews.at(-1)?.feedback,
          },
        },
      }
    : { current: selected, message: recorded.error.message };
}

function adapterCompletionTime(request: CriticRequest, pending: Attempt, returnedAt?: number) {
  return request.operation === "review" &&
    pending.execution?.provenance === "adapter-observed" &&
    pending.execution.claimed
    ? returnedAt
    : undefined;
}

function finishExecution(
  attempt: Attempt,
  request: CriticRequest,
  response: HostResponse | undefined,
  advisoryResponse: CriticResponse | undefined,
  adapterCall?: CriticAdapterCall,
): Attempt {
  return {
    ...attempt,
    ...(advisoryResponse ? { advisoryResponse } : {}),
    execution: {
      ...(attempt.execution ?? { provenance: "host-reported" as const }),
      ...(request.operation === "submit" ? { provenance: "host-reported" as const } : {}),
      ...(response &&
      request.operation === "review" &&
      attempt.execution?.provenance === "adapter-observed"
        ? { invoked: true }
        : {}),
      ...(request.notInvoked === true ? { invoked: false } : {}),
      ...(request.operation === "review" &&
      attempt.execution?.provenance === "adapter-observed" &&
      adapterCall
        ? { adapterCall }
        : {}),
      returned: response?.response !== undefined,
    },
  };
}

function returnedResponseRecord(
  workspace: WorkspaceState,
  state: CriticState,
  attempt: Attempt,
  request: CriticRequest,
  response: HostResponse | undefined,
) {
  if (request.operation !== "review" || response?.response === undefined) return undefined;
  const content = serializeReturnedResponse(response.response);
  if (content === undefined) return undefined;
  const path = join(
    workspace.paths.featureDir(state.feature),
    "critic",
    "requests",
    attempt.id,
    "returned.json",
  );
  const mutations: FileMutation[] = [
    {
      kind: "write",
      path,
      content,
      mode: 0o600,
      expectedBefore: { existed: false },
    },
  ];
  return { path, mutations };
}

/** Failed transport, changed subjects and invalid responses never become retained advice. */
function lateUnderstandingAdvice(
  state: CriticState,
  pending: Attempt,
  selected: CriticSelection,
  subject: string,
  response: HostResponse | undefined,
  failure: string | undefined,
) {
  if (
    failure ||
    pending.phase !== "understanding" ||
    Date.now() <= pending.startedAt + state.config.timeoutMs
  )
    return undefined;
  const validated = validateResult(state, pending, selected, subject, response, true);
  return validated.ok ? validated.value : undefined;
}

function resultNavigation(
  current: CriticSelection,
  result: CriticResponse | undefined,
  gaps: string[],
) {
  if (current.phase === "understanding")
    return {
      phase: current.phase,
      action: "worker",
      command: cliCommand("work", {
        feature: current.selection.feature,
        task: current.selection.task,
      }),
      guidance:
        "Apply design findings or supply counterevidence, then implement. This consultation provides no product-quality credit; keep the remaining call for actual product review.",
    };
  return { phase: current.phase, action: result ? workerAction(result, gaps) : "unresolved" };
}

function validateResult(
  state: CriticState,
  pending: Attempt,
  selected: CriticSelection,
  subject: string,
  response?: HostResponse,
  allowLateAdvice = false,
  adapterReturnedAt?: number,
  requestGaps = false,
): Result<CriticResponse> {
  const reject = (message: string) => err(vispError("EVIDENCE_FAILED", message));
  if (
    subject !== pending.subject ||
    selected.contract !== pending.contract ||
    selected.intent !== state.intent
  )
    return reject("Source or contract changed during critic review; result discarded");
  if (!allowLateAdvice && outsideDeadline(state, pending, adapterReturnedAt))
    return reject("Critic deadline expired; result discarded");
  if (response?.truncated) return reject("Critic response was truncated");
  if (response?.model !== state.config.model)
    return reject("Host returned a different model than configured");
  const hostGap = nativeResultGap(state, pending, response);
  if (hostGap) return reject(hostGap);
  if (!serializableResponse(response.response)) return reject("Critic response must be JSON");
  const supplied = normalizedResponse(response.response, pending, selected, requestGaps);
  const parsed = criticResponseSchema.safeParse(supplied);
  if (!parsed.success)
    return reject(
      `Critic returned invalid review JSON: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  const result = parsed.data;
  const phaseGap = resultPhaseGap(pending, result, response.response);
  if (phaseGap) return reject(phaseGap);
  if (new Set(result.comparison.map((d) => d.dimension)).size !== result.comparison.length)
    return reject("Duplicate comparison dimensions");
  if (
    !result.review.selection ||
    result.review.subjectDigest !== pending.subject ||
    hashValue(result.review.selection) !== pending.selectionDigest
  )
    return reject("Critic response refers to another candidate or image selection");
  if (result.review.captures !== undefined)
    return reject("Critic cannot supply new execution evidence");
  return ok(pending.sourceOnly ? sourceAdvice(result) : result);
}

/** Preserve raw output separately; source advice contributes findings, never approval. */
function sourceAdvice(result: CriticResponse): CriticResponse {
  return {
    review: {
      subjectDigest: result.review.subjectDigest,
      selection: result.review.selection,
      assessments: [],
      feedback: {
        phase: "product",
        dimensions: [],
        findings: result.review.feedback?.findings ?? [],
        resolutions: [],
        summary: result.review.feedback?.summary,
        limitations: [...(result.review.feedback?.limitations ?? []), SOURCE_ADVICE_LIMITATION],
      },
    },
    comparison: [],
    evidenceRequest: result.evidenceRequest,
  };
}

/** The response format allows rulings only for the disputes asked about, once each. */
function disputeRulingGap(pending: Attempt, response: unknown): string | undefined {
  const rulings = independentReviewSchema.safeParse(response).data?.disputes ?? [];
  const tests = rulings.map((entry) => entry.test);
  const asked = pending.disputes ?? [];
  return tests.some((test, index) => !asked.includes(test) || tests.indexOf(test) !== index)
    ? "Critic ruled on a pinned test that was not disputed, or ruled twice on one"
    : undefined;
}

function normalizedResponse(
  response: unknown,
  pending: Attempt,
  selected: CriticSelection,
  requestGaps: boolean,
) {
  const independent = independentReviewSchema.safeParse(response);
  return independent.success && pending.selection
    ? {
        review: {
          ...independentJudgments(
            independent.data,
            pending.phase ?? "product",
            selected.record.brief.outcomes,
            { requestGaps },
          ),
          subjectDigest: pending.subject,
          selection: pending.selection,
        },
        comparison: [],
      }
    : response;
}

function outsideDeadline(state: CriticState, attempt: Attempt, receivedAt = Date.now()) {
  return receivedAt < attempt.startedAt || receivedAt > attempt.startedAt + state.config.timeoutMs;
}

function resultPhaseGap(pending: Attempt, result: CriticResponse, raw?: unknown) {
  const rulingGap =
    reviewCitationGap(result, pending.deliveredEvidenceIds, pending.deliveredSourceManifest) ??
    disputeRulingGap(pending, raw);
  if (rulingGap) return rulingGap;
  const phase = pending.phase ?? "product";
  if (phase === "product" && !result.review.feedback) return undefined;
  if (result.review.feedback?.phase !== phase)
    return "Critic response must match the reserved review phase";
  if (phase !== "understanding") return undefined;

  if (
    result.review.assessments.length ||
    result.review.coverage?.length ||
    result.comparison.length ||
    result.review.experimentResolutions?.length ||
    result.review.feedback.resolutions.length
  )
    return "Understanding consultation cannot assess product outcomes, compare products or resolve product findings";
  return undefined;
}

function serializableResponse(response: unknown): boolean {
  return serializeReturnedResponse(response) !== undefined;
}

function serializeReturnedResponse(response: unknown): string | undefined {
  try {
    return JSON.stringify(response);
  } catch {
    return undefined;
  }
}

async function recordResponse(
  workspace: WorkspaceState,
  selected: CriticSelection,
  state: CriticState,
  response: CriticResponse,
  deliveredEvidence?: DeliveredReviewEvidence,
) {
  const recorded = await runProductReviewRequest(
    workspace,
    {
      ...selected.selection,
      ...response.review,
      reviewer: {
        context: "fresh",
        model: state.config.model,
        reason:
          "Host-reported fresh critic review; model, effort and independence are not authenticated",
      },
    },
    undefined,
    deliveredEvidence,
  );
  return recorded.ok
    ? criticSelection(workspace, { ...selected.selection, phase: selected.phase })
    : recorded;
}

async function reviewGaps(
  workspace: WorkspaceState,
  selected: CriticSelection,
  subject: string,
  response: CriticResponse,
  sourceOnly = false,
) {
  if (selected.phase === "understanding") return [];
  const gaps = [
    ...(await productEvidenceGaps(workspace, selected.record, subject, selected.slice)),
    ...finalProductAssessmentGaps(
      selected.record,
      subject,
      selected.slice,
      reviewerRules(workspace),
    ),
  ];
  if (sourceOnly) gaps.push(SOURCE_ADVICE_LIMITATION);
  if (response.comparison.some((entry) => entry.change === "worse"))
    gaps.push("Reviewer identified a regression; investigate before completion");
  return gaps;
}

function workerAction(response: CriticResponse, gaps: string[]) {
  return hasFindings(response) || gaps.length ? "worker" : "normal-acceptance";
}

function preferredCandidate(
  state: CriticState,
  id: string,
  response: CriticResponse | undefined,
  gaps: string[],
) {
  if (gaps.length || !response || hasFindings(response)) return state.preferredCandidate;
  if (!state.preferredCandidate) return id;
  const previous = state.attempts.find((attempt) => attempt.candidate === state.preferredCandidate);
  const current = state.attempts.find((attempt) => attempt.candidate === id);
  if (
    previous?.implementation === current?.implementation &&
    previous?.evidenceDigest === current?.evidenceDigest
  )
    return state.preferredCandidate;
  return response.comparison.some((c) => c.change === "better") ? id : state.preferredCandidate;
}

function nativeResultGap(state: CriticState, pending: Attempt, response: HostResponse) {
  if (pending.transport === "native" && pending.hostReport?.delegationAllowed !== true)
    return "Native host did not establish delegation authorization for this reservation";
  if (
    pending.transport === "native" &&
    (response.context !== "fresh" ||
      (state.config.reasoningEffort !== undefined &&
        response.reasoningEffort !== state.config.reasoningEffort))
  )
    return "Native host did not report the configured reasoning effort and fresh context";
  return undefined;
}

function rejectedResponseKind(request: CriticRequest, response: HostResponse | undefined) {
  return (
    request.failureKind ??
    (response?.response !== undefined ? "schema-rejected" : "invocation-failed")
  );
}

function attemptDelivery(delivered: DeliveredReviewEvidence | undefined) {
  return delivered
    ? {
        deliveredEvidenceIds: [...delivered.ids],
        deliveredGeneratedReferences: [...delivered.generatedReferences],
      }
    : {};
}

/** Native attempts already kept their exact packet before the delivered-ID field existed. */
async function legacyDeliveredEvidence(
  workspace: WorkspaceState,
  state: CriticState,
  attempt: Attempt,
): Promise<Result<DeliveredReviewEvidence | undefined>> {
  if (attempt.deliveredEvidenceIds)
    return ok({
      ids: attempt.deliveredEvidenceIds,
      generatedReferences: attempt.deliveredGeneratedReferences ?? [],
    });
  if (attempt.transport !== "native") return ok(undefined);
  const read = await workspace.files.readTextIfExists(
    join(
      workspace.paths.featureDir(state.feature),
      "critic",
      "requests",
      attempt.id,
      "packet.json",
    ),
  );
  if (!read.ok) return read;
  if (read.value === undefined) return ok(undefined);
  try {
    const packet = JSON.parse(read.value) as CriticPacket;
    return ok({
      ids: deliveredReviewEvidenceIds(
        packet.current.evidence,
        packet.current.interactionEvidence,
        packet.current.sources,
        packet.current.experiments,
      ),
      generatedReferences: generatedSourceReferences(
        packet.current.sources,
        packet.current.evidence,
      ),
    });
  } catch (cause) {
    return err(fromUnknown(cause, "EVIDENCE_FAILED"));
  }
}
