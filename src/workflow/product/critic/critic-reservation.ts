import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { vispError } from "../../../core/errors.js";
import { hashValue } from "../../../core/hash.js";
import { err, ok } from "../../../core/result.js";
import type { WorkspaceState } from "../../state.js";
import { applicableExecutions } from "../assessment.js";
import { prepareCandidate, readCandidate } from "../candidate.js";
import { productFailureSignature } from "../failures.js";
import { openRequiredFindings } from "../findings.js";
import { executionSchema, type ProductSlice, productStateSchema } from "../model.js";
import { reproductionContextDigest } from "../reproduction-bindings.js";
import { reviewRoundGap } from "../review/review-cadence.js";
import { deliveredReviewEvidenceIds } from "../review/review-context.js";
import { generatedSourceReferences } from "../review/review-delivery-validation.js";
import { reviewerHandoffCandidates } from "../review/reviewer-handoff.js";
import type { ProductRecord } from "../store.js";
import { productImplementationDigest } from "../subject.js";
import { reviewerRules } from "../tester/pinned-dispute-model.js";
import { disputeSetKey, disputeState } from "../tester/pinned-disputes.js";
import {
  featureCriticBudgetGap,
  featureCriticCapacity,
  readFeatureCriticBudget,
} from "./critic-budget.js";
import type { CriticPhase, CriticRequest, CriticState } from "./critic-model.js";
import { nativeCapabilityGaps, nativePacket } from "./critic-native.js";
import { criticPacket, currentReviewGap, packetHasImages } from "./critic-packet.js";
import { CRITIC_SETUP_GAP, missingCriticSetup } from "./critic-policy.js";
import { criticRecoveryAuthorizationGap, criticRetryError } from "./critic-recovery.js";
import { observedProduct, stopReason } from "./critic-status.js";
import { criticSelection, readCriticState, saveCriticState } from "./critic-store.js";
import { phaseReviewGap } from "./critic-understanding.js";

const historicalExecutions = z
  .object({
    executions: z.array(executionSchema),
    reproductions: productStateSchema.shape.reproductions,
  })
  .passthrough();
const historicalHandoff = z
  .object({
    images: z.array(z.object({ sha256: z.string() }).passthrough()),
    evidence: z.array(
      z
        .object({
          kind: z.string(),
          status: z.string(),
          summary: z.string(),
          measurement: z.unknown().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
type Handoff = Extract<
  Awaited<ReturnType<typeof reviewerHandoffCandidates>>,
  { ok: true }
>["value"];

export async function reserveReview(workspace: WorkspaceState, request: CriticRequest) {
  const context = await reviewContext(workspace, request);
  if (!context.ok) return context;
  const { selected, stored, state, handoff, packet, effectiveConfig } = context.value;
  const evidence = await prepareReviewEvidence(
    workspace,
    selected.value,
    state,
    request,
    handoff.value,
  );
  if (!evidence.ok) return evidence;
  const { prepared, implementation, evidenceDigest } = evidence.value;
  const id = randomUUID();
  const delivery =
    request.operation === "prepare"
      ? nativePacket(
          packet.value,
          join(workspace.paths.featureDir(state.feature), "critic", "requests", id),
          effectiveConfig,
        )
      : undefined;
  if (delivery && !delivery.ok) return delivery;
  const delivered = delivery?.value;
  const sources = delivered?.sources ?? packet.value.current.sources;
  const startedAt = Date.now(); // Context, snapshots and image encoding are prepared before the clock starts.
  const next: CriticState = {
    ...state,
    contract: selected.value.contract,
    attempts: [
      ...endedWithoutResult(
        state,
        relaunchesReview(workspace, request),
        selected.value.phase,
        startedAt,
      ),
      {
        id,
        phase: selected.value.phase,
        candidate: prepared.value.candidate.id,
        subject: handoff.value.subjectDigest,
        contract: selected.value.contract,
        implementation,
        intent: selected.value.intent,
        evidenceDigest,
        selectionDigest: hashValue(packet.value.selection),
        selection: packet.value.selection,
        deliveredEvidenceIds: deliveredReviewEvidenceIds(
          packet.value.current.evidence,
          packet.value.current.interactionEvidence,
          sources,
          packet.value.current.experiments,
        ),
        deliveredGeneratedReferences: generatedSourceReferences(sources, handoff.value.sources),
        requiresImages: packetHasImages(packet.value),
        ...(request.sourceOnly ? { sourceOnly: true } : {}),
        // Rulings count only for the disputes the reviewer was asked about here.
        ...(packet.value.disputes?.length
          ? { disputes: packet.value.disputes.map((dispute) => dispute.test) }
          : {}),
        startedAt,
        status: "pending",
        ...(request.retryAfter
          ? {
              recovery: {
                after: request.retryAfter,
                reason: request.reason as string,
                provenance: "host-reported" as const,
              },
            }
          : {}),
        transport: request.operation === "prepare" || request.capabilities ? "native" : "sampling",
        // The attached launcher reports capabilities too, so transport alone cannot tell who ran it.
        ...(relaunchesReview(workspace, request) ? { launcher: "visp" as const } : {}),
        ...(request.capabilities ? { hostReport: request.capabilities } : {}),
      },
    ],
  };
  const saved = await saveCriticState(workspace, selected.value, stored.value.text, next, [
    ...prepared.value.mutations,
    ...(delivered?.mutations ?? []),
  ]);
  return saved.ok
    ? ok({
        packet: packet.value,
        config: effectiveConfig,
        id,
        selection: selected.value.selection,
        handoff: delivered?.handoff,
        expiresAt: startedAt + state.config.timeoutMs,
      })
    : saved;
}

/** VISP launches the reviewer only for a review it runs itself; a host `--preflight` stays strict. */
export function relaunchesReview(workspace: WorkspaceState, request: CriticRequest) {
  return reviewerRules(workspace) && request.operation === "review";
}

/**
 * A reviewer process that ended without a result before its deadline never returns one. Marking it
 * unavailable in the save that reserves the fresh review spends no call (its reservation already counted).
 */
function endedWithoutResult(
  state: CriticState,
  relaunch: boolean,
  phase: CriticPhase,
  now: number,
) {
  return state.attempts.map((attempt) =>
    relaunch &&
    (attempt.phase ?? "product") === phase &&
    attempt.status === "pending" &&
    now > attempt.startedAt + state.config.timeoutMs
      ? {
          ...attempt,
          status: "unavailable" as const,
          failureKind: "invocation-failed" as const,
          message: "The reviewer process ended without a result before its deadline",
        }
      : attempt,
  );
}

async function prepareReviewEvidence(
  workspace: WorkspaceState,
  selected: import("./critic-store.js").CriticSelection,
  state: CriticState,
  request: CriticRequest,
  handoff: Handoff,
) {
  const prepared = await prepareCandidate(workspace, selected, handoff);
  if (!prepared.ok) return prepared;
  if (prepared.value.candidate.subject !== handoff.subjectDigest)
    return err(vispError("EVIDENCE_FAILED", "Source changed while preparing critic context"));
  const implementation = productImplementationDigest(workspace, prepared.value.snapshot);
  const evidenceScope = selected.phase === "product" ? selected.slice : undefined;
  // A review of other disputes is a new review even when the source and checks are the same.
  const disputes = disputeSetKey(
    (await disputeState(workspace, selected.record.brief.feature)).pending,
  );
  const evidenceDigest = reviewEvidenceDigest(
    selected.record,
    handoff.subjectDigest,
    evidenceScope,
    handoff,
    disputes,
  );
  const unique = await requireNewReview(
    workspace,
    selected,
    state,
    request,
    implementation,
    evidenceDigest,
  );
  if (!unique.ok) return unique;
  return ok({ prepared, implementation, evidenceDigest });
}

function reviewEvidenceDigest(
  record: ProductRecord,
  subject: string,
  slice: ProductSlice | undefined,
  handoff: {
    readonly images: readonly { readonly sha256: string }[];
    readonly evidence: readonly {
      readonly kind: string;
      readonly status: string;
      readonly summary: string;
      readonly measurement?: unknown;
    }[];
  },
  disputes?: string,
) {
  return hashValue({
    checks: [
      ...new Set(applicableExecutions(record, subject, slice).map(productFailureSignature)),
    ].sort(),
    images: handoff.images.map((image) => image.sha256),
    observations: handoff.evidence
      .filter((entry) => ["operation", "control"].includes(entry.kind))
      .map(({ kind, status, summary, measurement }) => ({ kind, status, summary, measurement })),
    ...(disputes ? { disputes } : {}),
    reproductions: reproductionContextDigest(record),
    journeyRetirements: record.state.journeyRetirements?.filter(
      (entry) => !slice || !entry.task || entry.task === slice.id,
    ),
  });
}

async function requireNewReview(
  workspace: WorkspaceState,
  selected: import("./critic-store.js").CriticSelection,
  state: CriticState,
  request: CriticRequest,
  implementation: string,
  evidenceDigest: string,
) {
  // A saved assessment without a disposition leaves real review work outstanding.
  // VISP may spend remaining capacity on it; reservation budget and evidence guards still apply.
  if (owesResolutionReview(workspace, selected, request)) return ok(undefined);
  for (const attempt of state.attempts) {
    if (
      attempt.status !== "reviewed" ||
      !!attempt.sourceOnly !== !!request.sourceOnly ||
      (attempt.phase ?? "product") !== selected.phase ||
      attempt.implementation !== implementation ||
      attempt.contract !== selected.contract
    )
      continue;
    if (attempt.evidenceDigest === evidenceDigest) return duplicateReview();
    if (selected.phase !== "product" || !selected.slice) continue;
    const historical = await historicalSelectedEvidenceDigest(workspace, selected, attempt);
    if (!historical.ok) return historical;
    if (historical.value === evidenceDigest) return duplicateReview();
  }
  return ok(undefined);
}

function owesResolutionReview(
  workspace: WorkspaceState,
  selected: import("./critic-store.js").CriticSelection,
  request: CriticRequest,
) {
  return (
    selected.phase === "product" &&
    !request.sourceOnly &&
    relaunchesReview(workspace, request) &&
    openRequiredFindings(selected.record, selected.slice).length > 0
  );
}

function duplicateReview() {
  return err(
    vispError(
      "STAGE_BLOCKED",
      "This implementation and evidence were already reviewed; return to the worker with a different hypothesis or a focused observation",
    ),
  );
}

async function historicalSelectedEvidenceDigest(
  workspace: WorkspaceState,
  selected: import("./critic-store.js").CriticSelection,
  attempt: CriticState["attempts"][number],
) {
  const candidate = await readCandidate(workspace, selected, attempt.candidate);
  if (!candidate.ok) return candidate;
  let parsedState: unknown;
  try {
    parsedState = JSON.parse(candidate.value.productState);
  } catch {
    return err(vispError("ARTIFACT_INVALID", "Cannot compare historical critic evidence"));
  }
  const snapshot = historicalExecutions.safeParse(parsedState);
  const handoff = historicalHandoff.safeParse(candidate.value.evidence);
  if (!snapshot.success || !handoff.success)
    return err(vispError("ARTIFACT_INVALID", "Cannot compare historical critic evidence"));
  return ok(
    reviewEvidenceDigest(
      {
        ...selected.record,
        state: {
          ...selected.record.state,
          executions: snapshot.data.executions,
          reproductions: snapshot.data.reproductions,
        },
      },
      attempt.subject,
      selected.slice,
      handoff.data,
    ),
  );
}

async function reviewContext(workspace: WorkspaceState, request: CriticRequest) {
  const selected = await criticSelection(workspace, request);
  if (!selected.ok) return selected;
  const policyError = reservationPolicyError(selected.value);
  if (policyError) return err(policyError);
  const stored = await readCriticState(workspace, selected.value);
  if (!stored.ok) return stored;
  const state = stored.value.state;
  if (!state) return err(vispError("CONFIG_INVALID", unconfiguredMessage(selected.value)));
  const transportGap = samplingGap(request, state);
  if (transportGap) return err(vispError("CONFIG_INVALID", transportGap));
  const retryError = criticRetryError(state, request, selected.value.phase);
  if (retryError) return err(vispError("STATE_BUSY", retryError));
  const handoff = await reviewerHandoffCandidates(workspace, selected.value.selection);
  if (!handoff.ok) return handoff;
  const reason = stopReason(
    state,
    handoff.value.subjectDigest,
    selected.value.contract,
    selected.value.intent,
    selected.value.phase,
    request.retryAfter,
    { relaunch: relaunchesReview(workspace, request) },
  );
  if (reason) return err(vispError("STAGE_BLOCKED", reason));
  const capacity = await reservationCapacity(
    workspace,
    request,
    selected.value,
    state,
    handoff.value.subjectDigest,
  );
  if (!capacity.ok) return capacity;
  const packet = await criticPacket(
    workspace,
    selected.value,
    state,
    handoff.value,
    request.question,
    request.sourceOnly,
  );
  if (!packet.ok) return packet;
  const currentGap = currentReviewGap(packet.value, selected.value);
  if (currentGap) return err(vispError("EVIDENCE_MISSING", currentGap));
  const capabilityError = reservationCapabilityError(request, state, packetHasImages(packet.value));
  if (capabilityError) return err(capabilityError);
  return ok({
    selected,
    stored,
    state,
    handoff,
    packet,
    effectiveConfig: capacity.value,
  });
}

async function reservationCapacity(
  workspace: WorkspaceState,
  request: CriticRequest,
  selected: import("./critic-store.js").CriticSelection,
  state: CriticState,
  subject: string,
) {
  const budget = await readFeatureCriticBudget(workspace, state.feature, state.config);
  if (!budget.ok) return budget;
  const budgetGap = featureCriticBudgetGap(budget.value.budget, state.config.timeoutMs);
  if (budgetGap) return err(vispError("STAGE_BLOCKED", budgetGap));
  const roundGap =
    selected.phase === "product"
      ? reviewRoundGap(workspace, selected.record, budget.value)
      : undefined;
  if (roundGap) return err(vispError("STAGE_BLOCKED", roundGap));
  const authorizationGap = criticRecoveryAuthorizationGap(request);
  if (authorizationGap) return err(vispError("CONFIG_INVALID", authorizationGap));
  const phaseGap = phaseReviewGap(
    selected,
    state,
    observedProduct(workspace, selected.record, selected.slice, subject),
    request.retryAfter,
    featureCriticCapacity(budget.value.budget, state.config.timeoutMs).reservableCalls,
  );
  if (phaseGap && !request.sourceOnly) return err(phaseError(selected.phase, phaseGap));
  return ok({ ...state.config, maxCalls: budget.value.budget.maxCalls });
}

function reservationCapabilityError(
  request: CriticRequest,
  state: CriticState,
  hasImages: boolean,
) {
  if (request.operation !== "prepare" && !request.capabilities) return undefined;
  const gaps = nativeCapabilityGaps(state.config, request.capabilities, hasImages);
  return gaps.length ? vispError("CONFIG_INVALID", gaps.join(" ")) : undefined;
}

function reservationPolicyError(selected: import("./critic-store.js").CriticSelection) {
  if (selected.record.state.status === "historical-complete")
    return vispError(
      "STAGE_BLOCKED",
      "Historical features are read-only; create a new feature for critic evaluation",
    );
  if (selected.record.state.criticEnabled === false)
    return vispError(
      "STAGE_BLOCKED",
      "Feature critic is off; only an explicit user request should enable it",
    );
  return undefined;
}

function unconfiguredMessage(selected: import("./critic-store.js").CriticSelection) {
  return missingCriticSetup(selected.record.state)
    ? CRITIC_SETUP_GAP
    : "Configure the optional critic with an explicit model and limits first";
}

function samplingGap(request: CriticRequest, state: CriticState) {
  if (request.operation !== "review") return undefined;
  if (request.capabilities && state.config.transport === "native") return undefined;
  if (state.config.transport === "native")
    return "Native critic requires preflight/prepare/submit; no call spent";
  if (state.config.reasoningEffort)
    return "MCP sampling does not guarantee reasoning effort; use native transport or omit the effort requirement";
  return undefined;
}

function phaseError(phase: string, message: string) {
  return vispError(phase === "understanding" ? "STAGE_BLOCKED" : "EVIDENCE_MISSING", message);
}
