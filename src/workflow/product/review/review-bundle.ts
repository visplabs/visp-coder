import type { WorkspaceState } from "../../state.js";
import { applicableExecutions } from "../assessment.js";
import { captureRunEntries } from "../capture-run-model.js";
import { type ProductReviewChallenge, selectReviewChallenges } from "../coverage.js";
import { needsBrowser } from "../environment.js";
import {
  currentJourneyFailures,
  evidenceApplies,
  type ProductEvidenceCatalogue,
  type ProductEvidenceReference,
} from "../evidence-references.js";
import { experimentReviewContext } from "../experiments.js";
import { productFeedbackPlan } from "../feedback.js";
import { newestRunPerJourney } from "../image-groups.js";
import type { inspectProductImages } from "../images.js";
import {
  latestExecutionsByOwner,
  PRODUCT_REVIEW_POLICY,
  type ProductAssessment,
  type ProductCoverageAssessment,
  type ProductOutcome,
  type ProductReviewerContext,
  type ProductSlice,
} from "../model.js";
import { observationSequence } from "../observation-preview.js";
import { withRules } from "../project-rules.js";
import { hasRequiredFindings, productRefinement } from "../refinement.js";
import { reproductionContextDigest } from "../reproduction-bindings.js";
import type { ProductRecord } from "../store.js";
import type { ProductReviewBundle } from "./review.js";
import { productReviewAgenda, reviewInteractionEvidence } from "./review-context.js";
import {
  productReviewInstructions,
  REVIEW_DIFF_INSTRUCTIONS,
  REVIEW_FLIP_INSTRUCTIONS,
} from "./review-instructions.js";
import { productReviewRecurrence } from "./review-recurrence.js";

interface ReviewBundleInput {
  workspace: WorkspaceState;
  /** Current project rules, appended to the request the reviewer judges against. */
  rules?: string;
  record: ProductRecord;
  slice: ProductSlice | undefined;
  subject: string;
  contractDigest: string;
  implementationDigest: string;
  previous: ProductReviewBundle["previousAssessments"];
  outcomes: ProductOutcome[];
  assessments: ProductAssessment[];
  images: Awaited<ReturnType<typeof inspectProductImages>>;
  catalogue: ProductEvidenceCatalogue;
  gaps: string[];
  challenges: ProductReviewChallenge[];
  coverage: ProductCoverageAssessment[];
  reviewer: ProductReviewerContext;
}

/** Assemble bounded delivery from prepared evidence and the post-submission record. */
export function assembleReviewBundle(input: ReviewBundleInput): ProductReviewBundle {
  const {
    workspace,
    record,
    slice,
    subject,
    contractDigest,
    implementationDigest,
    previous,
    outcomes,
    assessments,
    images,
    catalogue,
    gaps,
    challenges,
    coverage,
    reviewer,
  } = input;
  const refinement = productRefinement(record, slice);
  gaps.push(...currentJourneyFailures(record, subject, slice?.id));
  const selectedChallenges = selectReviewChallenges(challenges, coverage);
  const deliveredEvidence = reviewEvidence(catalogue, assessments, outcomes);
  if (refinement.exhausted && hasRequiredFindings(assessments, outcomes))
    gaps.push("Refinement budget exhausted; unresolved required outcomes remain incomplete");
  return {
    policyVersion: PRODUCT_REVIEW_POLICY,
    ...(workspace.config.workflow.reviewMode === "observation-preview"
      ? { observationSequence: observationSequence(record, subject, slice) }
      : {}),
    feedbackPlan: productFeedbackPlan(record, subject, slice, workspace.config.workflow.reviewMode),
    feature: record.brief.feature,
    ...(slice ? { task: slice.id } : {}),
    subjectDigest: subject,
    selection: {
      version: 1,
      feature: record.brief.feature,
      task: slice?.id,
      subjectDigest: subject,
      contractDigest,
      reproductionDigest: reproductionContextDigest(record),
      images: images.images.map(({ id, sha256 }) => ({ id, sha256 })),
    },
    originalRequest: withRules(record.brief.originalRequest, input.rules ?? ""),
    outcomes,
    executions: latestExecutionsByOwner(applicableExecutions(record, subject, slice)).slice(-12),
    controls: record.state.controls
      .filter(
        (control) =>
          control &&
          typeof control === "object" &&
          "id" in control &&
          deliveredEvidence.entries.some(
            (entry) => entry.kind === "control" && entry.id === control.id,
          ),
      )
      .slice(-12),
    captureRuns: newestRunPerJourney(
      captureRunEntries(record)
        .filter(
          ({ run }) =>
            evidenceApplies(record, subject, run) &&
            (!slice ||
              !run.task ||
              record.brief.slices
                .find((entry) => entry.id === run.task)
                ?.outcomes.some((id) => slice.outcomes.includes(id))),
        )
        .map(({ stored }) => stored),
      3,
    ),
    previousAssessments: previous,
    assessments,
    images: images.images,
    gaps,
    agenda: productReviewAgenda(record, slice),
    interactionEvidence: reviewInteractionEvidence(record, subject, slice),
    experiments: experimentReviewContext(record, subject, slice),
    evidence: deliveredEvidence.entries,
    evidenceOmitted: deliveredEvidence.omitted,
    sources: catalogue.sources,
    sourceClaims: catalogue.sourceClaims.filter((claim) =>
      outcomes.some((outcome) => outcome.id === claim.outcome),
    ),
    findings: reviewFindings(assessments, outcomes),
    refinement,
    challenges: selectedChallenges.selected,
    challengesOmitted: selectedChallenges.omitted,
    coverageRemaining: challenges.filter(
      (challenge) =>
        challenge.required &&
        !coverage.some((entry) => entry.id === challenge.id && entry.status === "satisfied"),
    ).length,
    coverage: coverage.filter((entry) => challenges.some((challenge) => challenge.id === entry.id)),
    imageGroups: images.groups,
    imageGroupsOmitted: images.groupsOmitted,
    reviewer: reviewer,
    recurrence: productReviewRecurrence(record, implementationDigest, slice),
    reviewerInstructions:
      reviewInstructions(workspace, record, slice, images.images.length) +
      (catalogue.sources.some((source) => source.kind === "implementation-diff")
        ? `\n${REVIEW_DIFF_INSTRUCTIONS}`
        : "") +
      (hasDeliveredFlip(record, catalogue) ? `\n${REVIEW_FLIP_INSTRUCTIONS}` : ""),
  };
}

function reviewInstructions(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice | undefined,
  imageCount: number,
) {
  return productReviewInstructions({
    visual: imageCount > 0 || needsBrowser(record.brief, slice),
    observationFirst: workspace.config.workflow.reviewMode === "observation-preview",
    requestGaps: workspace.config.workflow.requestGaps === "required",
  });
}

function reviewFindings(
  assessments: readonly ProductAssessment[],
  outcomes: readonly ProductOutcome[],
) {
  const required = new Set(
    outcomes.filter((outcome) => outcome.priority === "must").map((outcome) => outcome.id),
  );
  const failed = (entry: ProductAssessment) =>
    entry.status === "failed" ||
    entry.expectations.some((expectation) => expectation.status === "failed");
  const rank = (entry: ProductAssessment) =>
    required.has(entry.outcome) ? (failed(entry) ? 0 : 1) : 2;
  return assessments
    .filter(
      (entry) => failed(entry) || (required.has(entry.outcome) && entry.status !== "satisfied"),
    )
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 3);
}

export function reviewEvidence(
  catalogue: ProductEvidenceCatalogue,
  assessments: readonly ProductAssessment[],
  outcomes: readonly ProductOutcome[],
) {
  const linked = new Set(
    assessments.flatMap((assessment) => [
      ...assessment.evidence,
      ...assessment.expectations.flatMap((entry) => entry.evidence ?? []),
    ]),
  );
  const latest = new Set(catalogue.aliases.values());
  const entries = catalogue.entries.filter(
    (entry) =>
      linked.has(entry.id) ||
      entry.historicalFailure ||
      (entry.status !== "stale" &&
        (entry.kind !== "execution" || latest.has(catalogue.aliases.get(entry.id) ?? entry.id)) &&
        (!entry.outcomes.length ||
          entry.outcomes.some((id) => outcomes.some((outcome) => outcome.id === id)))),
  );
  const rank = (entry: ProductEvidenceReference) =>
    linked.has(entry.id) || entry.historicalFailure ? 0 : entry.kind === "operation" ? 2 : 1;
  entries.sort((a, b) => rank(a) - rank(b));
  return { entries: entries.slice(0, 60), omitted: Math.max(0, entries.length - 60) };
}

function hasDeliveredFlip(record: ProductRecord, catalogue: ProductEvidenceCatalogue) {
  const ids = new Set(
    catalogue.sources
      .filter((source) => source.kind === "executed-check")
      .map((source) => source.id),
  );
  return record.state.executions.some((entry) => entry.flip && ids.has(`CHECK-${entry.id}`));
}
