import { ok, type Result } from "../../core/result.js";
import { cliCommand } from "../next-action.js";
import type { WorkspaceState } from "../state.js";
import { applicableReviews, type ProductOutcomeStatus } from "./assessment.js";
import {
  type ReviewerCapacity,
  reviewerCapacity,
  reviewerHandoff,
} from "./critic/critic-capacity.js";
import { latestCurrentJourneys } from "./evidence-references.js";
import { findingAppliesToSlice, outstandingFeedback, productFeedbackGaps } from "./feedback.js";
import { functionalRegressionRequirement } from "./functional-regression.js";
import { findFunctionalRepair } from "./functional-resolution.js";
import { checksFor, type ProductSlice } from "./model.js";
import { productRefinement } from "./refinement.js";
import { repairRecheck } from "./repair-recheck.js";
import { completesFeature } from "./review/review-selection.js";
import type { ProductNext } from "./status.js";
import type { ProductRecord } from "./store.js";
import { reviewerRules } from "./tester/pinned-dispute-model.js";

export function repairRoute(
  record: ProductRecord,
  slice: ProductSlice,
  missingReproduction: boolean,
  reviewer: ReviewerState,
) {
  if (reviewer.runs && !reviewer.capacity.available) {
    const handoff = reviewerHandoff(record.brief.feature, reviewer.capacity, "findings");
    return { objective: handoff.objective, completion: handoff.completion };
  }
  return {
    objective: repairObjective(record, slice, missingReproduction, reviewer.runs),
    command: cliCommand("work", { feature: record.brief.feature, task: slice.id }),
    completion: "unresolved-product" as const,
  };
}

/**
 * Whether VISP launches its own reviewer, so routing never asks the worker to delegate one, and
 * whether that reviewer can still run. A bounded loop needs an end: once its budget is spent or
 * it failed twice on this source, what is open goes to the human reviewer through `visp pr`.
 */
export interface ReviewerState {
  readonly runs: boolean;
  readonly capacity: ReviewerCapacity;
}

export async function reviewerState(
  workspace: WorkspaceState,
  record: ProductRecord,
  subject: string,
  slice?: ProductSlice,
): Promise<ReviewerState> {
  return {
    runs: reviewerRules(workspace),
    capacity: await reviewerCapacity(
      workspace,
      record.brief.feature,
      subject,
      completesFeature(record, slice?.id) ? undefined : slice?.id,
    ),
  };
}

/** A VISP-launched reviewer re-checks open findings itself, so no reproduction is asked for. */
export function unreproducedFindings(
  record: ProductRecord,
  findings: ReturnType<typeof requiredFindings>,
  subject: string,
  slice: ProductSlice,
  reviewerRechecks: boolean,
) {
  if (reviewerRechecks) return [];
  return findings.filter(
    (finding) =>
      finding.phase === "product" &&
      finding.dimension === "functional" &&
      !repairRecheck(record, finding, subject, slice.id),
  );
}

/** Repairs that add rejection are where a normal call most often breaks; the finding names only what to reject. No final period: the stop hook appends its own text. */
const REJECTION_REPAIR =
  "If a fix rejects inputs, first add a test that the request's normal call still succeeds and keep it passing; reject only what the finding names. If a finding would break that call, do not apply it; say so in your done note";

export function repairObjective(
  record: ProductRecord,
  slice: ProductSlice,
  missingReproduction: boolean,
  reviewerRechecks = false,
) {
  if (reviewerRechecks)
    return `Fix each reported problem and extend your slice check to exercise it, then run visp done. VISP starts the reviewer itself and you delegate nothing; the independent reviewer re-checks these findings. ${REJECTION_REPAIR}`;
  if (missingReproduction)
    return "Record a failing reproduction of the reported behavior, or fresh executed counterevidence for separate assessment, before claiming a repair";
  return productRefinement(record, slice).exhausted
    ? "Review budget exhausted; choose a different repair hypothesis. Required outcomes remain unresolved."
    : `Correct the observed product mismatch, then recheck the affected behavior. ${REJECTION_REPAIR}`;
}

export function currentReviewFailure(record: ProductRecord, subject: string, slice: ProductSlice) {
  return applicableReviews(record, subject).some(
    (review) =>
      (!review.task || review.task === slice.id) &&
      (review.feedback?.dimensions.some((entry) => entry.status === "failed") ||
        review.feedback?.probes?.some((entry) => entry.status === "failed")),
  );
}

/**
 * A fresh successful replay is evidence for a new review, never a resolution.
 * Keep the worker on repair until every retained required finding has an exact
 * current recheck and there are no current failures competing with review.
 */
export function reviewAfterSuccessfulRepair(
  record: ProductRecord,
  slice: ProductSlice,
  subject: string,
  findings: ReturnType<typeof outstandingFeedback>,
  currentReviewFailed: boolean,
  reviewer: ReviewerState,
): ProductNext | undefined {
  if (currentReviewFailed) return undefined;
  if (!findings.length || findings.some((finding) => finding.subjectDigest === subject))
    return undefined;
  const rechecks = findings.map((finding) => ({
    finding,
    recheck: repairRecheck(record, finding, subject, slice.id),
  }));
  if (
    rechecks.some(({ finding, recheck }) => {
      if (
        recheck?.status !== "observed-unassessed" ||
        !("comparison" in recheck) ||
        !recheck.comparison
      )
        return true;
      return (
        recheck.comparison.after.subjectDigest !== subject ||
        !["completed", "passed"].includes(recheck.comparison.after.status ?? "") ||
        (finding.dimension === "functional" &&
          findFunctionalRepair(
            record,
            finding,
            [recheck.comparison.after.runId],
            recheck.environmentRepair,
          )?.subjectDigest !== subject)
      );
    })
  )
    return undefined;
  const evidence = rechecks.flatMap(({ finding, recheck }) => [
    recheck?.environmentRepair
      ? `${finding.id}: ${recheck.environmentRepair.guidance} Observed environments: ${recheck.environmentRepair.from} -> ${recheck.environmentRepair.to}`
      : `${finding.id}: fresh exact ${recheck?.kind} recheck completed; the retained finding remains unresolved until current review evidence reassesses it`,
    ...(finding.dimension === "functional"
      ? [`${finding.id}: ${functionalRegressionRequirement}`]
      : []),
  ]);
  const base = { feature: record.brief.feature, task: slice.id, evidence, mayEdit: true };
  if (reviewer.runs)
    return {
      ...base,
      ...(reviewer.capacity.available
        ? {
            action: "refine",
            objective:
              "Run visp done: VISP's independent reviewer reassesses the repaired product from the fresh replay before the retained finding is cleared.",
            command: cliCommand("done", { feature: record.brief.feature, task: slice.id }),
            completion: "unresolved-product",
          }
        : reviewerHandoff(record.brief.feature, reviewer.capacity, "findings")),
    };
  return {
    ...base,
    action: "refine",
    objective: rechecks.some(({ recheck }) => recheck?.environmentRepair)
      ? "Assess the observed environment change and successful recheck before deciding whether it repairs the retained finding"
      : "Reassess the repaired product from the fresh successful replay before clearing the retained finding",
    command: cliCommand("review", { handoff: true, feature: record.brief.feature, task: slice.id }),
    completion: "unresolved-product",
  };
}

export function nextOpenSliceReview(
  record: ProductRecord,
  subject: string,
  slice: ProductSlice,
  statuses: ProductOutcomeStatus[],
  hasExecutions: boolean,
  reviewer: ReviewerState,
): ProductNext | undefined {
  const reviewGaps = statuses.filter(
    (entry) =>
      entry.priority === "must" &&
      ((entry.requiredReview && entry.review !== "satisfied") || entry.review === "failed"),
  );
  const reviewOnlyGaps = mandatoryQualityReviewGaps(record, slice, statuses);
  const hasProductFeedback = applicableReviews(record, subject).some(
    (entry) => (!entry.task || entry.task === slice.id) && entry.feedback?.phase === "product",
  );
  // Surface observed review gaps without requiring category declarations.
  const qualityGaps = hasProductFeedback ? productFeedbackGaps(record, subject, slice) : [];
  const hasObservedProduct =
    hasExecutions ||
    hasProductFeedback ||
    latestCurrentJourneys(record, subject, slice.id).length > 0;
  if (!((reviewGaps.length || qualityGaps.length) && hasObservedProduct) && !reviewOnlyGaps.length)
    return undefined;
  const { exhausted } = productRefinement(record, slice);
  const evidence = [
    ...reviewGaps.map((entry) => `${entry.id}: ${entry.review}`),
    ...reviewOnlyGaps.map(
      (entry) => `${entry.id}: behavior ${entry.behavior}; review ${entry.review}`,
    ),
    ...qualityGaps,
  ];
  if (reviewer.runs) return launchedSliceReview(record, slice, evidence, exhausted, reviewer);
  return {
    feature: record.brief.feature,
    task: slice.id,
    action: exhausted ? "understand" : "refine",
    objective: exhausted
      ? "Refinement budget exhausted; required outcomes remain unresolved. Choose a focused new hypothesis or revise the budget explicitly."
      : reviewOnlyGaps.length
        ? "Obtain source-backed review evidence for each mandatory quality outcome before completing the slice"
        : "Inspect rendered states and the interaction journey; correct the most consequential mismatch",
    command: sliceReviewCommand(record, slice, exhausted),
    evidence,
    mayEdit: !exhausted,
    completion: "unresolved-product",
  };
}

/** VISP starts the reviewer during `visp done`; with no capacity left the assessment goes to `visp pr`. */
function launchedSliceReview(
  record: ProductRecord,
  slice: ProductSlice,
  evidence: string[],
  exhausted: boolean,
  reviewer: ReviewerState,
): ProductNext {
  const base = { feature: record.brief.feature, task: slice.id, evidence, mayEdit: !exhausted };
  if (!reviewer.capacity.available)
    return { ...base, ...reviewerHandoff(record.brief.feature, reviewer.capacity, "assessment") };
  return {
    ...base,
    action: exhausted ? "understand" : "refine",
    objective: exhausted
      ? "Refinement budget exhausted; required outcomes remain unresolved. Choose a focused new hypothesis or revise the budget explicitly."
      : completesFeature(record, slice.id)
        ? "Run visp done: VISP's independent reviewer assesses every feature outcome on the completing slice."
        : "Run visp done: VISP's independent reviewer assesses this slice's outcomes.",
    command: cliCommand("done", { feature: record.brief.feature, task: slice.id }),
    completion: "unresolved-product",
  };
}

function mandatoryQualityReviewGaps(
  record: ProductRecord,
  slice: ProductSlice,
  statuses: ProductOutcomeStatus[],
): ProductOutcomeStatus[] {
  const mappedChecks = checksFor(record.brief, slice);
  return statuses.filter((entry) => {
    const outcome = record.brief.outcomes.find((candidate) => candidate.id === entry.id);
    return (
      entry.priority === "must" &&
      outcome?.kind === "quality" &&
      !mappedChecks.some((check) => check.outcomes.includes(entry.id)) &&
      entry.behavior === "unassessed" &&
      entry.review !== "satisfied"
    );
  });
}

export function requiredFindings(record: ProductRecord, slice: ProductSlice) {
  return outstandingFeedback(record).filter(
    (finding) => finding.required && findingAppliesToSlice(finding, slice),
  );
}

export function exhaustedNext(
  record: ProductRecord,
  slice: ProductSlice,
  evidence: readonly string[],
): Result<ProductNext> {
  return ok({
    feature: record.brief.feature,
    task: slice.id,
    action: "fix",
    objective:
      "Refinement budget exhausted; required outcomes remain unresolved. Choose a focused new hypothesis; the review budget is unchanged.",
    command: cliCommand("work", { feature: record.brief.feature, task: slice.id }),
    evidence,
    mayEdit: false,
  });
}

function hasRequiredSliceFeedback(record: ProductRecord, slice: ProductSlice) {
  return outstandingFeedback(record).some(
    (finding) => finding.required && findingAppliesToSlice(finding, slice),
  );
}

function sliceReviewCommand(record: ProductRecord, slice: ProductSlice, exhausted: boolean) {
  return !exhausted && hasRequiredSliceFeedback(record, slice)
    ? cliCommand("work", { feature: record.brief.feature, task: slice.id })
    : cliCommand("review", { handoff: true, feature: record.brief.feature, task: slice.id });
}
