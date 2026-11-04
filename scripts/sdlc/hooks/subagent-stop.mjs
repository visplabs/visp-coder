#!/usr/bin/env node

// Claude Code SubagentStop hook for the SDLC agents. For task agents (coders, reviewer, QE
// verify) it reads the yaml report, adds an envelope it builds itself, validates it and, for a
// coder, checks the changed files against the task scope and re-runs the build, tests and
// typecheck. For qe-spec it validates and traces the drafted spec and writes it into the
// feature issue. A report that fails keeps the agent working with the reason; after five
// refusals the agent may stop and the failure is logged. Every accepted report is logged in the
// worklog.

import { countBlock, loadTask, taskOf } from "../lib/agent-task.mjs";
import { CODERS, SPEC_AGENT, TASK_REPORTS } from "../lib/agents.mjs";
import {
  buildArtifact,
  changedFiles,
  fileArtifact,
  lastYamlBlock,
  writeWorklog,
} from "../lib/filing.mjs";
import { readEvent, respond } from "../lib/hook-io.mjs";
import { repoRoot } from "../lib/paths.mjs";
import { pathRefusal } from "../lib/scope-rules.mjs";
import { fileSpec } from "../lib/spec-filing.mjs";
import {
  finalReport,
  findAgentTranscript,
  modelAndUsage,
  readTranscript,
} from "../lib/transcript.mjs";
import { runVerification } from "../lib/verify.mjs";

const MAX_BLOCKS = 5;

const event = await readEvent();
const type = TASK_REPORTS[event.agent_type];
const isSpec = event.agent_type === SPEC_AGENT;
const task = type || isSpec ? taskOf(event) : undefined;
if (!task || (type && !task.task)) process.exit(0);

const entries = readTranscript(findAgentTranscript(event));
const { model, usage } = modelAndUsage(entries);
const now = new Date();
const envelope = {
  feature: task.feature,
  ...(task.task ? { task: task.task } : {}),
  agent: event.agent_type,
  agent_id: event.agent_id,
  ...(model ? { model } : {}),
  ...(event.effort?.level ? { effort: event.effort.level } : {}),
  usage,
};

const outcome = isSpec ? examineSpec() : examine();
if (outcome.spec) {
  writeWorklog(event.cwd, envelope, { status: "done", summary: outcome.spec, now });
} else if (outcome.artifact) {
  fileArtifact(event.cwd, outcome.artifact, now);
  const body = outcome.artifact.body;
  const summary = body.summary ?? `verdict: ${body.verdict}`;
  writeWorklog(event.cwd, envelope, { status: outcome.artifact.status, summary, now });
} else if (countBlock(event) <= MAX_BLOCKS) {
  respond({
    decision: "block",
    reason: `SDLC stop hook: ${outcome.reason}\nFix this, then end with a corrected yaml report.`,
  });
} else {
  const summary = `stopped after ${MAX_BLOCKS} refused reports; last: ${outcome.reason.split("\n")[0]}`;
  writeWorklog(event.cwd, envelope, { status: "failed", summary, now });
}

function examineSpec() {
  const reason = fileSpec(
    event.cwd,
    task.feature,
    finalReport(entries, event.last_assistant_message),
  );
  return reason ? { reason } : { spec: `spec drafted into the ${task.feature} issue` };
}

function examine() {
  const { doc, error } = lastYamlBlock(finalReport(entries, event.last_assistant_message));
  if (error) return { reason: error };
  const built = buildArtifact(type, envelope, doc, now);
  if (built.reason || !CODERS.has(event.agent_type)) return built;
  const reason = checkHandoff(built.artifact);
  return reason ? { reason } : built;
}

function checkHandoff(artifact) {
  const root = repoRoot(event.cwd);
  const contract = loadTask(event.cwd, task);
  const changed = changedFiles(root, process.env.SDLC_BASE_REF ?? "origin/develop");
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
