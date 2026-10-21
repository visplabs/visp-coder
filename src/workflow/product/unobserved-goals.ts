import type { ProductExecution } from "./model.js";
import type { ProductRecord } from "./store.js";

/**
 * Goals the pinned suite reports NOT OBSERVED, keyed without a trailing count
 * (`level 3 can be won: 150 attempts` is `level 3 can be won`), so reruns with other counts match.
 * Names may contain colons; only a final `: <number> <word>...` is dropped.
 */
export function notObservedGoals(output: string): string[] {
  return [
    ...new Set(
      output.split(/\r?\n/).flatMap((line) => {
        const payload = /^\s*NOT OBSERVED:\s*(.*)$/i.exec(line)?.[1]?.trim();
        return payload ? [payload.replace(/:\s*\d+\s+[a-z][\w ]*$/i, "").slice(0, 120)] : [];
      }),
    ),
  ];
}

type RoundRecord = { state: Pick<ProductRecord["state"], "executions" | "reviews"> };

function latestPinned(
  record: RoundRecord,
  subject: string,
  before?: string,
): ProductExecution | undefined {
  return record.state.executions
    .filter(
      (execution) =>
        execution.check.startsWith("PINNED_") &&
        execution.subjectDigest === subject &&
        (before === undefined || execution.createdAt <= before),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
}

/**
 * Each unobserved stated goal gets one repair round. A goal's round is spent when a review saw it
 * NOT OBSERVED on an earlier version and the pinned suite still reports it after the product
 * changed; VISP then stops asking for repairs and reports it as unverified.
 */
export function unobservedGoalRounds(
  record: RoundRecord,
  subject: string,
): { goals: string[]; spent: string[] } {
  const current = latestPinned(record, subject);
  const goals = current ? notObservedGoals(current.output) : [];
  if (!current || !goals.length) return { goals, spent: [] };
  const seen = new Set(
    record.state.reviews
      .filter(
        (review) =>
          review.subjectDigest !== subject &&
          review.createdAt < current.createdAt &&
          review.reviewer?.context !== "unavailable",
      )
      .flatMap((review) => {
        const run = latestPinned(record, review.subjectDigest, review.createdAt);
        return run ? notObservedGoals(run.output) : [];
      }),
  );
  return { goals, spent: goals.filter((goal) => seen.has(goal)) };
}
