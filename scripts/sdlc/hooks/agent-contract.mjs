#!/usr/bin/env node
// Claude Code PreToolUse hook for the Agent tool. When the manager starts a task agent (coder,
// reviewer, QE verify), it requires an "SDLC-Task: F-12/T-13" line in the prompt and appends
// the task contract: the owner's words, the clauses and criteria, the role's rules and the
// report format. Other agents pass untouched.

import { join } from "node:path";
import { loadTask } from "../lib/agent-task.mjs";
import { TASK_LINE, TASK_REPORTS } from "../lib/agents.mjs";
import { renderContract } from "../lib/contract.mjs";
import { denyTool, readEvent, respond } from "../lib/hook-io.mjs";
import { featureDir } from "../lib/paths.mjs";
import { loadSpec } from "../lib/spec-store.mjs";

const event = await readEvent();
const input = event.tool_input ?? {};
const agentType = input.subagent_type;
if (!TASK_REPORTS[agentType]) process.exit(0);

const marker = String(input.prompt ?? "").match(TASK_LINE);
if (!marker) {
  denyTool(
    `Start ${agentType} with a line "SDLC-Task: F-12/T-13" in its prompt (the feature and task ` +
      `issue numbers), after "pnpm sdlc pull F-12".`,
  );
  process.exit(0);
}

const [, feature, taskId] = marker;
let contract;
try {
  const spec = loadSpec(join(featureDir(feature, event.cwd), "spec"));
  const task = loadTask(event.cwd, { feature, task: taskId });
  contract = renderContract(agentType, spec, task);
} catch (error) {
  denyTool(
    `${feature}/${taskId} is not pulled or not valid: run "pnpm sdlc pull ${feature}". ${error.message}`,
  );
  process.exit(0);
}

respond({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    permissionDecisionReason: `SDLC contract for ${feature}/${taskId} added`,
    updatedInput: { ...input, prompt: `${input.prompt}\n\n${contract}` },
  },
});
