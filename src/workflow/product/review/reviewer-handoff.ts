import { vispError } from "../../../core/errors.js";
import { err, ok } from "../../../core/result.js";
import { reviewInputTemplate } from "../../product-inputs.js";
import type { WorkspaceState } from "../../state.js";
import { type ProductFeedback, QUALITY_DIMENSIONS } from "../feedback-model.js";
import { reviewerContextSchema } from "../model.js";
import { independentSources } from "./independent-sources.js";
import { type ProductReviewBundle, type ProductReviewOptions, runProductReview } from "./review.js";
import { REQUEST_PROMISES_GUIDANCE } from "./review-context.js";
import { deliveredSourceEvidence, reviewPacketBudgetGap } from "./review-source-delivery.js";

const findingExample: ProductFeedback["findings"][number] = {
  dimension: "functional",
  problem: "Describe an observed defect or unresolved evidence gap",
  nextCheck: "Describe the concrete exercise needed to verify a correction",
  outcomes: [],
  required: true,
  evidence: [],
};

/** The host owns reviewer dispatch and model selection; preparing a handoff never starts a model. */
export async function runProductReviewerHandoff(
  workspace: WorkspaceState,
  options: ProductReviewOptions = {},
) {
  const candidates = await reviewerHandoffCandidates(workspace, options);
  if (!candidates.ok) return candidates;
  const sources = await independentSources(workspace, candidates.value.sources, false, true);
  if (!sources.ok) return sources;
  const handoff = {
    ...candidates.value,
    sources: sources.value,
    evidence: deliveredSourceEvidence(
      candidates.value.evidence,
      candidates.value.sources,
      sources.value,
    ),
  };
  const gap = reviewPacketBudgetGap(handoff);
  return gap ? err(vispError("STAGE_BLOCKED", gap)) : ok(handoff);
}

/** Internal candidates stay intact until the caller selects its product/design packet contract. */
export async function reviewerHandoffCandidates(
  workspace: WorkspaceState,
  options: ProductReviewOptions = {},
) {
  const reviewed = await runProductReview(workspace, {
    feature: options.feature,
    task: options.task,
    groups: options.groups,
  });
  return reviewed.ok ? ok(productReviewerHandoff(reviewed.value)) : reviewed;
}

export function productReviewerHandoff(bundle: ProductReviewBundle) {
  return {
    ...productReviewerContext(bundle),
    submissionGuidance: `Return the completed submission to the implementing host. Use reviewer.context exactly as one of ${JSON.stringify(reviewerContextSchema.shape.context.options)}; put explanations in reviewer.reason. feedback.findings accepts at most three objects shaped like ${JSON.stringify(findingExample)}. Use real outcome/evidence IDs and a dimension from ${JSON.stringify(QUALITY_DIMENSIONS)}. Findings use problem/nextCheck/outcomes/required; assessments use outcome/status/summary. Do not copy the example as a finding.`,
    submission: reviewInputTemplate(bundle),
  };
}

/** Evidence delivery is shared; the caller chooses the matching submission contract. */
export function productReviewerContext(bundle: ProductReviewBundle) {
  return {
    kind: "product-review-request" as const,
    feature: bundle.feature,
    task: bundle.task,
    subjectDigest: bundle.subjectDigest,
    dispatch: {
      owner: "host" as const,
      context: "fresh-preferred" as const,
      model: "Use the host's configured model; do not silently choose a stronger model.",
      fallback:
        'If a fresh context is unavailable, use reviewer.context: "current". If images or review itself are unavailable, preserve that gap.',
      provenance: "Reviewer context is agent-reported, not authenticated independence.",
    },
    originalRequest: bundle.originalRequest,
    ...(bundle.ambiguities?.length ? { ambiguities: bundle.ambiguities } : {}),
    feedbackPlan: bundle.feedbackPlan,
    sources: bundle.sources,
    outcomes: bundle.outcomes,
    agenda: bundle.agenda,
    interactionEvidence: bundle.interactionEvidence,
    experiments: bundle.experiments,
    challenges: bundle.challenges,
    challengesOmitted: bundle.challengesOmitted,
    evidence: bundle.evidence,
    evidenceOmitted: bundle.evidenceOmitted,
    images: bundle.images,
    imageGroups: bundle.imageGroups,
    imageGroupsOmitted: bundle.imageGroupsOmitted,
    ...(bundle.limitations?.length ? { limitations: bundle.limitations } : {}),
    gaps: bundle.gaps,
    recurrence: bundle.recurrence,
    previousFindings: bundle.previousAssessments.flatMap((review) =>
      review.assessments
        .filter((assessment) => assessment.status !== "satisfied")
        .map((assessment) => ({
          ...assessment,
          subjectDigest: review.subjectDigest,
          current: review.current,
        })),
    ),
    instructions: bundle.reviewerInstructions,
  };
}

/** First-pass reviewer input contains facts and user intent, not the actor's assessment. */
export function independentReviewerContext(bundle: ReturnType<typeof productReviewerContext>) {
  return {
    kind: bundle.kind,
    feature: bundle.feature,
    task: bundle.task,
    subjectDigest: bundle.subjectDigest,
    originalRequest: bundle.originalRequest,
    ...(bundle.ambiguities?.length ? { ambiguities: bundle.ambiguities } : {}),
    instructions: bundle.instructions,
    outcomes: bundle.outcomes,
    examples: bundle.agenda.examples,
    examplesOmitted: bundle.agenda.omitted.examples,
    ...(bundle.agenda.requestPromises?.length
      ? {
          requestPromises: bundle.agenda.requestPromises,
          requestPromisesNote: REQUEST_PROMISES_GUIDANCE,
        }
      : {}),
    images: bundle.images,
    sources: bundle.sources.filter((source) => source.kind !== "authored-brief"),
    experiments: {
      ...bundle.experiments,
      guidance:
        "These are recorded runner failures and worker-reported retirement reasons, not passing evidence or reviewer judgments. Assess the failure against the original request. Cite the supplied historical negative evidence only in a required product finding to require repair/replay of its original journey; retirement does not override such a finding. Historical references cannot establish current quality or resolve a prior finding. Omitted records remain accessible at originalRecords.",
    },
    interactionEvidence: {
      ...bundle.interactionEvidence,
      guidance:
        "Recorded operations show what was exercised; assess their actual results independently.",
    },
    evidence: bundle.evidence.filter((entry) => !entry.id.startsWith("BRIEF-")),
    ...(bundle.limitations?.length ? { limitations: bundle.limitations } : {}),
    gaps: independentReviewGaps(bundle.gaps),
    ...repairQuestions(bundle),
  };
}

/** Historical image identities do not help assess the current product; current gaps still do. */
export function independentReviewGaps(gaps: readonly string[]) {
  let historicalImages = 0;
  const current = gaps.filter((gap) => {
    if (/^CAP-[^:]+: capture describes a different product version$/.test(gap)) {
      historicalImages += 1;
      return false;
    }
    return !gap.startsWith("Refinement budget exhausted");
  });
  if (historicalImages)
    current.push(
      `${historicalImages} historical capture(s) describe a different product version and are excluded from current review. Individual records remain in visp review.`,
    );
  return current;
}

/** Follow-up questions retain failures without replaying approval history or the actor's diagnosis. */
function repairQuestions(bundle: ReturnType<typeof productReviewerContext>) {
  const pending = bundle.feedbackPlan.findings.filter(
    (finding) => finding.required && finding.phase === "product",
  );
  if (!pending.length) return {};
  return {
    repairQuestions: pending.map(
      ({ id, problem, outcomes, nextCheck, recheck, reproductions }) => ({
        id,
        problem,
        outcomes,
        nextCheck,
        ...(reproductions.length ? { reproductions } : {}),
        ...(recheck ? { recheck } : {}),
      }),
    ),
    repairGuidance:
      "Assess the current product independently. Then check these unresolved reports against current evidence. For attached reproductions, assess the caller-reported relationship using the actual failure and tested subject; the original subject was not necessarily executed; a report can itself be mistaken. Resolve only a specifically checked correction or counterexample, citing fresh evidence. A generally positive assessment does not resolve a particular failure.",
  };
}
