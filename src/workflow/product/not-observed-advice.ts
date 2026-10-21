import type { ProductNext } from "./status.js";
import type { ProductRecord } from "./store.js";

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
  const advice = `${ADVICE_PREFIX}${listed.join(", ")}. If one is a goal the request defines (such as winning a level), make sure it can be reached through the request's interfaces; if it cannot, change the product.`;
  const firstDone = next.evidence[0]?.startsWith("No visp done yet after ") ? 1 : 0;
  return {
    ...next,
    evidence: [...next.evidence.slice(0, firstDone), advice, ...next.evidence.slice(firstDone)],
  };
}
