import { cliCommand } from "../../next-action.js";
import {
  applicableExecutions,
  applicableReviews,
  type ProductOutcomeStatus,
} from "../assessment.js";
import { pinnedAcceptanceChecks } from "../check/acceptance-checks.js";
import { outstandingFeedback } from "../findings.js";
import { latestExecutionsByOwner, type ProductCheck, type ProductExecution } from "../model.js";
import { notObservedNames } from "../not-observed-advice.js";
import type { RegressionGateReport } from "../regression/regression-report.js";
import type { ProductNext } from "../status.js";
import type { ProductRecord } from "../store.js";
import type { IndependentTestsRecord } from "../tester/independent-tests-model.js";
import { checkEvidence } from "./record-checks.js";
import { regressionGaps, regressionsFrom } from "./record-regressions.js";
import type {
  CheckEvidence,
  EvidenceChanges,
  EvidenceCost,
  EvidenceGap,
  EvidenceOutsideAccess,
  EvidenceRecord,
  RequirementEvidence,
} from "./record-types.js";

export interface EvidenceInputs {
  readonly record: ProductRecord;
  readonly subject: string;
  readonly outcomes: readonly ProductOutcomeStatus[];
  readonly next: ProductNext;
  readonly tests?: IndependentTestsRecord;
  readonly gate: {
    readonly mode: "off" | "advise" | "gate";
    readonly report?: RegressionGateReport;
  };
  readonly changes: EvidenceChanges;
  /** VISP-launched reviewer calls and tester sessions, from their activity logs. */
  readonly activity: { readonly reviewerLaunched: number; readonly testerSessions: number };
  readonly outsideAccess: EvidenceOutsideAccess;
  readonly readAt: string;
}

/** The record from what VISP recorded; it reads nothing and decides nothing itself. */
export function buildEvidenceRecord(inputs: EvidenceInputs): EvidenceRecord {
  const { record, subject } = inputs;
  const current = latestExecutionsByOwner(applicableExecutions(record, subject));
  const evidenceFor = (check: ProductCheck, author: CheckEvidence["author"]) =>
    checkEvidence(
      check,
      {
        current: current.filter((run) => run.check === check.id),
        all: record.state.executions,
      },
      { author, record: recordCommand(record, check, author) },
    );
  const done = inputs.outcomes.map((outcome) => requirementEvidence(inputs, outcome, evidenceFor));
  const suites = [
    ...record.brief.checks
      .filter((check) => !check.outcomes.length)
      .map((check) => evidenceFor(check, "worker")),
    ...pinnedAcceptanceChecks(record.brief).map((check) =>
      evidenceFor(check, "independent-tester"),
    ),
  ];
  const regressions = regressionsFrom(inputs.gate, subject);
  const notVerified = ordered([
    ...done.flatMap((entry) => requirementGaps(entry, inputs.outcomes)),
    ...suites.flatMap(suiteGap),
    ...[...done.flatMap((entry) => entry.checks), ...suites].flatMap(vacuousGap),
    ...regressionGaps(regressions),
    ...findingGaps(record),
    ...testerGaps(inputs.tests, current),
    ...reviewGaps(record),
    ...inputs.changes.scope.outside.map(
      (path): EvidenceGap => ({
        kind: "out-of-scope",
        severity: "attention",
        ref: path,
        text: `${path} changed, and no slice's scope allows it`,
      }),
    ),
  ]);
  const count = (status: RequirementEvidence["status"]) =>
    done.filter((entry) => entry.status === status).length;
  return {
    version: 1,
    feature: record.brief.feature,
    lifecycle: record.state.status,
    subjectDigest: subject,
    summary: {
      requirements: done.length,
      verified: count("verified"),
      judged: count("judged"),
      failed: count("failed"),
      unverified: count("unverified"),
      gaps: notVerified.length,
    },
    notVerified,
    asked: {
      request: record.brief.originalRequest,
      requirements: record.brief.outcomes.map((outcome) => ({
        id: outcome.id,
        statement: outcome.statement,
        priority: outcome.priority,
        kind: outcome.kind,
        provenance: outcome.provenance,
      })),
      intentChanges: record.state.revisions
        .filter(
          (revision) => revision.kind === "intent" || revision.provenance !== "agent-proposed",
        )
        .map((revision) => ({
          at: revision.createdAt,
          provenance: revision.provenance,
          reason: revision.reason,
        })),
    },
    done,
    suites,
    changed: inputs.changes,
    regressions,
    cost: cost(inputs),
    outsideAccess: inputs.outsideAccess,
    next: {
      objective: inputs.next.objective,
      ...(inputs.next.command ? { command: inputs.next.command } : {}),
    },
    readAt: inputs.readAt,
  };
}

/** Pinned tests run with every check; a slice check runs with its slice. */
function recordCommand(record: ProductRecord, check: ProductCheck, author: string): string {
  const feature = record.brief.feature;
  const task =
    author === "worker"
      ? record.brief.slices.find((slice) => slice.checks.includes(check.id))?.id
      : undefined;
  return cliCommand("verify", task ? { feature, task } : { feature });
}

function requirementEvidence(
  inputs: EvidenceInputs,
  outcome: ProductOutcomeStatus,
  evidenceFor: (check: ProductCheck, author: CheckEvidence["author"]) => CheckEvidence,
): RequirementEvidence {
  const checks = inputs.record.brief.checks
    .filter((check) => check.outcomes.includes(outcome.id))
    .map((check) => evidenceFor(check, "worker"));
  const reviewer = applicableReviews(inputs.record, inputs.subject).findLast((review) =>
    review.assessments.some((assessment) => assessment.outcome === outcome.id),
  )?.reviewer?.model;
  return {
    requirement: outcome.id,
    status: outcome.satisfied
      ? outcome.behavior === "passed"
        ? "verified"
        : "judged"
      : outcome.behavior === "failed" || outcome.review === "failed"
        ? "failed"
        : "unverified",
    checks,
    review: {
      status: outcome.review,
      source: "model-judgment",
      ...(reviewer && outcome.review !== "unassessed" ? { reviewer } : {}),
      required: outcome.requiredReview,
    },
  };
}

function requirementGaps(
  entry: RequirementEvidence,
  outcomes: readonly ProductOutcomeStatus[],
): EvidenceGap[] {
  const outcome = outcomes.find((candidate) => candidate.id === entry.requirement);
  const priority = outcome?.priority ?? "must";
  if (entry.status === "verified") return [];
  if (entry.status === "judged")
    return [
      {
        kind: "review",
        severity: "attention",
        ref: entry.requirement,
        text: `${entry.requirement} rests on a reviewer's judgment (${entry.review.reviewer ?? "unattributed"}, a model); no executed check shows it`,
      },
    ];
  return [
    {
      kind: "requirement",
      severity: priority === "must" || entry.status === "failed" ? "blocking" : "attention",
      ref: entry.requirement,
      text: `${entry.requirement} (${priority}) ${entry.status}: ${requirementReasons(entry).join("; ")}`,
    },
  ];
}

function requirementReasons(entry: RequirementEvidence): string[] {
  const reasons = entry.checks.map((check) => `${check.check} ${resultPhrase(check)}`);
  if (!entry.checks.length) reasons.push("no check is declared");
  else if (entry.checks.every((check) => !check.exercisesBehavior))
    reasons.push("its checks only inspect source");
  if (entry.review.status === "failed") reasons.push("the reviewer judged it failed");
  else if (entry.review.required && entry.review.status !== "satisfied")
    reasons.push(`review required, ${entry.review.status}`);
  return reasons;
}

function resultPhrase(check: CheckEvidence): string {
  if (check.result === "stale") return "ran only on an earlier version";
  if (check.result === "not-run") return "has not run";
  return check.exitCode === undefined ? check.result : `${check.result} (exit ${check.exitCode})`;
}

function suiteGap(check: CheckEvidence): EvidenceGap[] {
  if (check.result === "passed") return [];
  const what = check.author === "independent-tester" ? "The independent tests" : "Check";
  return [
    {
      kind: "check",
      severity: ["stale", "not-run"].includes(check.result) ? "attention" : "blocking",
      ref: check.check,
      text: `${what} ${check.check} ${resultPhrase(check)}`,
    },
  ];
}

function vacuousGap(check: CheckEvidence): EvidenceGap[] {
  return check.result === "passed" && check.failsWithoutChange === false
    ? [
        {
          kind: "check",
          severity: "attention",
          ref: check.check,
          text: `${check.check} also passes with the feature's change reverted, so it does not show the change`,
        },
      ]
    : [];
}

function findingGaps(record: ProductRecord): EvidenceGap[] {
  return outstandingFeedback(record).map((finding) => ({
    kind: "finding",
    severity: finding.required ? "blocking" : "attention",
    ref: finding.id,
    text: `${finding.required ? "Required" : "Optional"} reviewer finding (${finding.dimension}): ${finding.problem}`,
  }));
}

function testerGaps(
  tests: IndependentTestsRecord | undefined,
  current: readonly ProductExecution[],
): EvidenceGap[] {
  if (!tests) return [];
  const gaps: EvidenceGap[] = [];
  if (tests.status !== "pinned")
    gaps.push({
      kind: "independent-tests",
      severity: "attention",
      text: `The independent tester's tests were not pinned (${tests.status})${tests.reason ? `: ${tests.reason}` : ""}`,
    });
  for (const dispute of tests.disputes ?? []) {
    if (dispute.status === "upheld")
      gaps.push({
        kind: "dispute",
        severity: "attention",
        ref: dispute.test,
        text: `Test "${dispute.test}" is waived: the worker disputed it and the reviewer upheld the dispute`,
      });
    else if (dispute.status === "open")
      gaps.push({
        kind: "dispute",
        severity: "blocking",
        ref: dispute.test,
        text: `Test "${dispute.test}" fails and its dispute awaits a ruling${dispute.reviews >= 2 ? " from a human reviewer" : ""}`,
      });
  }
  const pinned = current.findLast((run) => run.check.startsWith("PINNED_"));
  for (const name of notObservedNames(pinned?.output ?? ""))
    gaps.push({
      kind: "not-observed",
      severity: "attention",
      ref: name,
      text: `NOT OBSERVED: ${name}. The independent tests never saw it happen; this is neither a pass nor a failure`,
    });
  return gaps;
}

function reviewGaps(record: ProductRecord): EvidenceGap[] {
  return record.state.reviews.some((review) => review.reviewer?.model)
    ? []
    : [
        {
          kind: "review",
          severity: "attention",
          text: "No independent review is recorded",
        },
      ];
}

const RANK: Record<EvidenceGap["severity"], number> = { blocking: 0, attention: 1 };

function ordered(gaps: EvidenceGap[]): EvidenceGap[] {
  return gaps.toSorted((a, b) => RANK[a.severity] - RANK[b.severity]);
}

function cost(inputs: EvidenceInputs): EvidenceCost {
  const { state } = inputs.record;
  const reviewers = state.reviews.flatMap((review) =>
    review.reviewer?.model ? [review.reviewer.model] : [],
  );
  return {
    startedAt: state.createdAt,
    lastRecordAt: state.updatedAt,
    elapsedMs: Math.max(0, Date.parse(state.updatedAt) - Date.parse(state.createdAt)),
    checkRuns: state.executions.length,
    checkTimeMs: state.executions.reduce(
      (sum, run) => sum + run.durationMs + (run.flipDurationMs ?? 0),
      0,
    ),
    ...(inputs.gate.report ? { regressionGateMs: inputs.gate.report.durationMs } : {}),
    modelCalls: {
      reviewerLaunched: inputs.activity.reviewerLaunched,
      reviewsRecorded: reviewers.length,
      testerSessions: inputs.activity.testerSessions,
      worker: null,
    },
    models: [...new Set([...reviewers, ...(inputs.tests?.model ? [inputs.tests.model] : [])])],
  };
}
