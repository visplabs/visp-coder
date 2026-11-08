// sdlc ci-failures <pr> --task VISP-13: the manager runs this when CI fails on a task's pull
// request. It prints each failed check with its link and each new SonarQube Cloud issue with its
// file and line, for the coder, and appends one mistake-log entry per failed check and per Sonar
// issue (keyed by rule), so CI failures reach the retro like hook refusals and blocking findings.
// Each entry names the PR's head commit and the run, so the retro can tell a flake (a rerun of
// the same commit passed) from a failure. The summary `check` job is logged only when it is the
// only failure: it fails whenever another job does.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../lib/config.mjs";
import { ghJson } from "../lib/gh.mjs";
import { logMistake } from "../lib/mistakes.mjs";
import { sdlcRoot } from "../lib/paths.mjs";
import { pullRequestIssues } from "../lib/sonar.mjs";
import { workKey } from "../schemas/spec.mjs";

export async function run(args) {
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
  const event = { cwd: process.cwd(), agent_type: "ci", tool_name: "CI" };
  const work = { feature: featureOf(values.task), task: values.task, commit: headOf(pr) };
  if (failed.length === 0) console.log(`PR #${pr}: no failed checks`);
  const logged = failed.length > 1 ? failed.filter((check) => check.name !== SUMMARY) : failed;
  for (const check of failed) console.log(`${check.name} ${check.link}`);
  for (const check of logged) {
    const reason = `${values.task} CI check ${check.name} failed on PR #${pr}`;
    logMistake(event, "ci", reason, { ...work, link: check.link });
  }
  let issues = [];
  try {
    issues = await pullRequestIssues(loadConfig().sonar, pr);
  } catch (error) {
    console.log(`SonarQube Cloud issues not read: ${error.message}`);
  }
  for (const issue of issues) {
    const where = issue.line ? `${issue.path}:${issue.line}` : issue.path;
    console.log(`sonar ${issue.rule} ${where} ${issue.message}`);
    logMistake(
      event,
      `sonar ${issue.rule}`,
      `${values.task} ${where}: ${issue.message} (PR #${pr})`,
      work,
    );
  }
  return 0;
}

// The CI workflow's job that passes only when every other job did.
const SUMMARY = "check";

function headOf(pr) {
  try {
    return ghJson(["pr", "view", pr, "--json", "headRefOid"]).headRefOid ?? null;
  } catch {
    return null;
  }
}

function featureOf(task) {
  const features = join(sdlcRoot(), "features");
  if (!existsSync(features)) return null;
  return readdirSync(features).find((f) => existsSync(join(features, f, "tasks", task))) ?? null;
}
