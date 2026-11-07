#!/usr/bin/env node

// Claude Code SubagentStop hook for the SDLC agents. For task agents (coders, reviewer, QE verify)
// it reads the yaml report, adds an envelope it builds itself, validates it and, for a coder,
// checks the changed files against the task scope and re-runs the build, tests and typecheck. For
// qe-spec it validates and traces the drafted spec and writes it into the epic. A report that fails
// keeps the agent working with the reason; after five refusals in a round the agent may stop and
// the failure is logged. A report from an agent that ran on another model than sdlc.config.json
// sets is not filed: the run is logged as failed. Coder and reviewer reports record the commit they
// cover. A qe-verify report for a task with journey criteria must count the crashes VISP logged
// during its runs, and the hook checks that count against the crash log. One report is filed per
// round: a stop after it (an agent woken by a background task after its handback) is let through.
// The reviewer hands back the path and sha256 of the report `sdlc review` wrote, and the report is
// filed from that file, so the wrapper never retypes it. Every accepted report is logged in the
// worklog, and each blocking review finding in the mistake log, so the retro sees what the coder
// got wrong as well as what the hooks refused.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";

import { countBlock, loadTask, markFiled, taskOf } from "../lib/agent-task.mjs";
import { CODERS, SPEC_AGENT, TASK_REPORTS } from "../lib/agents.mjs";
import { loadConfig } from "../lib/config.mjs";
import { qeCrashRefusal } from "../lib/crash-log.mjs";
import {
  buildArtifact,
  changedFiles,
  fileArtifact,
  lastYamlBlock,
  writeWorklog,
} from "../lib/filing.mjs";
import { readEvent, respond } from "../lib/hook-io.mjs";
import { jiraClient } from "../lib/jira.mjs";
import { logMistake } from "../lib/mistakes.mjs";
import { featureDir, repoRoot, sdlcRoot } from "../lib/paths.mjs";
import { pathRefusal } from "../lib/scope-rules.mjs";
import { fileSpec } from "../lib/spec-filing.mjs";
import { loadSpec } from "../lib/spec-store.mjs";
import { CODER_LEVELS, casesToLink, QE_LEVELS, withLinks } from "../lib/test-links.mjs";
import { finalReport, modelAndUsage, settledTranscript } from "../lib/transcript.mjs";
import { recordVerified, runVerification } from "../lib/verify.mjs";

const MAX_BLOCKS = 5;

const event = await readEvent();
const type = TASK_REPORTS[event.agent_type];
const isSpec = event.agent_type === SPEC_AGENT;
const task = type || isSpec ? taskOf(event) : undefined;
if (!task || (type && !task.task) || task.filed) process.exit(0);

const entries = await settledTranscript(event);
const { model, usage } = modelAndUsage(entries);
const now = new Date();
const envelope = {
  feature: task.feature,
  ...(task.task ? { task: task.task } : {}),
  agent: event.agent_type,
  agent_id: event.agent_id,
  ...(model ? { model } : {}),
  ...(event.effort?.level ? { effort: event.effort.level } : {}),
  ...(CODERS.has(event.agent_type) || event.agent_type === "reviewer-fallback"
    ? { commit: head(event.cwd) }
    : {}),
  usage,
};

const expected = expectedModel();
if (model && expected && !model.startsWith(expected)) {
  const summary = `ran on ${model}, but sdlc.config.json sets ${expected}; report not filed`;
  logMistake(event, "subagent-stop", summary);
  writeWorklog(event.cwd, envelope, { status: "failed", summary, now });
  process.exit(0);
}

const outcome = isSpec ? await examineSpec() : await examine();
if (outcome.spec) {
  markFiled(event);
  writeWorklog(event.cwd, envelope, { status: "done", summary: outcome.spec, now });
} else if (outcome.artifact) {
  fileArtifact(event.cwd, outcome.artifact, now);
  markFiled(event);
  const body = outcome.artifact.body;
  for (const finding of (body.findings ?? []).filter((f) => f.severity === "blocking")) {
    const reason = `${task.task} blocking finding on ${finding.cites}: ${finding.text}`;
    logMistake(event, "review", reason);
  }
  const summary = body.summary ?? `verdict: ${body.verdict}`;
  writeWorklog(event.cwd, envelope, { status: outcome.artifact.status, summary, now });
} else if (countBlock(event) <= MAX_BLOCKS) {
  logMistake(event, "subagent-stop", outcome.reason);
  respond({
    decision: "block",
    reason: `SDLC stop hook: ${outcome.reason}\nFix this, then end with a corrected yaml report.`,
  });
} else {
  const summary = `stopped after ${MAX_BLOCKS} refused reports; last: ${outcome.reason.split("\n")[0]}`;
  writeWorklog(event.cwd, envelope, { status: "failed", summary, now });
}

function expectedModel() {
  try {
    return loadConfig(event.cwd).agents[event.agent_type]?.model;
  } catch {
    return undefined;
  }
}

function head(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

async function examineSpec() {
  const reason = await fileSpec(
    event.cwd,
    task.feature,
    finalReport(entries, event.last_assistant_message),
  );
  return reason ? { reason } : { spec: `spec drafted into the ${task.feature} issue` };
}

async function examine() {
  const { doc, error } = lastYamlBlock(finalReport(entries, event.last_assistant_message));
  if (error) return { reason: error };
  const report = event.agent_type === "reviewer" ? reviewFile(doc) : { doc };
  if (report.reason) return report;
  const withCommit = report.commit ? { ...envelope, commit: report.commit } : envelope;
  const built = buildArtifact(type, withCommit, report.doc, now);
  if (built.reason) return built;
  let reason;
  if (CODERS.has(event.agent_type)) reason = await checkHandoff(built.artifact);
  if (event.agent_type === "qe-verify") reason = await checkQeReport(built.artifact);
  return reason ? { reason } : built;
}

// The crash check for journey runs, counted from VISP's crash log since the agent's first
// transcript entry, then the journey and performance test cases' links.
async function checkQeReport(artifact) {
  const spec = loadSpec(join(featureDir(task.feature, event.cwd), "spec"));
  const contract = loadTask(event.cwd, task);
  const crashes = qeCrashRefusal({
    cwd: event.cwd,
    acceptance: spec.acceptance,
    task: contract,
    body: artifact.body,
    since: new Date(entries.find((entry) => entry.timestamp)?.timestamp ?? now),
  });
  if (crashes) return crashes;
  const links = artifact.body.cases
    .filter((c) => c.test)
    .map((c) => ({ case: c.id, test: c.test }));
  return unlinkedCases(contract, links, QE_LEVELS) ?? (await writeLinks(contract, links));
}

// The report `sdlc review` wrote, checked against the sha256 the reviewer handed back.
function reviewFile(doc) {
  const path = String(doc?.review_file ?? "");
  const reviews = `${sdlcRoot(event.cwd)}/run/reviews`;
  if (!path || relative(reviews, path).startsWith("..") || !existsSync(path)) {
    return {
      reason: `hand back review_file (a file under ${reviews}) and sha256 from sdlc review`,
    };
  }
  const text = readFileSync(path, "utf8");
  if (createHash("sha256").update(text).digest("hex") !== doc.sha256) {
    return { reason: `the sha256 does not match ${path}; hand back what sdlc review printed` };
  }
  const file = parse(text);
  return { doc: { status: file.status, body: file.body }, commit: file.commit };
}

async function checkHandoff(artifact) {
  const root = repoRoot(event.cwd);
  const contract = loadTask(event.cwd, task);
  const base = process.env.SDLC_BASE_REF ?? `origin/${loadConfig(event.cwd).baseBranch}`;
  const changed = changedFiles(root, base);
  const outside = changed
    .map((file) => pathRefusal(root, root, file, contract.scope.paths))
    .filter(Boolean);
  if (outside.length > 0) {
    return `changed files the task may not change; revert them:\n- ${outside.join("\n- ")}`;
  }
  const links = artifact.body.tests;
  const unlinked = unlinkedCases(contract, links, CODER_LEVELS);
  if (unlinked) return unlinked;
  if (process.env.SDLC_VERIFY !== "off") {
    const result = runVerification(
      root,
      changed,
      links.map((link) => link.test),
    );
    if (result.failed) return result.failed;
    const failing = links.filter((link) => result.results.get(link.test) !== "passed");
    if (failing.length > 0) {
      const names = failing.map((link) => `${link.case}: ${link.test}`).join("\n- ");
      return `these linked tests were not found or did not pass; fix the names or the tests:\n- ${names}`;
    }
    recordVerified(event.cwd, task, artifact.commit, result.ran);
  }
  return writeLinks(contract, links);
}

// Why some test cases this stage must link have no test, or undefined.
function unlinkedCases(contract, links, levels) {
  const spec = loadSpec(join(featureDir(task.feature, event.cwd), "spec"));
  const linked = new Set(links.map((link) => link.case));
  const missing = casesToLink(spec, contract, levels).filter((tc) => !linked.has(tc.id));
  if (missing.length === 0) return undefined;
  return missing.map((tc) => `link a test for ${tc.id} (${tc.title}) in the report`).join("\n");
}

// Keeps the links in the task's Jira issue, where the CI gate and the trace read them.
async function writeLinks(contract, links) {
  if (links.length === 0) return undefined;
  try {
    const jira = jiraClient(event.cwd);
    const issue = await jira.readIssue(contract.task);
    await jira.writeBody(contract.task, withLinks(issue.body, task.feature, contract.task, links));
    return undefined;
  } catch (error) {
    return `could not write the test links to ${contract.task} in Jira (${error.message}); stop again to retry`;
  }
}
