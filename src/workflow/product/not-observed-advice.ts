import type { ProductNext } from "./status.js";
import type { ProductRecord } from "./store.js";
import { unobservedGoalRounds } from "./unobserved-goals.js";

const ADVICE_PREFIX = "VISP's tester never observed: ";

/** Informational coverage gaps advise the worker without changing product gates. */
export function withNotObservedAdvice(
  next: ProductNext,
  record: ProductRecord,
  subject: string,
): ProductNext {
  if (
    record.state.status !== "active" ||
    next.evidence.some((line) => line.startsWith(ADVICE_PREFIX))
  )
    return next;
  const execution = record.state.executions.findLast(
    (entry) => entry.check.startsWith("PINNED_") && entry.subjectDigest === subject,
  );
  const names = [
    ...new Set(
      (execution?.output ?? "").split(/\r?\n/).flatMap((line) => {
        // Names may contain colons, so the whole payload (name and any detail) is shown.
        const match = /^\s*NOT OBSERVED:\s*(.*)$/i.exec(line);
        const payload = match?.[1]?.trim().slice(0, 120);
        return payload ? [payload] : [];
      }),
    ),
  ];
  if (!names.length) return next;
  const listed = names.slice(0, 4);
  if (names.length > 4) listed.push(`and ${names.length - 4} more`);
  const { goals, spent } = unobservedGoalRounds(record, subject);
  const advice = [
    `${ADVICE_PREFIX}${listed.join(", ")}.`,
    ...(spent.length < goals.length
      ? [
          "If one is a goal the request defines (such as winning a level), it is unmet even when one precise input sequence reaches it: change the product so that a coarse search over the request's stated inputs reaches it. It gets one repair round.",
        ]
      : []),
    ...(spent.length
      ? [
          `Already had its one repair round: ${spent.join(", ")}. VISP lists these as unverified in visp pr; do not keep changing the product for them.`,
        ]
      : []),
  ].join(" ");
  const firstDone = next.evidence[0]?.startsWith("No visp done yet after ") ? 1 : 0;
  return {
    ...next,
    evidence: [...next.evidence.slice(0, firstDone), advice, ...next.evidence.slice(firstDone)],
  };
}
