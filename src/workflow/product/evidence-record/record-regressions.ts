import type { RegressionGateReport } from "../regression/regression-report.js";
import type { EvidenceGap, EvidenceRegressions } from "./record-types.js";

const MESSAGE = 160;

/** The regression gate's saved report, read against the current version of the product. */
export function regressionsFrom(
  gate: { readonly mode: EvidenceRegressions["mode"]; readonly report?: RegressionGateReport },
  subject: string,
): EvidenceRegressions {
  const empty = { regressions: [], unchecked: [], preExisting: 0, leftOut: 0 };
  const { mode, report } = gate;
  if (!report) return { mode, status: "not-run", ...empty };
  if (report.subjectDigest !== subject)
    return { mode, status: "stale", ...empty, durationMs: report.durationMs };
  const tests = report.results.flatMap((result) =>
    result.tests.map((test) => ({
      status: test.status,
      line: lineFor(result.label, test.name, test.reason ?? test.message),
    })),
  );
  // A command that could not run at all has no test verdicts; it is unchecked as a whole.
  const unrun = report.results
    .filter((result) => result.status === "unchecked" && !result.tests.length)
    .map((result) => lineFor(result.label, result.label, result.reason ?? ""));
  return {
    mode,
    status: report.status,
    commands: report.results.length,
    ...(report.selection ? { selection: report.selection } : {}),
    regressions: tests.filter((test) => test.status === "regression").map((test) => test.line),
    unchecked: [
      ...tests.filter((test) => test.status === "unchecked").map((test) => test.line),
      ...unrun,
    ],
    preExisting: tests.filter((test) => test.status === "pre-existing").length,
    leftOut: report.leftOut.length,
    durationMs: report.durationMs,
  };
}

function lineFor(label: string, name: string, detail: string): string {
  const title = name && name !== label ? `${label} › ${name}` : label;
  return detail ? `${title}: ${detail.replace(/\s+/g, " ").slice(0, MESSAGE)}` : title;
}

export function regressionGaps(regressions: EvidenceRegressions): EvidenceGap[] {
  return [
    ...regressions.regressions.map(
      (line): EvidenceGap => ({
        kind: "regression",
        severity: "blocking",
        ref: line.split(":")[0],
        text: `Regression: ${line} (passes on the code before the feature)`,
      }),
    ),
    ...regressions.unchecked.map(
      (line): EvidenceGap => ({
        kind: /: flaky\b/.test(line) ? "flaky" : "regression",
        severity: "attention",
        ref: line.split(":")[0],
        text: `Unchecked failure: ${line}`,
      }),
    ),
    ...(regressions.status === "stale"
      ? [
          {
            kind: "regression" as const,
            severity: "attention" as const,
            text: "The regression gate last ran on an earlier version of the product",
          },
        ]
      : []),
  ];
}
