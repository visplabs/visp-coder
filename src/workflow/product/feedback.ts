import { vispError } from "../../core/errors.js";
import { hashValue } from "../../core/hash.js";
import { err, ok, type Result } from "../../core/result.js";
import { productBehaviorProbes } from "./behavior-probes.js";
import { validCaptureRuns } from "./capture-run-model.js";
import { productCheckGuidance } from "./check/check-guidance.js";
import { environmentRecovery } from "./environment-model.js";
import {
  ambiguousEvidenceIds,
  currentFailedJourneys,
  evidenceApplies,
  type ProductEvidenceCatalogue,
  supportsBehaviorEvidence,
  withoutUnavailableCitations,
} from "./evidence-references.js";
import {
  exploratoryFailureHistory,
  historicalFailureReferences,
  historicalFindingJourney,
} from "./exploratory-history.js";
import { productFailureSignature } from "./failures.js";
import { findingAppliesToSlice, outstandingFeedback } from "./findings.js";

export { findingAppliesToSlice, outstandingFeedback } from "./findings.js";

import {
  type ProductFeedback,
  productFeedbackSchema,
  resolutionClosesFinding,
} from "./feedback-model.js";
import { functionalRegressionEvidenceGap } from "./functional-regression.js";
import { findFunctionalRepair, functionalDisproofEvidenceGap } from "./functional-resolution.js";
import type { ProductBrief, ProductReviewerContext, ProductSlice } from "./model.js";
import { productObservationPlan } from "./observation-plan.js";
import { currentProbeResponses, validateProbeResponses } from "./probe-feedback.js";
import { repairRecheck } from "./repair-recheck.js";
import { findingReproductions } from "./reproduction-bindings.js";
import type { ProductRecord } from "./store.js";
import { productContractDigest } from "./subject.js";
import { type ReviewerPointer, visualCheckpoint } from "./visual-checkpoint.js";

export function feedbackIntentDigest(brief: ProductBrief) {
  return hashValue({
    request: brief.originalRequest,
    outcomes: brief.outcomes,
    examples: brief.examples,
    checks: brief.checks,
  });
}

export function feedbackTemplate(phase: ProductFeedback["phase"] = "product"): ProductFeedback {
  return {
    phase,
    dimensions: [],
    findings: [],
    resolutions: [],
  };
}

export function productFeedbackGaps(
  record: ProductRecord,
  subject: string,
  slice?: ProductSlice,
): string[] {
  const reviews = record.state.reviews.filter(
    (review) =>
      (!review.task || (slice ? review.task === slice.id : record.brief.slices.length === 1)) &&
      review.subjectDigest === subject &&
      review.contractDigest ===
        productContractDigest(
          record.brief,
          record.brief.slices.find((slice) => slice.id === review.task),
        ) &&
      review.feedback?.phase !== "understanding",
  );
  const latest = new Map(
    reviews.flatMap(
      (review) =>
        review.feedback?.dimensions.map((entry) => [entry.dimension, entry] as const) ?? [],
    ),
  );
  return [
    ...[...latest.values()]
      .filter((entry) => entry.status === "failed")
      .map((entry) => `${entry.dimension}: ${entry.reason}`),
    ...(reviews.at(-1)?.reviewer?.context === "unavailable"
      ? [
          "Product reviewer unavailable: " +
            (reviews.at(-1)?.reviewer?.reason ?? "no assessment could be made"),
        ]
      : []),
    ...outstandingFeedback(record)
      .filter((finding) => finding.required && findingAppliesToSlice(finding, slice))
      .map(
        (finding) =>
          `${finding.id}: ${finding.dimension}: ${finding.problem}. Next check: ${finding.nextCheck}`,
      ),
  ];
}

function environmentFeedback(record: ProductRecord, slice?: ProductSlice) {
  return {
    capability: record.state.browserCapability
      ? {
          status: record.state.browserCapability.status,
          detail: record.state.browserCapability.detail,
          ...(record.state.browserCapability.status === "unavailable"
            ? { recovery: environmentRecovery }
            : {}),
          review:
            "The host must inspect actual images and interactions; a capture-capable browser does not establish reviewer availability or product quality.",
        }
      : undefined,
    firstSlice:
      !record.state.captureRuns.length &&
      record.brief.outcomes.some((outcome) => outcome.kind === "experience")
        ? {
            objective: "Build one complete usable interaction before expanding content or variants",
            observe:
              "Exercise ordinary user input through a meaningful result, an unsuccessful path and recovery where applicable. Inspect representative images before adding more levels, screens or polish.",
            example: record.brief.examples.find(
              (example) => !slice || example.outcomes.some((id) => slice.outcomes.includes(id)),
            )?.title,
          }
        : undefined,
  };
}

export function productFeedbackPlan(
  record: ProductRecord,
  subject: string,
  slice?: ProductSlice,
  reviewMode: "current" | "observation-preview" = "current",
  options: { readonly reviewer?: ReviewerPointer; readonly requiredOnly?: boolean } = {},
) {
  // Lean mode's requestGaps: advisory findings are notes, never a next correction.
  const findings = outstandingFeedback(record).filter(
    (entry) => findingAppliesToSlice(entry, slice) && (!options.requiredOnly || entry.required),
  );
  const gaps = productFeedbackGaps(record, subject, slice);
  const question = record.brief.uncertainties[0];
  const failure = journeyQuestion(record, subject, slice) ?? executionQuestion(record, slice);
  const finding = findings.find((entry) => entry.required) ?? (failure ? undefined : findings[0]);
  const issue = finding?.problem ?? failure?.question;
  const repeated = finding ? finding.repeats >= 2 : failure?.repeated;
  const researchQuestion = researchFocus(issue, repeated, question);
  const probes = productBehaviorProbes(record, slice).probes;
  const responses = currentProbeResponses(record, subject, slice);
  const unresolvedProbe = [...responses.values()].find((entry) =>
    ["failed", "unclear"].includes(entry.status),
  );
  return {
    ...environmentFeedback(record, slice),
    observationPlan: productObservationPlan(record, subject, slice),
    nextProbe: probes.find(
      (probe) => !["satisfied", "not-applicable"].includes(responses.get(probe.kind)?.status ?? ""),
    ),
    probeResponses: [...responses.values()].map(({ kind, status }) => ({ kind, status })),
    checkSetup: productCheckGuidance(record.brief, slice),
    visualCheckpoint: visualCheckpoint(record, subject, slice, reviewMode, options.reviewer),
    focus: feedbackFocus(findings.some((entry) => entry.required) || !!failure, gaps.length > 0),
    research: researchQuestion
      ? {
          question: researchQuestion,
          method:
            "Use the host's research capability for external facts, or a bounded local experiment for repository behavior. Choose whichever can resolve this question.",
          consume:
            "Update the existing brief decision with the conclusion, evidence, implementation implication and affected check; remove only the uncertainty actually resolved. Then build or correct the slice.",
          required: false,
        }
      : undefined,
    trace: {
      question: finding
        ? `Which handler or state transition causes ${finding.problem}?`
        : (failure?.question ??
          `Which code owns ${slice?.goal ?? record.brief.goal}, and which callers and tests will change?`),
      command: `visp work --feature ${record.brief.feature}${slice ? ` --task ${slice.id}` : ""}`,
      guidance:
        "work refreshes the graph and supplies code. Follow the relevant entry point/callers; an empty or partial graph requires direct code inspection, not invented dependencies.",
    },
    findings: findings.slice(0, 3).map((entry) => ({
      ...entry,
      reproductions: findingReproductions(record, entry),
      ...(entry.phase === "product"
        ? { recheck: repairRecheck(record, entry, subject, entry.task ?? slice?.id) }
        : {}),
    })),
    findingsRemaining: Math.max(0, findings.length - 3),
    gaps: gaps.slice(0, 5).map((gap) => gap.slice(0, 360)),
    gapsRemaining: Math.max(0, gaps.length - 5),
    nextCheck:
      finding?.nextCheck ??
      (failure && "nextCheck" in failure ? failure.nextCheck : undefined) ??
      unresolvedProbe?.exercise ??
      "Exercise the next complete behavior, then inspect whether the result fulfills the original request across relevant quality dimensions.",
  };
}

function researchFocus(
  issue: string | undefined,
  repeated: boolean | undefined,
  uncertainty: string | undefined,
) {
  if (!issue) return uncertainty;
  return repeated ? `What different hypothesis explains ${issue}?` : issue;
}

function journeyQuestion(record: ProductRecord, subject: string, slice?: ProductSlice) {
  const failed = currentFailedJourneys(record, subject, slice?.id)
    .filter((run) => run.failure?.kind === "behavior")
    .at(-1);
  if (!failed) return undefined;
  const signature = (message: string) =>
    productFailureSignature({ check: "browser", status: "failed", exitCode: 1, output: message });
  const failureSignature = signature(failed.failure?.message ?? "");
  const attempts = validCaptureRuns(record).reduce<number>(
    (count, run) =>
      evidenceApplies(record, subject, run) &&
      run.task === failed.task &&
      run.failure?.kind === "behavior" &&
      signature(run.failure.message) === failureSignature
        ? count + 1
        : count,
    0,
  );
  return {
    question: `Which input convention, handler or state transition explains ${failed.failure?.message.slice(0, 600)}? Compare the expected behavior with a different hypothesis before only changing input coordinates or tuning constants.`,
    repeated: attempts >= 2,
  };
}

function executionQuestion(record: ProductRecord, slice?: ProductSlice) {
  const relevant = record.state.executions.filter(
    (entry) =>
      !slice || entry.task === slice.id || (!entry.task && slice.checks.includes(entry.check)),
  );
  const failed = [
    ...new Map(
      relevant.map((entry) => [JSON.stringify([entry.check, entry.task]), entry]),
    ).values(),
  ].find((entry) => entry.status === "failed");
  if (!failed) return undefined;
  return {
    question: `Which handler or state transition explains ${failed.check}: ${failed.output.slice(-600)}?`,
    nextCheck: `Rerun ${failed.check} after correcting its failed behavior; preserve the original outcome and check a relevant counterexample.`,
    repeated:
      relevant.filter(
        (entry) =>
          entry.check === failed.check &&
          entry.task === failed.task &&
          entry.status === "failed" &&
          productFailureSignature(entry) === productFailureSignature(failed),
      ).length >= 2,
  };
}

export function validateProductFeedback(
  input: unknown,
  record: ProductRecord,
  catalogue: ProductEvidenceCatalogue,
  reviewer: ProductReviewerContext,
  slice?: ProductSlice,
): Result<ProductFeedback | undefined> {
  if (input === undefined) return ok(undefined);
  const parsed = productFeedbackSchema.safeParse(input);
  if (!parsed.success)
    return err(vispError("ARTIFACT_INVALID", `Invalid product feedback: ${parsed.error.message}`));
  const feedback = withUsableCitations(parsed.data, catalogue);
  if (
    new Set(feedback.dimensions.map((entry) => entry.dimension)).size !== feedback.dimensions.length
  )
    return err(vispError("ARTIFACT_INVALID", "Duplicate quality dimension"));
  const resolve = (ids: readonly string[]) =>
    ids.map((id) =>
      catalogue.entries.find((entry) => entry.id === (catalogue.aliases.get(id) ?? id)),
    );
  const references = validateFeedbackReferences(feedback, catalogue, record, slice);
  if (!references.ok) return references;
  const probes = validateProbeResponses(feedback, record, catalogue, reviewer, slice);
  if (!probes.ok) return probes;
  const resolutions = validateResolutions(feedback, record, catalogue, reviewer, slice);
  if (!resolutions.ok) return resolutions;
  for (const finding of feedback.findings) {
    if (finding.outcomes.some((id) => !record.brief.outcomes.some((outcome) => outcome.id === id)))
      return err(vispError("ARTIFACT_INVALID", "Feedback refers to an unknown outcome"));
  }
  const dimensions = feedback.dimensions.map((entry) =>
    normalizeDimension(entry, feedback.phase, record, catalogue, reviewer),
  );
  const findings = feedback.findings.map((entry) => ({
    ...entry,
    evidence: [
      ...new Set(
        resolve(entry.evidence).flatMap((reference) =>
          reference
            ? [
                reference.id,
                ...(reference.historicalFailure && reference.captureRunId
                  ? [`HIST-${reference.captureRunId}`]
                  : []),
              ]
            : [],
        ),
      ),
    ],
  }));

  return ok({
    ...resolutions.value,
    dimensions,
    findings,
    ...(feedback.probes ? { probes: probes.value } : {}),
  });
}

/** Unavailable citations beside usable ones are dropped and recorded as a limitation. */
function withUsableCitations(
  feedback: ProductFeedback,
  catalogue: ProductEvidenceCatalogue,
): ProductFeedback {
  const dropped = new Set<string>();
  const clean = <T extends { readonly evidence: readonly string[]; readonly status?: string }>(
    entry: T,
  ): T => {
    // An unclear or unavailable judgment may rest on unavailable evidence; that is its reason.
    if (unavailableFeedbackAssessment(entry)) return entry;
    const citations = withoutUnavailableCitations(entry.evidence, catalogue);
    if (!citations.dropped.length) return entry;
    for (const id of citations.dropped) dropped.add(id);
    return { ...entry, evidence: citations.kept };
  };
  const cleaned: ProductFeedback = {
    ...feedback,
    dimensions: feedback.dimensions.map(clean),
    findings: feedback.findings.map(clean),
    resolutions: feedback.resolutions.map((resolution) => {
      const entry = clean(resolution);
      return entry.regression?.kind === "checked"
        ? { ...entry, regression: clean(entry.regression) }
        : entry;
    }),
    ...(feedback.probes ? { probes: feedback.probes.map(clean) } : {}),
  };
  if (!dropped.size) return feedback;
  return {
    ...cleaned,
    limitations: [...(feedback.limitations ?? []), droppedCitationNote([...dropped])],
  };
}

/** How a review records citations VISP dropped. */
export function droppedCitationNote(dropped: readonly string[]): string {
  return `VISP dropped citations of evidence it could not deliver: ${dropped.slice(0, 5).join(", ")}${dropped.length > 5 ? ` (+${dropped.length - 5} more)` : ""}`;
}

function validateFeedbackReferences(
  feedback: ProductFeedback,
  catalogue: ProductEvidenceCatalogue,
  record: ProductRecord,
  slice?: ProductSlice,
): Result<void> {
  const historical = new Set(
    exploratoryFailureHistory(record, slice).runs.flatMap(historicalFailureReferences),
  );
  const ambiguous = ambiguousEvidenceIds(catalogue.entries);
  const resolve = (ids: readonly string[]) =>
    ids.map((id) =>
      catalogue.entries.find((entry) => entry.id === (catalogue.aliases.get(id) ?? id)),
    );
  for (const entry of [
    ...feedback.dimensions,
    ...feedback.findings,
    ...feedback.resolutions,
    ...feedback.resolutions.flatMap((resolution) =>
      resolution.regression?.kind === "checked" ? [resolution.regression] : [],
    ),
    ...(feedback.probes ?? []),
  ]) {
    const unavailableAssessment = unavailableFeedbackAssessment(entry);
    for (const [index, reference] of resolve(entry.evidence).entries()) {
      const id = entry.evidence[index];
      if (id && ambiguous.has(catalogue.aliases.get(id) ?? id))
        return err(vispError("EVIDENCE_FAILED", `Ambiguous evidence reference: ${id}`));
      if (
        historicalFindingReference(entry, feedback.phase, reference, historical) ||
        feedbackReferenceUsable(reference, unavailableAssessment)
      )
        continue;
      return err(
        vispError(
          "EVIDENCE_FAILED",
          `Feedback reference ${id} is ${reference?.status ?? "unknown"}`,
          {
            recovery:
              "Read visp review for current evidence IDs. Cite current unavailable records only for unclear/unavailable assessments; refresh stale evidence before judging the product.",
            details: { reference: id, status: reference?.status ?? "unknown" },
          },
        ),
      );
    }
  }
  return ok(undefined);
}

function unavailableFeedbackAssessment(entry: {
  readonly evidence: readonly string[];
  readonly status?: string;
}) {
  return entry.status !== undefined && ["unclear", "unavailable"].includes(entry.status);
}

function historicalFindingReference(
  entry: { readonly evidence: readonly string[]; readonly required?: boolean },
  phase: ProductFeedback["phase"],
  reference: ProductEvidenceCatalogue["entries"][number] | undefined,
  historical: ReadonlySet<string>,
) {
  return (
    phase === "product" &&
    entry.required === true &&
    reference?.status === "stale" &&
    reference.historicalFailure &&
    historical.has(reference.id)
  );
}

function feedbackReferenceUsable(
  reference: ProductEvidenceCatalogue["entries"][number] | undefined,
  unavailableAssessment: boolean,
) {
  return (
    !!reference &&
    (["available", "failed"].includes(reference.status) ||
      (unavailableAssessment && reference.status === "unavailable"))
  );
}

function validateResolutions(
  feedback: ProductFeedback,
  record: ProductRecord,
  catalogue: ProductEvidenceCatalogue,
  reviewer: ProductReviewerContext,
  slice?: ProductSlice,
): Result<ProductFeedback> {
  const pending = outstandingFeedback(record);
  const accepted: ProductFeedback["resolutions"] = [];
  const limitations = [...(feedback.limitations ?? [])];
  for (const resolution of feedback.resolutions) {
    const result = validateResolution(
      resolution,
      pending.find((entry) => entry.id === resolution.id),
      catalogue,
      reviewer,
      record,
      slice,
    );
    if (result.ok) accepted.push(resolution);
    else if (result.error.code === "EVIDENCE_FAILED")
      limitations.push(
        `${resolution.id} remains unresolved: ${result.error.message}. Reviewer explanation: ${resolution.explanation}`,
      );
    else return result;
  }
  return ok({ ...feedback, resolutions: accepted, limitations });
}

function validateResolution(
  resolution: ProductFeedback["resolutions"][number],
  finding: ReturnType<typeof outstandingFeedback>[number] | undefined,
  catalogue: ProductEvidenceCatalogue,
  reviewer: ProductReviewerContext,
  record: ProductRecord,
  slice?: ProductSlice,
): Result<void> {
  if (!finding)
    return err(vispError("ARTIFACT_INVALID", `Unknown unresolved feedback ${resolution.id}`));
  if (slice && finding.task && finding.task !== slice.id)
    return err(
      vispError(
        "EVIDENCE_FAILED",
        `Finding ${finding.id} belongs to ${finding.task}; assess it in its own slice or feature-wide review`,
      ),
    );
  if (!resolutionClosesFinding(resolution)) return ok(undefined);
  return validateClosingResolution(resolution, finding, catalogue, reviewer, record);
}

/** Successful closure retains the existing counterevidence and functional repair guards. */
function validateClosingResolution(
  resolution: ProductFeedback["resolutions"][number],
  finding: ReturnType<typeof outstandingFeedback>[number],
  catalogue: ProductEvidenceCatalogue,
  reviewer: ProductReviewerContext,
  record: ProductRecord,
): Result<void> {
  const resolve = (ids: readonly string[]) =>
    ids.map((id) =>
      catalogue.entries.find((entry) => entry.id === (catalogue.aliases.get(id) ?? id)),
    );
  if (
    resolution.environmentChange &&
    (resolution.disposition === "disproved" ||
      !finding.required ||
      finding.phase !== "product" ||
      finding.dimension !== "functional")
  )
    return err(
      vispError(
        "EVIDENCE_FAILED",
        "Environment-change assessment applies only to a required functional repair, never disproof",
      ),
    );
  const references = resolve(resolution.evidence);
  if (
    finding.outcomes.length &&
    finding.phase !== "understanding" &&
    !["fidelity", "code"].includes(finding.dimension) &&
    finding.outcomes.some(
      (outcome) =>
        !references.some(
          (entry) =>
            entry &&
            (entry.kind === "image" ||
              entry.kind === "operation" ||
              entry.outcomes.includes(outcome)),
        ),
    )
  )
    return err(
      vispError(
        "EVIDENCE_FAILED",
        `${finding.id}: counterevidence does not address the finding's outcomes`,
      ),
    );
  if (references.some((entry) => entry?.status !== "available"))
    return err(
      vispError("EVIDENCE_FAILED", "Resolution requires available successful counterevidence"),
    );
  if (
    reviewer.context === "unavailable" ||
    !references.some(
      (entry) =>
        entry &&
        (finding.dimension === "fidelity" ||
          finding.dimension === "code" ||
          finding.phase === "understanding" ||
          entry.kind !== "source") &&
        !finding.evidence.includes(entry.id),
    )
  )
    return err(
      vispError(
        "EVIDENCE_FAILED",
        `${finding.id}: resolution requires an assessed correction or counterexample with new applicable evidence`,
      ),
    );
  if (finding.required && finding.phase === "product" && finding.dimension === "functional") {
    const ids = references.flatMap((entry) => (entry ? [entry.id] : []));
    const gap = functionalResolutionGap(record, finding, resolution, ids, catalogue, reviewer);
    if (gap) return err(vispError("EVIDENCE_FAILED", gap));
  }
  return ok(undefined);
}

function functionalResolutionGap(
  record: ProductRecord,
  finding: ReturnType<typeof outstandingFeedback>[number],
  resolution: ProductFeedback["resolutions"][number],
  ids: string[],
  catalogue: ProductEvidenceCatalogue,
  reviewer: ProductReviewerContext,
) {
  if (resolution.disposition === "disproved")
    return functionalDisproofEvidenceGap(record, finding, ids);
  const repair = findFunctionalRepair(record, finding, ids, resolution.environmentChange);
  // Workers usually repair before anyone records a failing reproduction. A fresh
  // independent reviewer that re-checked the finding against current passing executions
  // may close it; the human reviewer document labels this weaker kind of closure.
  // A retained historical journey already has a witness and still requires its actual replay.
  if (
    !repair &&
    !historicalFindingJourney(record, finding.evidence) &&
    reviewerVerifiedRepair(finding, ids, catalogue, reviewer)
  )
    return undefined;
  if (!repair)
    return "Functional repair requires a recorded failing reproduction and a later successful rerun of the same input and assertions in a known matching environment. Restore the reproduction environment or record a new comparable failure/rerun pair. For an intentional environment repair, assess environmentChange with the exact observed from/to identities and rationale; verifier identity and adjacent regression requirements still apply. Unrelated fresh evidence, changed assertions or an unknown environment cannot close this finding";
  return functionalRegressionEvidenceGap(record, finding, resolution, repair, catalogue);
}

export function reviewerVerifiedRepair(
  finding: ReturnType<typeof outstandingFeedback>[number],
  ids: readonly string[],
  catalogue: ProductEvidenceCatalogue,
  reviewer: ProductReviewerContext,
): boolean {
  if (reviewer.context !== "fresh") return false;
  const passing = ids
    .map((id) => catalogue.entries.find((entry) => entry.id === (catalogue.aliases.get(id) ?? id)))
    .filter((entry) => entry?.kind === "execution" && entry.status === "available");
  return (
    passing.length > 0 &&
    finding.outcomes.every((outcome) => passing.some((entry) => entry?.outcomes.includes(outcome)))
  );
}

function normalizeDimension(
  entry: ProductFeedback["dimensions"][number],
  phase: ProductFeedback["phase"],
  record: ProductRecord,
  catalogue: ProductEvidenceCatalogue,
  reviewer: ProductReviewerContext,
) {
  const references = entry.evidence.map((id) =>
    catalogue.entries.find((ref) => ref.id === (catalogue.aliases.get(id) ?? id)),
  );
  entry = { ...entry, evidence: references.flatMap((ref) => (ref ? [ref.id] : [])) };
  const applicable =
    ["fidelity", "functional"].includes(entry.dimension) ||
    (entry.dimension === "code" && catalogue.entries.some((ref) => ref.id.startsWith("CODE-"))) ||
    (entry.dimension === "experience" &&
      record.brief.outcomes.some((outcome) => outcome.kind === "experience"));
  const observed =
    references.every((ref) => ref?.status === "available") &&
    dimensionObserved(entry.dimension, phase, references);
  if (reviewer.context === "unavailable" && entry.status !== "failed")
    return {
      ...entry,
      status: "unavailable" as const,
      reason: `${entry.reason}\nReview unavailable: ${reviewer.reason ?? "Host could not review"}`,
    };
  if (
    (entry.status === "not-applicable" && applicable) ||
    (entry.status === "satisfied" && !observed)
  ) {
    return {
      ...entry,
      status: "unclear" as const,
      reason: `${entry.reason}\n${dimensionRecovery(entry, phase, applicable)}`,
    };
  }
  return entry;
}

function dimensionRecovery(
  entry: ProductFeedback["dimensions"][number],
  phase: ProductFeedback["phase"],
  applicable: boolean,
) {
  if (entry.status === "not-applicable")
    return `${entry.dimension} applies to this product; assess it against current evidence instead of marking it not-applicable.`;
  if (entry.dimension !== "experience" || phase !== "product")
    return "Applicable quality dimension lacks the required current evidence.";
  const requirement =
    "Experience marked satisfied needs a current image and interaction or execution evidence.";
  return applicable
    ? requirement
    : `${requirement} If there is no applicable experience goal, use status "not-applicable" with a reason; a reason alone does not change the status.`;
}

function dimensionObserved(
  dimension: ProductFeedback["dimensions"][number]["dimension"],
  phase: ProductFeedback["phase"],
  references: (ProductEvidenceCatalogue["entries"][number] | undefined)[],
) {
  if (phase === "understanding" || dimension === "fidelity") return references.length > 0;
  if (dimension === "code") return references.some((ref) => ref?.id.startsWith("CODE-"));
  if (dimension === "experience")
    return (
      references.some((ref) => ref?.kind === "image") &&
      references.some((ref) => ref?.kind === "operation" || ref?.kind === "execution")
    );
  if (dimension === "functional")
    return references.some((ref) => ref && supportsBehaviorEvidence(ref));
  return references.some((ref) => ref && ref.kind !== "source");
}

function feedbackFocus(failed: boolean, gaps: boolean) {
  if (failed) return "fix";
  return gaps ? "refine" : "implement";
}
