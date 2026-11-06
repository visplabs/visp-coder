#!/usr/bin/env node
// Claude Code PreToolUse hook for the Agent tool. A task agent (coder, reviewer, QE verify) must
// be started with an "SDLC-Task: VISP-12/VISP-13" line, only once the owner approved the spec and
// the task's ticket is Ready, and within the loop bounds and the epic's run budget; it gets the
// task contract appended: the owner's words, the clauses and criteria, the role's rules and the
// report format. qe-spec must be started with "SDLC-Feature: VISP-12" and gets the owner's words
// and its report format. Any
// SDLC agent loses a `model` or `effort` given on the call, which would outrank its definition
// (sdlc.config.json decides both). Other agents pass untouched.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadTask } from "../lib/agent-task.mjs";
import { FEATURE_LINE, SPEC_AGENT, TASK_LINE, TASK_REPORTS } from "../lib/agents.mjs";
import { loadConfig } from "../lib/config.mjs";
import { renderContract, renderSpecContract } from "../lib/contract.mjs";
import { denyTool, readEvent, respond } from "../lib/hook-io.mjs";
import { recordTurn, turnRefusal } from "../lib/loops.mjs";
import { featureDir } from "../lib/paths.mjs";
import { loadSpec } from "../lib/spec-store.mjs";
import { gateRefusal } from "../lib/ticket-gate.mjs";

const event = await readEvent();
const input = event.tool_input ?? {};
const agentType = input.subagent_type;
const prompt = String(input.prompt ?? "");

if (TASK_REPORTS[agentType]) {
  const contract = taskContract();
  if (contract) allow(contract.feature, contract.text);
} else if (agentType === SPEC_AGENT) {
  const contract = specContract();
  if (contract) allow(contract.feature, contract.text);
} else if (isSdlcAgent(agentType) && ("model" in input || "effort" in input)) {
  allow(agentType, "");
}

function isSdlcAgent(type) {
  try {
    return type in loadConfig(event.cwd).agents;
  } catch {
    return false;
  }
}

function taskContract() {
  const marker = prompt.match(TASK_LINE);
  if (!marker) {
    denyTool(
      event,
      `Start ${agentType} with a line "SDLC-Task: VISP-12/VISP-13" in its prompt (the epic's and ` +
        `the task's Jira keys), after "pnpm sdlc pull VISP-12".`,
    );
    return undefined;
  }
  const [, feature, taskId] = marker;
  let spec;
  let task;
  let config;
  try {
    spec = loadSpec(join(featureDir(feature, event.cwd), "spec"));
    task = loadTask(event.cwd, { feature, task: taskId });
    config = loadConfig(event.cwd);
  } catch (error) {
    denyTool(
      event,
      `${feature}/${taskId} is not pulled or not valid: run "pnpm sdlc pull ${feature}". ${error.message}`,
    );
    return undefined;
  }
  const work = { feature, task: taskId, agentType, spec };
  const refused = gateRefusal(event.cwd, config, work) ?? turnRefusal(event.cwd, config, work);
  if (refused) {
    denyTool(event, `SDLC: ${refused}.`);
    return undefined;
  }
  recordTurn(event.cwd, work);
  return { feature: `${feature}/${taskId}`, text: renderContract(agentType, spec, task) };
}

function specContract() {
  const marker = prompt.match(FEATURE_LINE);
  if (!marker) {
    denyTool(
      event,
      'Start qe-spec with a line "SDLC-Feature: VISP-12" in its prompt (the epic\'s Jira key).',
    );
    return undefined;
  }
  const feature = marker[1];
  const path = join(featureDir(feature, event.cwd), "owner-text.md");
  if (!existsSync(path)) {
    denyTool(
      event,
      `No owner's words are recorded for ${feature}: open the feature with /feature, or run ` +
        `"pnpm sdlc pull ${feature}" if its issue already has them.`,
    );
    return undefined;
  }
  return { feature, text: renderSpecContract(feature, readFileSync(path, "utf8")) };
}

function allow(work, contract) {
  const { model: _model, effort: _effort, ...rest } = input;
  respond({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: contract
        ? `SDLC contract for ${work} added`
        : `SDLC: ${work} runs on the model and effort its definition sets`,
      updatedInput: { ...rest, prompt: contract ? `${prompt}\n\n${contract}` : prompt },
    },
  });
}
