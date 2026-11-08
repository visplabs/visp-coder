// The crash check for QE journey runs. VISP appends each crash to the file VISP_CRASH_LOG names
// (src/telemetry/error-reporting.ts); qe-verify runs its journeys with it pointing at
// .sdlc/run/crashes.jsonl and VISP_SENTRY_TAGS=task=<task>. A journey that passed while VISP
// crashed underneath (a hook the host ran fail-open, a background step) still fails the run.
// Untagged crashes count against the task: the check fails closed.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sdlcRoot } from "./paths.mjs";

export function crashLogPath(cwd) {
  return join(sdlcRoot(cwd), "run", "crashes.jsonl");
}

// Whether any of the task's criteria is a journey: only those runs are checked.
export function hasJourneyCriteria(acceptance, task) {
  return acceptance.criteria.some((c) => task.criteria.includes(c.id) && c.level === "journey");
}

export function crashesSince(cwd, task, since) {
  const path = crashLogPath(cwd);
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { at: new Date().toISOString(), tags: {} };
      }
    })
    .filter((crash) => Date.parse(crash.at) >= since.getTime())
    .filter((crash) => !crash.tags?.task || crash.tags.task === task).length;
}

// Why a qe-verify report may not be filed, or undefined. For a task with journey criteria the
// report must count the crashes, the count must match the log since the run began, and any
// crash makes the verdict a fail.
export function qeCrashRefusal({ cwd, acceptance, task, body, since }) {
  if (!hasJourneyCriteria(acceptance, task)) return undefined;
  if (!Number.isInteger(body.crashes)) {
    return `a task with journey criteria needs \`crashes\` in the report: the lines in ${crashLogPath(cwd)} since you started`;
  }
  const count = crashesSince(cwd, task.task, since);
  if (count === body.crashes && (count === 0 || body.verdict === "fail")) return undefined;
  const fix = count > 0 ? `report crashes: ${count} and verdict: fail` : "report crashes: 0";
  return `VISP crashed ${count} times during this run (${crashLogPath(cwd)}); ${fix}`;
}
