const FAILURE_RECORD =
  /^\s*(?:(?:FAIL|ERROR):|not ok \d+\b|[✗✘×]\s)|\.\.\. (?:FAIL|ERROR)\b|\bFAILED\s*$/;
const GAP_RECORD = /^\s*NOT OBSERVED:/i;

/** Preserve named reporter outcomes that a bounded log tail would otherwise hide. */
export function earlierAssertionResults(
  text: string,
  tailBudget: number,
  limit = 2000,
  failLinesSupplied = false,
) {
  if (text.length <= tailBudget) return "";
  const cut = text.length - tailBudget;
  const boundary = text.indexOf("\n", cut);
  const end = boundary < 0 ? cut : boundary;
  const named = [
    ...new Set(
      text
        .slice(0, end)
        .split(/\r?\n/)
        .filter(
          (line) =>
            !(failLinesSupplied && /^\s*FAIL:/i.test(line)) &&
            /^\s*(?:(?:PASS|FAIL|ERROR|SKIP|NOT OBSERVED):|(?:not )?ok \d+\b|# Subtest:|[✓✔✗✘×]\s)|\.\.\. (?:ok|FAIL|ERROR|skipped)\b|\b(?:PASSED|FAILED|SKIPPED)\s*$/.test(
              line,
            ),
        ),
    ),
  ];
  if (!named.length) return "";
  const kept: string[] = [];
  // Failures first, then coverage gaps, then passing names: a bounded budget drops passes first.
  const failures = named.filter((line) => FAILURE_RECORD.test(line));
  const gaps = named.filter((line) => !FAILURE_RECORD.test(line) && GAP_RECORD.test(line));
  const rest = named.filter((line) => !FAILURE_RECORD.test(line) && !GAP_RECORD.test(line));
  const gapNote = gaps.length
    ? "VISP: NOT OBSERVED marks an informational coverage gap, not a failure or passing assertion."
    : "";
  let remaining = limit - 350 - gapNote.length;
  for (const line of [...failures, ...gaps, ...rest]) {
    if (line.length + 1 > remaining) continue;
    kept.push(line);
    remaining -= line.length + 1;
  }
  return [
    "VISP: named assertion results from earlier output (reporter text, not independently authenticated assertions):",
    ...(gapNote ? [gapNote] : []),
    ...kept,
    `VISP: output shortened for review; ${named.length - kept.length} earlier named result line(s) omitted. Other log regions omitted; full output remains in the local check-output log.`,
  ]
    .join("\n")
    .slice(0, limit);
}
