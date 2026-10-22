import { ok, type Result } from "../../core/result.js";
import { cliCommand } from "../next-action.js";
import type { WorkspaceState } from "../state.js";
import {
  applicableExecutions,
  applicableReviews,
  outcomeStatuses,
  productEvidenceGaps,
} from "./assessment.js";
import { pinnedAcceptanceChecks } from "./check/acceptance-checks.js";
import { sliceExecutionCheckIds } from "./corrections.js";
import { environmentNext } from "./environment.js";
import { latestCurrentJourneys } from "./evidence-references.js";
import { productFeedbackGaps } from "./feedback.js";
import { firstDoneAdvice, withFirstDoneAdvice } from "./first-done-advice.js";
import { closedSlice, type ProductSlice } from "./model.js";
import { unavailableReviewerFindingsNext } from "./review/reviewer-findings-route.js";
import { readProductAuthorization } from "./scopes.js";
import type { ProductNext } from "./status.js";
import { failedJourneyNext } from "./status-next-journeys.js";
import {
  currentReviewFailure,
  nextOpenSliceReview,
  type ReviewerState,
  repairRoute,
  requiredFindings,
  reviewAfterSuccessfulRepair,
  reviewerState,
  unreproducedFindings,
} from "./status-next-review.js";
import type { ProductRecord } from "./store.js";
import { type PinnedRoute, pinnedHandoff, pinnedRoute } from "./tester/pinned-disputes.js";

export async function nextOpenSlice(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice,
  subject: string,
): Promise<Result<ProductNext>> {
  const base = { feature: record.brief.feature, task: slice.id };
  const auth = await readProductAuthorization(workspace, record);
  if (!auth.ok) return auth;
  if (auth.value?.task !== slice.id)
    return ok({
      ...base,
      action: "implement",
      objective: slice.goal,
      command: cliCommand("work", { feature: record.brief.feature, task: slice.id }),
      evidence: [],
      mayEdit: false,
    });
  const checks = openSliceChecks(workspace, record, slice, subject);
  const executions = applicableExecutions(record, subject).filter(
    (execution) =>
      checks.has(execution.check) &&
      (execution.task === slice.id || (!execution.task && !slice.checks.includes(execution.check))),
  );
  const failures = [
    ...new Map(executions.map((execution) => [execution.check, execution])).values(),
  ].filter((execution) => execution.status !== "passed");
  const environment = await sliceEnvironmentNext(workspace, record, slice, failures);
  if (environment) return ok(environment);
  const reviewer = await reviewerState(workspace, record, subject, slice);
  if (failures.length)
    return ok(await failedSliceNext(workspace, record, slice, failures, reviewer));
  const journeyNext = failedJourneyNext(record, subject, slice, reviewer);
  if (journeyNext) return journeyNext;
  const statuses = outcomeStatuses(record, subject, slice);
  const reviewGaps = statuses.filter(
    (entry) =>
      entry.priority === "must" &&
      ((entry.requiredReview && entry.review !== "satisfied") || entry.review === "failed"),
  );
  const hasProductFeedback = applicableReviews(record, subject).some(
    (entry) => (!entry.task || entry.task === slice.id) && entry.feedback?.phase === "product",
  );
  // Surface actual findings and unavailable review without requiring category declarations.
  const qualityGaps = hasProductFeedback ? productFeedbackGaps(record, subject, slice) : [];
  const hasObservedProduct =
    executions.length > 0 ||
    hasProductFeedback ||
    latestCurrentJourneys(record, subject, slice.id).length > 0;
  const findings = requiredFindings(record, slice);
  const reassess =
    unavailableReviewerFindingsNext(workspace, record, slice, subject, reviewer.capacity) ??
    reviewAfterSuccessfulRepair(
      record,
      slice,
      subject,
      findings,
      reviewGaps.some((entry) => entry.review === "failed") ||
        currentReviewFailure(record, subject, slice),
      reviewer,
    );
  if (reassess) return ok(reassess);
  if (
    findings.length ||
    (hasObservedProduct && reviewGaps.some((entry) => entry.review === "failed"))
  ) {
    const missingReproduction = unreproducedFindings(
      record,
      findings,
      subject,
      slice,
      reviewer.runs,
    );
    const route = repairRoute(record, slice, missingReproduction.length > 0, reviewer);
    return ok({
      ...base,
      action: "fix",
      objective: route.objective,
      ...("command" in route ? { command: route.command } : {}),
      evidence: [
        ...findings.map((finding) => `${finding.problem}. Next check: ${finding.nextCheck}`),
        ...missingReproduction.map(
          (finding) =>
            `${finding.id}: no intact replay target is available from the retained evidence. Establish a relevant executed failure before repair, or supply fresh executed counterevidence for disproof; the original finding remains unresolved.`,
        ),
        ...qualityGaps,
      ],
      mayEdit: true,
      completion: route.completion,
    });
  }
  const reviewNext = nextOpenSliceReview(
    record,
    subject,
    slice,
    statuses,
    executions.length > 0,
    reviewer,
  );
  if (reviewNext) return ok(reviewNext);
  return ok(
    withFirstDoneAdvice(
      {
        ...base,
        action: "implement",
        objective: slice.goal,
        command: cliCommand("done", { feature: record.brief.feature, task: slice.id }),
        evidence: await productEvidenceGaps(workspace, record, subject, slice),
        mayEdit: true,
      },
      firstDoneAdvice(record, slice, auth.value, subject),
    ),
  );
}

/** A failed check's environment: recover it, or hand a pinned suite that never runs to the human. */
async function sliceEnvironmentNext(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice,
  failures: readonly { check: string; status: string; output: string }[],
): Promise<ProductNext | undefined> {
  const environmentFailures = failures.filter(
    (entry) => entry.status === "environment-failed" || entry.status === "timed-out",
  );
  if (!environmentFailures.length) return undefined;
  const stuck = await stuckPinnedStep(workspace, record, slice.id, failures);
  if (stuck) return stuck;
  return {
    ...environmentNext(
      record.brief.feature,
      slice.id,
      environmentFailures.map((entry) => `${entry.check}: ${entry.output}`),
      "verify",
    ),
    mayEdit: true,
    objective: environmentFailures.some((entry) =>
      /app-unreachable:|browser-disconnected:|check-authoring:|missing-command:|VISP: check timed out/.test(
        entry.output,
      ),
    )
      ? environmentNext(
          record.brief.feature,
          slice.id,
          environmentFailures.map((entry) => entry.output),
          "verify",
        ).objective
      : "Continue the authorized slice while recovering the failed check's execution environment or correcting its command; required checks remain unresolved",
  };
}

/** The last open slice must also pass the pinned tests, whichever slice's scope owns their file. */
function openSliceChecks(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice,
  subject: string,
): Set<string> {
  const checks = sliceExecutionCheckIds(workspace, record, slice, subject);
  const completes = record.brief.slices.every(
    (entry) => entry.id === slice.id || closedSlice(record.state.slices[entry.id]?.status),
  );
  if (completes) for (const pinned of pinnedAcceptanceChecks(record.brief)) checks.add(pinned.id);
  return checks;
}

/** A failing check sends the worker to fix; a settled or handed-off pinned failure does not. */
async function failedSliceNext(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice,
  failures: readonly { check: string; status: string; output: string }[],
  reviewer: ReviewerState,
): Promise<ProductNext> {
  const feature = record.brief.feature;
  const route = await pinnedRoute(
    workspace,
    feature,
    slice.id,
    failures,
    "done",
    record.state.executions,
    reviewer.capacity,
  );
  const evidence = [
    ...route.evidence,
    ...failures.map((entry) => `${entry.check}: ${entry.status}: ${entry.output}`),
  ];
  if (route.override) return pinnedStep(feature, slice.id, route, evidence);
  return {
    feature,
    task: slice.id,
    action: "fix",
    objective:
      route.objective ??
      "Trace the failing handler or state transition, change the hypothesis when repeated, then rerun the affected check",
    command: cliCommand("work", { feature, task: slice.id }),
    evidence,
    mayEdit: true,
  };
}

/**
 * The same pinned suite crashed, timed out or could not run three times across two source
 * states, and nothing else fails: more environment retries cannot help, so it goes to the human
 * reviewer. Any other failing check keeps the environment step.
 */
export async function stuckPinnedStep(
  workspace: WorkspaceState,
  record: ProductRecord,
  task: string | undefined,
  failures: readonly { check: string; status: string; output: string }[],
): Promise<ProductNext | undefined> {
  const override = await pinnedHandoff(
    workspace,
    record.brief.feature,
    failures,
    record.state.executions,
  );
  if (!override) return undefined;
  return pinnedStep(
    record.brief.feature,
    task,
    { evidence: [], override },
    failures.map((entry) => `${entry.check}: ${entry.status}: ${entry.output}`),
  );
}

/** A settled or handed-off pinned failure replaces the fix step. */
export function pinnedStep(
  feature: string,
  task: string | undefined,
  route: PinnedRoute,
  evidence: string[],
): ProductNext {
  return {
    feature,
    ...(task ? { task } : {}),
    ...(route.override as NonNullable<PinnedRoute["override"]>),
    evidence,
    mayEdit: route.override?.action === "implement",
  };
}
