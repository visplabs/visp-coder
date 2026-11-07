// sdlc ci-failures <pr> --task VISP-13: the manager runs this when CI fails on a task's pull
// request. It prints each failed check with its link and appends one mistake-log entry per
// failed check, so CI failures reach the retro like hook refusals and blocking findings.

import { parseArgs } from "node:util";
import { ghJson } from "../lib/gh.mjs";
import { logMistake } from "../lib/mistakes.mjs";
import { workKey } from "../schemas/spec.mjs";

export function run(args) {
  const { values, positionals } = parseArgs({
    args,
    options: { task: { type: "string" } },
    allowPositionals: true,
  });
  const pr = positionals[0] ?? "";
  if (!/^\d+$/.test(pr) || !workKey.test(values.task ?? "")) {
    throw new Error("usage: sdlc ci-failures <pull request number> --task VISP-13");
  }
  const checks = ghJson(["pr", "checks", pr, "--json", "name,bucket,link"]);
  const failed = checks.filter((check) => check.bucket === "fail");
  if (failed.length === 0) {
    console.log(`PR #${pr}: no failed checks`);
    return 0;
  }
  const event = { cwd: process.cwd(), agent_type: "ci", tool_name: "CI" };
  for (const check of failed) {
    logMistake(event, "ci", `${values.task} CI check ${check.name} failed on PR #${pr}`);
    console.log(`${check.name} ${check.link}`);
  }
  return 0;
}
