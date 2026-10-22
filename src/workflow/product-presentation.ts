import { cliCommand } from "./next-action.js";
import type { ProductReviewBundle } from "./product/review/review.js";

/** A mutation acknowledges new judgments without replaying images and the execution journal. */
export function productReviewReceipt(bundle: ProductReviewBundle) {
  const unresolved = bundle.outcomes
    .filter((outcome) => outcome.priority === "must")
    .flatMap((outcome) => {
      const assessment = bundle.assessments.find((entry) => entry.outcome === outcome.id);
      return assessment?.status === "satisfied"
        ? []
        : [
            {
              id: outcome.id,
              status: assessment?.status ?? "unassessed",
              reason: (assessment?.summary ?? outcome.statement).slice(0, 1200),
            },
          ];
    });
  const coverage = new Map(bundle.coverage.map((entry) => [entry.id, entry]));
  const exampleGaps = bundle.challenges
    .filter((entry) => entry.required && coverage.get(entry.id)?.status !== "satisfied")
    .map((entry) => ({
      id: entry.id,
      status: coverage.get(entry.id)?.status ?? "unassessed",
      reason: (coverage.get(entry.id)?.reason ?? entry.expected).slice(0, 1200),
    }));
  return {
    recorded: true,
    policyVersion: bundle.policyVersion,
    feedback: {
      focus: bundle.feedbackPlan.focus,
      findings: bundle.feedbackPlan.findings,
      remaining: bundle.feedbackPlan.findingsRemaining,
      gaps: bundle.feedbackPlan.gaps,
    },
    feature: bundle.feature,
    task: bundle.task,
    subjectDigest: bundle.subjectDigest,
    assessments: bundle.assessments.map(({ outcome, status, summary }) => ({
      outcome,
      status,
      summary: summary.slice(0, 1200),
    })),
    coverage: bundle.coverage.map(({ id, status }) => ({ id, status })),
    unresolved: [...unresolved, ...exampleGaps],
    challengesOmitted: bundle.challengesOmitted,
    coverageRemaining: bundle.coverageRemaining,
    imageGroupsOmitted: bundle.imageGroupsOmitted,
    findings: bundle.findings.map(({ outcome, status, summary }) => ({
      outcome,
      status,
      summary: summary.slice(0, 1200),
    })),
    refinement: bundle.refinement,
    reviewer: bundle.reviewer,
    recurrence: bundle.recurrence,
    journeyFailures: bundle.experiments.failures,
    evidenceGaps: bundle.gaps,
    nextCommand:
      bundle.feedbackPlan.focus === "fix" &&
      bundle.feedbackPlan.findings.some((finding) => finding.required)
        ? bundle.feedbackPlan.trace.command
        : unresolved.length ||
            bundle.coverageRemaining ||
            bundle.gaps.length ||
            bundle.feedbackPlan.gaps.length
          ? cliCommand("review", { feature: bundle.feature })
          : "visp next",
    detailCommand: cliCommand("review", { feature: bundle.feature }),
  };
}

/** Presentation shared by CLI and MCP; neither adapter makes workflow decisions. */
export function compactProductStatus(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { state: _state, brief: _brief, ...summary } = value as Record<string, unknown>;
  return summary;
}

export function productWithoutImageBytes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(productWithoutImageBytes);
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(object)
      .filter(
        ([key]) =>
          !(
            key === "data" &&
            typeof object.mimeType === "string" &&
            object.mimeType.startsWith("image/")
          ),
      )
      .map(([key, child]) => [key, productWithoutImageBytes(child)]),
  );
}

export function renderProductResult(value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "report" in value &&
    typeof value.report === "string"
  )
    return value.report;
  if (
    typeof value === "object" &&
    value !== null &&
    "markdown" in value &&
    typeof value.markdown === "string"
  )
    return value.markdown;
  return JSON.stringify(productWithoutImageBytes(value), null, 2);
}

/** Execution completed successfully can still report an observed product failure. */
export function productResultFailed(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return (
    ("passed" in value && value.passed === false) ||
    ("closed" in value && value.closed === false) ||
    ("detected" in value && value.detected === false) ||
    ("status" in value && ["failed", "timed-out", "cancelled"].includes(String(value.status)))
  );
}

export function productNextCommand(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  // `visp feature --check` replies with the feature and the work that started its slice.
  if ("work" in value && value.work) return productNextCommand(value.work);
  if ("command" in value && typeof value.command === "string") return value.command;
  if ("nextCommand" in value && typeof value.nextCommand === "string") return value.nextCommand;
  if (
    "next" in value &&
    value.next &&
    typeof value.next === "object" &&
    "command" in value.next &&
    typeof value.next.command === "string"
  )
    return value.next.command;
  return undefined;
}

/** Engine image helpers already check freshness, dimensions, hashes and delivery bounds. */
export function productImages(value: unknown): { type: "image"; mimeType: string; data: string }[] {
  const images: { type: "image"; mimeType: string; data: string }[] = [];
  let remaining = 8 * 1024 * 1024;
  function visit(current: unknown): void {
    if (!current || typeof current !== "object" || images.length >= 6) return;
    if (Array.isArray(current)) {
      for (const child of current) visit(child);
      return;
    }
    const object = current as Record<string, unknown>;
    if (isImagePayload(object)) {
      const size = Buffer.byteLength(object.data, "base64");
      if (size <= remaining) {
        images.push({ type: "image", mimeType: object.mimeType, data: object.data });
        remaining -= size;
      }
      return;
    }
    for (const child of Object.values(object)) visit(child);
  }
  visit(value);
  return images;
}

function isImagePayload(
  object: Record<string, unknown>,
): object is Record<string, unknown> & { mimeType: string; data: string } {
  return (
    typeof object.mimeType === "string" &&
    object.mimeType.startsWith("image/") &&
    typeof object.data === "string"
  );
}
