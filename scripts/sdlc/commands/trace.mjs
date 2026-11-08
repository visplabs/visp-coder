// sdlc trace F-12 [--results vitest.json] [--json]: follows every intent clause to criteria,
// test cases and, with a vitest JSON report, test results. Exits 1 when any error is found.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { featureDir, parseFeature, repoRoot } from "../lib/paths.mjs";
import { loadSpec } from "../lib/spec-store.mjs";
import { resultsIndex, trace } from "../lib/trace.mjs";

const TRACE_OPTIONS = {
  results: { type: "string" },
  notes: { type: "string" },
  json: { type: "boolean", default: false },
};

export function traceFeature(args) {
  const { values, positionals } = parseArgs({
    args,
    options: TRACE_OPTIONS,
    allowPositionals: true,
  });
  const feature = parseFeature(positionals[0]);
  const spec = loadSpec(join(featureDir(feature), "spec"));
  const results = values.results
    ? resultsIndex(JSON.parse(readFileSync(values.results, "utf8")), repoRoot())
    : undefined;
  return { feature, spec, report: trace(spec, results), json: values.json, notes: values.notes };
}

export function run(args) {
  const { report, json } = traceFeature(args);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const clause of report.clauses) {
      const criteria = clause.criteria.join(",") || "-";
      console.log(
        `${clause.id.padEnd(6)} ${clause.kind.padEnd(12)} ${clause.status.padEnd(14)} ${criteria}`,
      );
    }
    for (const problem of report.problems) {
      console.log(`${problem.severity} ${problem.kind}: ${problem.message}`);
    }
  }
  return report.problems.some((problem) => problem.severity === "error") ? 1 : 0;
}
