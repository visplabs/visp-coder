import { vispError } from "../../../core/errors.js";
import { err, ok, type Result } from "../../../core/result.js";
import type { ProductReviewImage } from "../../evidence/product-review.js";
import type { WorkspaceState } from "../../state.js";
import { applicableReviews } from "../assessment.js";
import { reviewChangedPaths, reviewCodeSources } from "../code-context.js";
import {
  currentCoverage,
  type ProductReviewChallenge,
  productReviewChallenges,
} from "../coverage.js";
import { type ProductEvidenceReference, productEvidenceCatalogue } from "../evidence-references.js";
import type { experimentReviewContext } from "../experiments.js";
import type { productFeedbackPlan } from "../feedback.js";
import { productReviewImageGroups } from "../image-groups.js";
import type { DeliveredProductImageGroup } from "../images.js";
import {
  type PRODUCT_REVIEW_POLICY,
  type ProductAssessment,
  type ProductCoverageAssessment,
  type ProductExecution,
  type ProductOutcome,
  type ProductReviewerContext,
  type ProductSlice,
  reviewerContextSchema,
} from "../model.js";
import type { observationSequence } from "../observation-preview.js";
import { rulesForRequest } from "../project-rules.js";
import {
  currentRegressionGate,
  regressionGateLimitation,
} from "../regression/regression-report.js";
import { regressionScopeLimitations } from "../regression-scope-advice.js";
import { picturesWithoutImage, pictureWithoutImageNote } from "../result-images.js";
import { withProductMutation } from "../runtime.js";
import { selectProductSlice } from "../scopes.js";
import type { ProductSource, sourceClaims } from "../sources.js";
import { type ProductRecord, type ProductSelection, readProductRecord } from "../store.js";
import {
  productContractDigest,
  productImplementationDigest,
  productSourceDigest,
  productSourceSnapshot,
} from "../subject.js";
import { readTestsRecord } from "../tester/independent-tests-record.js";
import { assembleReviewBundle } from "./review-bundle.js";
import {
  previousReviewAssessments,
  type productReviewAgenda,
  type reviewInteractionEvidence,
} from "./review-context.js";
import type { DeliveredReviewEvidence } from "./review-delivery-validation.js";
import type { ProductReviewRecurrence } from "./review-recurrence.js";
import {
  inspectSelectedImages,
  type ReviewSelection,
  reviewImageGaps,
  reviewSlice,
  suppliedCaptures,
} from "./review-selection.js";
import { submitReview } from "./review-submission.js";

export interface ProductReviewOptions extends ProductSelection {
  readonly subjectDigest?: string;
  readonly assessments?: unknown;
  readonly captures?: unknown;
  readonly coverage?: unknown;
  readonly reviewer?: unknown;
  readonly groups?: readonly string[];
  readonly feedback?: unknown;
  readonly selection?: unknown;
  readonly experimentResolutions?: unknown;
}
export interface ProductReviewBundle {
  readonly ambiguities?: readonly import("../tester/request-ambiguities.js").RequestAmbiguity[];
  readonly observationSequence?: ReturnType<typeof observationSequence>;
  readonly policyVersion: typeof PRODUCT_REVIEW_POLICY;
  readonly feedbackPlan: ReturnType<typeof productFeedbackPlan>;
  readonly feature: string;
  readonly task?: string;
  readonly subjectDigest: string;
  readonly selection: ReviewSelection;
  readonly originalRequest: string;
  readonly outcomes: readonly ProductOutcome[];
  readonly executions: readonly ProductExecution[];
  readonly controls: readonly unknown[];
  readonly captureRuns: readonly unknown[];
  readonly previousAssessments: readonly {
    subjectDigest: string;
    current: boolean;
    assessments: readonly ProductAssessment[];
  }[];
  readonly assessments: readonly ProductAssessment[];
  readonly images: readonly ProductReviewImage[];
  readonly gaps: readonly string[];
  readonly limitations?: readonly string[];
  readonly agenda: ReturnType<typeof productReviewAgenda>;
  readonly interactionEvidence: ReturnType<typeof reviewInteractionEvidence>;
  readonly experiments: ReturnType<typeof experimentReviewContext>;
  readonly evidence: readonly ProductEvidenceReference[];
  readonly evidenceOmitted: number;
  readonly sources: readonly ProductSource[];
  readonly sourceClaims: ReturnType<typeof sourceClaims>;
  readonly findings: readonly ProductAssessment[];
  readonly refinement: {
    readonly limit: number;
    readonly used: number;
    readonly remaining: number;
    readonly maximumFindings: 3;
    readonly exhausted: boolean;
  };
  readonly reviewerInstructions: string;
  readonly challenges: readonly ProductReviewChallenge[];
  readonly challengesOmitted: number;
  readonly coverageRemaining: number;
  readonly coverage: readonly ProductCoverageAssessment[];
  readonly imageGroups: readonly DeliveredProductImageGroup[];
  readonly imageGroupsOmitted: number;
  readonly reviewer: ProductReviewerContext;
  readonly recurrence: readonly ProductReviewRecurrence[];
}

export function runProductReview(
  workspace: WorkspaceState,
  options: ProductReviewOptions = {},
  deliveredEvidence?: DeliveredReviewEvidence,
): Promise<Result<ProductReviewBundle>> {
  return options.assessments === undefined
    ? review(workspace, options, deliveredEvidence)
    : withProductMutation(workspace, () => review(workspace, options, deliveredEvidence));
}

async function review(
  workspace: WorkspaceState,
  options: ProductReviewOptions,
  deliveredEvidence?: DeliveredReviewEvidence,
): Promise<Result<ProductReviewBundle>> {
  const loaded = await readProductRecord(workspace, options);
  if (!loaded.ok) return loaded;
  let record = loaded.value;
  const selected = selectProductSlice(workspace, record, options);
  if (!selected.ok) return selected;
  const slice = reviewSlice(workspace, record, selected.value, options.task);
  const snapshot = await productSourceSnapshot(workspace, record.brief);
  if (!snapshot.ok) return snapshot;
  const subject = await productSourceDigest(workspace, record.brief, snapshot.value);
  if (!subject.ok) return subject;
  const contractDigest = productContractDigest(record.brief, slice);
  const implementationDigest = productImplementationDigest(workspace, snapshot.value);
  const previous = previousReviewAssessments(record, subject.value, slice);
  const latest = applicableReviews(record, subject.value)
    .filter((entry) => entry.task === slice?.id)
    .at(-1);
  const captures = [...record.state.captures, ...(latest?.captures ?? [])];
  const supplied = suppliedCaptures(options.captures);
  if (!supplied.ok) return supplied;
  captures.push(...supplied.value);
  const imageGroups = productReviewImageGroups(record, subject.value, slice);
  if (options.groups?.some((id) => !imageGroups.some((group) => group.id === id)))
    return err(
      vispError("ARTIFACT_INVALID", "Unknown image group; select a current group from visp review"),
    );
  const inspected = await inspectSelectedImages(
    workspace,
    record,
    options,
    subject.value,
    slice,
    captures,
    imageGroups,
  );
  if (!inspected.ok) return inspected;
  const images = inspected.value;
  let assessments = [
    ...new Map(
      applicableReviews(record, subject.value, slice).flatMap((review) =>
        review.assessments.map((entry) => [entry.outcome, entry] as const),
      ),
    ).values(),
  ].filter((entry) => !slice || slice.outcomes.includes(entry.outcome));
  const previousCurrent = assessments;
  const outcomes = record.brief.outcomes.filter(
    (outcome) => !slice || slice.outcomes.includes(outcome.id),
  );
  const changes = await reviewChangedPaths(workspace, record, snapshot.value, slice);
  if (!changes.ok) return changes;
  const codeSources = await reviewCodeSources(
    workspace,
    record,
    snapshot.value,
    subject.value,
    slice,
    changes.value,
  );
  const catalogue = await productEvidenceCatalogue(
    workspace,
    record,
    subject.value,
    images.images,
    images.availability,
    codeSources,
    slice,
  );
  const gaps = [...reviewImageGaps(outcomes, images.gaps, captures.length > 0)];
  const challenges = productReviewChallenges(record, slice);
  let coverage = currentCoverage(record, subject.value);
  const reviewer = reviewerContextSchema.safeParse({
    ...(reviewerInput(options, latest?.reviewer) as object),
    reviewMode: workspace.config.workflow.reviewMode,
  });
  if (!reviewer.success)
    return err(
      vispError("ARTIFACT_INVALID", `Invalid reviewer context: ${reviewer.error.message}`),
    );
  if (options.assessments !== undefined) {
    const submitted = await submitReview({
      workspace,
      record,
      slice,
      options,
      deliveredEvidence,
      subject: subject.value,
      implementation: implementationDigest,
      contractDigest,
      images: images.images,
      catalogue,
      challenges,
      coverage,
      previous: previousCurrent,
      reviewer: reviewer.data,
    });
    if (!submitted.ok) return submitted;
    record = submitted.value.record;
    coverage = submitted.value.coverage;
    assessments = [
      ...new Map(
        [...previousCurrent, ...submitted.value.assessments].map((entry) => [entry.outcome, entry]),
      ).values(),
    ];
  }
  const rules = await rulesForRequest(workspace, record.brief.feature);
  const tests = await readTestsRecord(workspace, record.brief.feature);
  if (!tests.ok) return tests;
  const limitations = await reviewLimitations(
    workspace,
    record,
    slice,
    snapshot.value,
    subject.value,
  );
  return ok({
    ...limitations,
    ...assembleReviewBundle({
      workspace,
      rules,
      record,
      slice,
      subject: subject.value,
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
      reviewer: reviewer.data,
    }),
    ...(tests.value?.ambiguities?.length ? { ambiguities: tests.value.ambiguities } : {}),
  });
}

/**
 * Regression-scope advice, the regression gate's executed results for this version, and each
 * picture the product made that has no image here.
 */
async function reviewLimitations(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice | undefined,
  snapshot: Record<string, string>,
  subject: string,
): Promise<{ limitations?: readonly string[] }> {
  const regression = await regressionScopeLimitations(workspace, record, slice, snapshot);
  const gate = await currentRegressionGate(workspace, record.brief.feature, subject);
  const pictures = await picturesWithoutImage(workspace, record, snapshot, subject);
  const limitations = [
    ...(regression.limitations ?? []),
    ...(gate ? [regressionGateLimitation(gate)] : []),
    ...pictures.map(pictureWithoutImageNote),
  ];
  return limitations.length ? { limitations } : {};
}

function reviewerInput(options: ProductReviewOptions, previous?: ProductReviewerContext) {
  return (
    options.reviewer ??
    (options.assessments === undefined ? previous : undefined) ?? { context: "unspecified" }
  );
}
