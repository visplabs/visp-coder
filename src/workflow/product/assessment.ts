import { sha256 } from "../../core/hash.js";
import { productJourneyGaps } from "../evidence/product-journey.js";
import type { ProductReviewCapture } from "../evidence/product-review.js";
import { cliCommand } from "../next-action.js";
import type { WorkspaceState } from "../state.js";
import { testSourcesFor, verifyAccounts } from "./account-verification.js";
import { captureRunEntries } from "./capture-run-model.js";
import { isBrowserCheckCommand, productCheckSupportsBehavior } from "./check/check-command.js";
import { currentCoverage, productReviewChallenges } from "./coverage.js";
import {
  currentJourneyFailures,
  evidenceApplies,
  evidenceSupportGaps,
  productEvidenceCatalogue,
} from "./evidence-references.js";
import { productFeedbackGaps } from "./feedback.js";
import { inspectProductImages } from "./images.js";
import {
  checksFor,
  hasWebUiScope,
  latestExecutionsByOwner,
  PRODUCT_REVIEW_POLICY,
  type ProductAssessment,
  type ProductExecution,
  type ProductOutcome,
  type ProductSlice,
} from "./model.js";
import { currentProbeResponses, validateProbeResponses } from "./probe-feedback.js";
import {
  accountedRequirements,
  readRequirementAccounts,
  requirementGaps,
  requirementSummary,
} from "./requirements.js";
import { deferredOutcomeReview } from "./review/review-cadence.js";
import { completesFeature } from "./review/review-selection.js";
import type { ProductRecord } from "./store.js";
import { productContractDigest } from "./subject.js";

export interface ProductOutcomeStatus {
  readonly id: string;
  readonly statement: string;
  readonly priority: ProductOutcome["priority"];
  readonly behavior: "passed" | "failed" | "unassessed";
  readonly review: ProductAssessment["status"] | "unassessed";
  readonly requiredReview: boolean;
  readonly satisfied: boolean;
}
export function applicableExecutions(
  record: ProductRecord,
  subject: string,
  selectedSlice?: ProductSlice,
): ProductExecution[] {
  return record.state.executions.filter((execution) => {
    const slice = execution.task
      ? record.brief.slices.find((entry) => entry.id === execution.task)
      : undefined;
    return (
      (!execution.task || slice !== undefined) &&
      (!selectedSlice || !execution.task || execution.task === selectedSlice.id) &&
      execution.subjectDigest === subject &&
      execution.contractDigest === productContractDigest(record.brief, slice)
    );
  });
}

export function applicableReviews(
  record: ProductRecord,
  subject: string,
  selectedSlice?: ProductSlice,
) {
  return record.state.reviews.filter((review) => {
    const slice = review.task
      ? record.brief.slices.find((entry) => entry.id === review.task)
      : undefined;
    return (
      (!review.task || slice !== undefined) &&
      (!selectedSlice || !review.task || review.task === selectedSlice.id) &&
      review.subjectDigest === subject &&
      review.contractDigest === productContractDigest(record.brief, slice)
    );
  });
}

/** Preserve historical run payloads, but only credit journeys applicable to this outcome. */
export function applicableProductCaptureRuns(
  record: ProductRecord,
  subject: string,
  outcome: string,
): unknown[] {
  return captureRunEntries(record)
    .filter(
      ({ run }) =>
        evidenceApplies(record, subject, run) &&
        (!run.task ||
          record.brief.slices.find((slice) => slice.id === run.task)?.outcomes.includes(outcome) ===
            true),
    )
    .map(({ stored }) => stored);
}

/**
 * Images that current passing checks declaring images wrote for this outcome. A static
 * picture (a Python render, an SVG) has no browser journey; reviewers marked such an outcome
 * satisfied from the check's image and VISP stored it unavailable, so acceptance could never
 * pass. When no browser-journey check covers the outcome and no slice that owns it (any
 * slice, for an outcome none owns) builds a web UI, a linked image from this set stands in for the before/input/after journey. A web
 * game observes play through captured journeys, so one still frame of it never does: the set
 * is empty then.
 */
export function checkImageCaptures(
  record: ProductRecord,
  subject: string,
  outcome: string,
): ReadonlySet<string> {
  const checks = record.brief.checks.filter((check) => check.outcomes.includes(outcome));
  const owners = record.brief.slices.filter((slice) => slice.outcomes.includes(outcome));
  // An outcome no slice owns is judged on the whole feature.
  const scope = owners.length ? owners : record.brief.slices;
  if (checks.some((check) => isBrowserCheckCommand(check.command)) || hasWebUiScope(scope))
    return new Set();
  const imaged = new Set(checks.filter((check) => check.images?.length).map((check) => check.id));
  return new Set(
    applicableExecutions(record, subject).flatMap((execution) =>
      execution.status === "passed" && imaged.has(execution.check)
        ? (execution.checkImages ?? [])
        : [],
    ),
  );
}

/** A must experience outcome needs an observed journey, or the picture its image check wrote. */
export function experienceObservationGaps(options: {
  readonly subjectDigest: string;
  readonly captureRuns: readonly unknown[];
  readonly checkImages: ReadonlySet<string>;
  readonly images: readonly ProductReviewCapture[];
  readonly linkedEvidence: readonly string[];
}): string[] {
  const linkedCheckImage = options.images.some(
    (image) =>
      options.checkImages.has(image.id) &&
      image.subjectDigest === options.subjectDigest &&
      (options.linkedEvidence.includes(image.id) || options.linkedEvidence.includes(image.path)),
  );
  return linkedCheckImage ? [] : productJourneyGaps(options);
}

export function outcomeStatuses(
  record: ProductRecord,
  subject: string,
  slice?: ProductSlice,
): ProductOutcomeStatus[] {
  const latest = currentCheckExecutions(record, subject, slice);
  const reviews = applicableReviews(record, subject, slice);
  return record.brief.outcomes
    .filter((outcome) => !slice || slice.outcomes.includes(outcome.id))
    .map((outcome) => {
      const checks = checksFor(record.brief, slice).filter((check) =>
        check.outcomes.includes(outcome.id),
      );
      const evidenceChecks = outcomeEvidenceChecks(outcome, checks);
      const executions = evidenceChecks.flatMap((check) => latest.get(check.id) ?? []);
      const assessment = reviews
        .flatMap((review) => review.assessments)
        .findLast((entry) => entry.outcome === outcome.id);
      const behavior = executions.some((entry) => entry?.status === "failed")
        ? "failed"
        : evidenceChecks.length > 0 &&
            evidenceChecks.every((check) => {
              const runs = latest.get(check.id);
              return runs?.every((entry) => entry.status === "passed") === true;
            })
          ? "passed"
          : "unassessed";
      const review = assessment?.expectations.some((entry) => entry.status === "failed")
        ? "failed"
        : (assessment?.status ?? "unassessed");
      const requiredReview = outcome.reviewRequired || outcome.kind === "experience";
      return {
        id: outcome.id,
        statement: outcome.statement,
        priority: outcome.priority,
        behavior,
        review,
        requiredReview,
        satisfied:
          (behavior === "passed" ||
            (checks.length === 0 && outcome.kind !== "functional" && review === "satisfied")) &&
          (!requiredReview || review === "satisfied") &&
          review !== "failed",
      };
    });
}

function outcomeEvidenceChecks(outcome: ProductOutcome, checks: ReturnType<typeof checksFor>) {
  return outcome.kind === "functional" ? checks.filter(productCheckSupportsBehavior) : checks;
}

export async function productEvidenceGaps(
  workspace: WorkspaceState,
  record: ProductRecord,
  subject: string,
  slice?: ProductSlice,
): Promise<string[]> {
  const gaps: string[] = [];
  if (record.brief.incomplete) gaps.push("The migrated brief is incomplete");
  const outcomes = outcomeStatuses(record, subject, slice);
  if (!outcomes.length) gaps.push("No observable outcomes are assigned");
  const deferred = deferredOutcomeReview(workspace, record, slice);
  gaps.push(
    ...outcomes
      .filter(
        (outcome) => !(deferred && outcome.behavior === "passed" && outcome.review !== "failed"),
      )
      .flatMap((outcome) => outcomeGaps(record, slice, outcome)),
  );
  const current = currentCheckExecutions(record, subject, slice);
  for (const check of checksFor(record.brief, slice)) {
    const executions = current.get(check.id) ?? [];
    const unresolved =
      executions.find((entry) => entry.status === "failed") ??
      executions.find((entry) => entry.status !== "passed");
    if (unresolved || executions.length === 0)
      gaps.push(`${check.id}: ${unresolved?.status ?? "not executed for current product"}`);
  }
  for (const file of record.brief.acceptanceBaseline.flatMap((check) => check.files)) {
    const content = await workspace.files.readBytesIfExists(file.path);
    if (!content.ok || content.value === undefined || sha256(content.value) !== file.sha256)
      gaps.push(`Pinned expectation changed or is unavailable: ${file.path}`);
  }
  gaps.push(...currentJourneyFailures(record, subject, slice?.id));
  gaps.push(...(await requirementEvidenceGaps(workspace, record, subject, slice)));
  gaps.push(...(await currentAssessmentEvidenceGaps(workspace, record, subject, slice)));
  gaps.push(...(await productImageEvidenceGaps(workspace, record, subject, slice)));
  return [...new Set(gaps)];
}

/** Listed requirements count where the feature closes: its completing slice, and acceptance. */
async function requirementAccounts(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice | undefined,
) {
  if (record.state.status !== "active" || (slice && !completesFeature(record, slice.id)))
    return undefined;
  const listed = accountedRequirements(record.brief.originalRequest);
  if (!listed.length) return undefined;
  const stored = await readRequirementAccounts(workspace, record.brief.feature, listed);
  return { listed, accounts: stored.ok ? stored.value.accounts : [] };
}

/** A cited check counts when its latest run on this version passed; acceptance reruns every check. */
function passedChecks(record: ProductRecord, subject: string, slice?: ProductSlice): Set<string> {
  return new Set(
    latestExecutionsByOwner(applicableExecutions(record, subject, slice))
      .filter((execution) => execution.status === "passed")
      .map((execution) => execution.check),
  );
}

async function requirementEvidenceGaps(
  workspace: WorkspaceState,
  record: ProductRecord,
  subject: string,
  slice: ProductSlice | undefined,
): Promise<string[]> {
  const accounted = await requirementAccounts(workspace, record, slice);
  return accounted
    ? requirementGaps(
        accounted.listed,
        accounted.accounts,
        passedChecks(record, subject, slice),
        accountCommand(record, slice),
      )
    : [];
}

/** The `done` command of the slice that completes the feature, with a check it runs to cite. */
function accountCommand(record: ProductRecord, slice: ProductSlice | undefined) {
  const owner = slice ?? record.brief.slices.at(-1);
  return {
    done: cliCommand("done", { feature: record.brief.feature, task: owner?.id }),
    check: owner?.checks[0] ?? "<check id>",
  };
}

/**
 * Where each listed requirement stands, for the reply of the call that closes the feature. Named
 * tests are read only in runs on `subject`, the version the call checked.
 */
export async function requirementStatus(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice | undefined,
  subject: string,
): Promise<string[]> {
  const accounted = await requirementAccounts(workspace, record, slice);
  return accounted
    ? requirementSummary(
        accounted.listed,
        accounted.accounts,
        verifyAccounts(
          accounted.accounts,
          applicableExecutions(record, subject, slice),
          await testSourcesFor(workspace, accounted.accounts),
        ),
      )
    : [];
}

function currentCheckExecutions(
  record: ProductRecord,
  subject: string,
  slice?: ProductSlice,
): Map<string, ProductExecution[]> {
  const byCheck = new Map<string, ProductExecution[]>();
  for (const execution of latestExecutionsByOwner(applicableExecutions(record, subject, slice))) {
    const entries = byCheck.get(execution.check) ?? [];
    entries.push(execution);
    byCheck.set(execution.check, entries);
  }
  return byCheck;
}

function outcomeGaps(
  record: ProductRecord,
  slice: ProductSlice | undefined,
  outcome: ProductOutcomeStatus,
): string[] {
  const gaps =
    outcome.priority === "must" && !outcome.satisfied
      ? [`${outcome.id}: behavior ${outcome.behavior}; review ${outcome.review}`]
      : [];
  const behaviorGap =
    outcome.priority === "must" && !outcome.satisfied
      ? functionalCheckGap(record, slice, outcome.id)
      : undefined;
  return behaviorGap ? [...gaps, behaviorGap] : gaps;
}

function functionalCheckGap(
  record: ProductRecord,
  slice: ProductSlice | undefined,
  outcomeId: string,
) {
  const outcome = record.brief.outcomes.find((entry) => entry.id === outcomeId);
  if (outcome?.kind !== "functional") return undefined;
  const checks = checksFor(record.brief, slice).filter((check) =>
    check.outcomes.includes(outcomeId),
  );
  if (!checks.length)
    return `${outcomeId}: no mapped behavior check; declare a command in brief.checks, link its outcome and slice.checks, then run visp work${slice ? ` --task ${slice.id}` : ""} before visp done. Ad hoc external tests do not create VISP evidence`;
  return checks.length > 0 && !checks.some(productCheckSupportsBehavior)
    ? `${outcomeId}: no behavior-capable check; syntax or static checks cannot establish functional behavior`
    : undefined;
}

export async function productImageEvidenceGaps(
  workspace: WorkspaceState,
  record: ProductRecord,
  subject: string,
  slice?: ProductSlice,
): Promise<string[]> {
  const gaps: string[] = [];
  const latest = new Map(
    applicableReviews(record, subject, slice).flatMap((review) =>
      review.assessments.map((assessment) => [assessment.outcome, { review, assessment }] as const),
    ),
  );
  for (const outcome of record.brief.outcomes) {
    const currentReview = latest.get(outcome.id);
    if (
      outcome.priority !== "must" ||
      outcome.kind !== "experience" ||
      currentReview?.assessment.status !== "satisfied" ||
      (slice && !slice.outcomes.includes(outcome.id))
    )
      continue;
    const images = await inspectProductImages(workspace, subject, currentReview.review.captures);
    gaps.push(
      ...experienceObservationGaps({
        subjectDigest: subject,
        captureRuns: applicableProductCaptureRuns(record, subject, outcome.id),
        checkImages: checkImageCaptures(record, subject, outcome.id),
        images: images.images,
        linkedEvidence: currentReview.assessment.evidence,
      }).map((gap) => `${outcome.id}: ${gap}`),
    );
    if (
      !images.images.some(
        (image) =>
          currentReview.assessment.evidence.includes(image.id) ||
          currentReview.assessment.evidence.includes(image.path),
      )
    )
      gaps.push(
        `${outcome.id}: the latest satisfied visual assessment has no intact linked current image`,
      );
  }
  return gaps;
}

/** Final acceptance is a judgment about the goal, separate from a successful process. */
export function finalProductAssessmentGaps(
  record: ProductRecord,
  subject: string,
  slice?: ProductSlice,
  /** VISP launches the reviewer, so a missing assessment is not the worker's to write. */
  launched = false,
): string[] {
  // A lean feature with no reviewer (D13's default or `critic.mode: off`) is accepted on its
  // checks: nobody would assess it. In batch B2 the reviewer-off arm asked for that assessment,
  // and workers looped on accept and next.
  if (record.state.criticAcceptOnChecks) return productFeedbackGaps(record, subject, slice);
  const latest = new Map(
    applicableReviews(record, subject)
      .filter(
        (review) =>
          review.policyVersion === PRODUCT_REVIEW_POLICY &&
          (!slice || !review.task || review.task === slice.id),
      )
      .flatMap((review) =>
        review.assessments.map((assessment) => [assessment.outcome, assessment] as const),
      ),
  );
  return [
    ...record.brief.outcomes
      .filter(
        (outcome) => outcome.priority === "must" && (!slice || slice.outcomes.includes(outcome.id)),
      )
      .flatMap((outcome) => finalOutcomeAssessmentGaps(outcome, latest.get(outcome.id), launched)),
    ...productFeedbackGaps(record, subject, slice),
  ];
}

function finalOutcomeAssessmentGaps(
  outcome: ProductOutcome,
  assessment: ProductAssessment | undefined,
  launched: boolean,
): string[] {
  const gaps =
    assessment?.status === "satisfied"
      ? []
      : [
          outcome.id +
            ": final goal assessment " +
            (assessment?.status ?? "unassessed") +
            (assessment
              ? `: ${assessment.summary}`
              : launched
                ? "; VISP's reviewer has not assessed it yet: run visp next"
                : "; review the current product against the original request"),
        ];
  for (const expectation of outcome.expectations) {
    const assessed = assessment?.expectations.find((entry) => entry.id === expectation.id);
    if (assessed?.status === "satisfied") continue;
    gaps.push(
      outcome.id +
        "." +
        expectation.id +
        ": " +
        "mandatory expectation (reported source: " +
        expectation.provenance +
        ") " +
        (assessed?.status ?? "unassessed") +
        ": " +
        (assessed?.reason ?? expectation.statement),
    );
  }
  return gaps;
}

/** Recheck stored references at completion; submission-time validation alone cannot cover later failures. */
async function currentAssessmentEvidenceGaps(
  workspace: WorkspaceState,
  record: ProductRecord,
  subject: string,
  slice?: ProductSlice,
): Promise<string[]> {
  const latest = new Map(
    applicableReviews(record, subject, slice).flatMap((review) =>
      review.assessments.map((assessment) => [assessment.outcome, { review, assessment }] as const),
    ),
  );
  const gaps: string[] = [];
  for (const outcome of record.brief.outcomes) {
    const current = latest.get(outcome.id);
    if (
      !current ||
      (current?.review.policyVersion ?? 0) < 2 ||
      outcome.priority !== "must" ||
      (slice && !slice.outcomes.includes(outcome.id))
    )
      continue;
    const { review, assessment } = current;
    if (assessment.status !== "satisfied") continue;
    const refs = [
      ...assessment.evidence,
      ...assessment.expectations.flatMap((entry) => entry.evidence ?? []),
    ];
    const images = await inspectProductImages(workspace, subject, review.captures, refs);
    const catalogue = await productEvidenceCatalogue(
      workspace,
      record,
      subject,
      images.images,
      images.availability,
      undefined,
      slice,
    );
    gaps.push(
      ...evidenceSupportGaps(refs, catalogue, outcome.id, outcome.kind === "functional").map(
        (gap) => `${outcome.id}: ${gap}`,
      ),
    );
    for (const expectation of assessment.expectations)
      if (expectation.status === "satisfied")
        gaps.push(
          ...evidenceSupportGaps(
            expectation.evidence ?? assessment.evidence,
            catalogue,
            outcome.id,
            outcome.kind === "functional",
          ).map((gap) => `${outcome.id}.${expectation.id}: ${gap}`),
        );
  }
  gaps.push(...(await currentProbeEvidenceGaps(workspace, record, subject, slice)));
  gaps.push(...(await currentCoverageEvidenceGaps(workspace, record, subject, slice)));
  gaps.push(...(await resolvedExperimentEvidenceGaps(workspace, record, subject, slice)));
  return gaps;
}

async function currentCoverageEvidenceGaps(
  workspace: WorkspaceState,
  record: ProductRecord,
  subject: string,
  slice?: ProductSlice,
) {
  const gaps: string[] = [];
  const challenges = productReviewChallenges(record, slice);
  const required = new Set(challenges.filter((entry) => entry.required).map((entry) => entry.id));
  const functionalOutcomes = new Set(
    record.brief.outcomes
      .filter((outcome) => outcome.kind === "functional")
      .map((outcome) => outcome.id),
  );
  for (const assessed of currentCoverage(record, subject)) {
    if (!required.has(assessed.id)) continue;
    if (assessed.status !== "satisfied") continue;
    const owner = record.state.reviews.findLast((review) =>
      review.coverage?.some((entry) => entry.id === assessed.id && entry === assessed),
    );
    if (!owner) continue;
    const images = await inspectProductImages(
      workspace,
      subject,
      owner.captures,
      assessed.evidence,
    );
    const catalogue = await productEvidenceCatalogue(
      workspace,
      record,
      subject,
      images.images,
      images.availability,
      undefined,
      slice,
    );
    gaps.push(
      ...evidenceSupportGaps(
        assessed.evidence,
        catalogue,
        undefined,
        challenges
          .find((challenge) => challenge.id === assessed.id)
          ?.outcomes.some((outcome) => functionalOutcomes.has(outcome)) === true,
      ).map((gap) => `${assessed.id}: ${gap}`),
    );
  }
  return gaps;
}

async function resolvedExperimentEvidenceGaps(
  workspace: WorkspaceState,
  record: ProductRecord,
  subject: string,
  slice?: ProductSlice,
): Promise<string[]> {
  const gaps: string[] = [];
  for (const review of applicableReviews(record, subject, slice)) {
    const resolutions = (review.experimentResolutions ?? []).filter(
      (entry) => !slice || slice.outcomes.includes(entry.outcome),
    );
    if (!resolutions.length) continue;
    const refs = resolutions.flatMap((entry) => entry.evidence);
    const images = await inspectProductImages(workspace, subject, review.captures, refs);
    const catalogue = await productEvidenceCatalogue(
      workspace,
      record,
      subject,
      images.images,
      images.availability,
      undefined,
      slice,
    );
    for (const resolution of resolutions)
      gaps.push(
        ...evidenceSupportGaps(resolution.evidence, catalogue, resolution.outcome).map(
          (gap) => `Experiment ${resolution.runId}: ${gap}`,
        ),
      );
  }
  return gaps;
}

async function currentProbeEvidenceGaps(
  workspace: WorkspaceState,
  record: ProductRecord,
  subject: string,
  slice?: ProductSlice,
) {
  const responses = [...currentProbeResponses(record, subject, slice).values()];
  if (!responses.length) return [];
  const captures = applicableReviews(record, subject, slice).flatMap((review) => review.captures);
  const refs = responses.flatMap((response) => response.evidence);
  const images = await inspectProductImages(workspace, subject, captures, refs);
  const catalogue = await productEvidenceCatalogue(
    workspace,
    record,
    subject,
    images.images,
    images.availability,
    undefined,
    slice,
  );
  const gaps = responses
    .filter((response) => ["satisfied", "not-applicable"].includes(response.status))
    .flatMap((response) =>
      (response.status === "not-applicable"
        ? response.evidence
            .filter(
              (id) =>
                catalogue.entries.find((entry) => entry.id === (catalogue.aliases.get(id) ?? id))
                  ?.status !== "available",
            )
            .map((id) => `${id}: evidence unavailable`)
        : evidenceSupportGaps(response.evidence, catalogue)
      ).map((gap) => `${response.kind}: ${gap}`),
    );
  const normalized = validateProbeResponses(
    { phase: "product", dimensions: [], findings: [], resolutions: [], probes: responses },
    record,
    catalogue,
    { context: "current" },
    slice,
  );
  if (!normalized.ok) return [...gaps, normalized.error.message];
  return [
    ...gaps,
    ...normalized.value
      .filter((response, index) => response.status !== responses[index]?.status)
      .map((response) => `${response.kind}: ${response.observed}`),
  ];
}
