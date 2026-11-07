#!/usr/bin/env node

// Claude Code SubagentStop hook for the SDLC agents. For task agents (coders, reviewer, QE
// verify) it reads the yaml report, adds an envelope it builds itself, validates it and, for a
// coder, checks the changed files against the task scope and re-runs the build, tests and
// typecheck. For qe-spec it validates and traces the drafted spec and writes it into the
// epic. A report that fails keeps the agent working with the reason; after five refusals in a
// round the agent may stop and the failure is logged. A report from an agent that ran on another
// model than sdlc.config.json sets is not filed: the run is logged as failed. Coder and reviewer
// reports record the commit they cover. The reviewer hands back the path and sha256 of the report
// `sdlc review` wrote, and the report is filed from that file, so the wrapper never retypes it.
// Every accepted report is logged in the worklog.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { parse } from "yaml";

import { countBlock, loadTask, taskOf } from "../lib/agent-task.mjs";
import { CODERS, SPEC_AGENT, TASK_REPORTS } from "../lib/agents.mjs";
import { loadConfig } from "../lib/config.mjs";
import {
  buildArtifact,
  changedFiles,
  fileArtifact,
  lastYamlBlock,
  writeWorklog,
} from "../lib/filing.mjs";
import { readEvent, respond } from "../lib/hook-io.mjs";
import { logMistake } from "../lib/mistakes.mjs";
import { repoRoot, sdlcRoot } from "../lib/paths.mjs";
import { pathRefusal } from "../lib/scope-rules.mjs";
import { fileSpec } from "../lib/spec-filing.mjs";
import { finalReport, modelAndUsage, settledTranscript } from "../lib/transcript.mjs";
import { runVerification } from "../lib/verify.mjs";

const MAX_BLOCKS = 5;

const event = await readEvent();
const type = TASK_REPORTS[event.agent_type];
const isSpec = event.agent_type === SPEC_AGENT;
const task = type || isSpec ? taskOf(event) : undefined;
if (!task || (type && !task.task)) process.exit(0);

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

const outcome = isSpec ? await examineSpec() : examine();
if (outcome.spec) {
  writeWorklog(event.cwd, envelope, { status: "done", summary: outcome.spec, now });
} else if (outcome.artifact) {
  fileArtifact(event.cwd, outcome.artifact, now);
  const body = outcome.artifact.body;
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

function examine() {
  const { doc, error } = lastYamlBlock(finalReport(entries, event.last_assistant_message));
  if (error) return { reason: error };
  const report = event.agent_type === "reviewer" ? reviewFile(doc) : { doc };
  if (report.reason) return report;
  const withCommit = report.commit ? { ...envelope, commit: report.commit } : envelope;
  const built = buildArtifact(type, withCommit, report.doc, now);
  if (built.reason || !CODERS.has(event.agent_type)) return built;
  const reason = checkHandoff(built.artifact);
  return reason ? { reason } : built;
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

function checkHandoff(artifact) {
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
  if (process.env.SDLC_VERIFY === "off") return undefined;
  return runVerification(
    root,
    changed,
    artifact.body.tests.map((test) => test.test),
  );
}
