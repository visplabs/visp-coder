// sdlc trace F-12 [--results vitest.json] [--json]: follows every intent clause to criteria,
// test cases and, with a vitest JSON report, test results. Exits 1 when any error is found.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadTask } from "../lib/agent-task.mjs";
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
  const tasks = featureTasks(feature);
  const report = trace(spec, results);
  report.problems.push(...planProblems(spec.acceptance.criteria, tasks));
  return { feature, spec, report, json: values.json, notes: values.notes, tasks };
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

// The epic's pulled task contracts; a folder without task.yml (a task that left the epic) is
// not one.
export function featureTasks(feature) {
  const dir = join(featureDir(feature), "tasks");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, "task.yml")))
    .sort()
    .map((task) => loadTask(process.cwd(), { feature, task }));
}

// Once the epic has tasks, each criterion must be delivered by exactly one of them.
function planProblems(criteria, tasks) {
  if (tasks.length === 0) return [];
  const problems = [];
  for (const { id } of criteria) {
    const owners = tasks.filter((task) => task.criteria.includes(id)).map((task) => task.task);
    if (owners.length === 0) problems.push(planning(`${id} is in no task`));
    if (owners.length > 1) {
      const count = owners.length === 2 ? "two" : String(owners.length);
      problems.push(planning(`${id} is in ${count} tasks: ${owners.join(", ")}`));
    }
  }
  return problems;
}

function planning(message) {
  return { severity: "error", kind: "planning", message };
}
