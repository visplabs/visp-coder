#!/usr/bin/env node
// Claude Code PreToolUse hook for SendMessage. Resuming a task agent is a new round, which the
// Agent hook never sees: it counts toward the loop bounds and the epic's budget like a start,
// and gets a fresh allowance of refused reports. The manager may resume only agents the SDLC
// knows, by agent id. The owner's own session passes untouched.

import { agentState, startRound } from "../lib/agent-task.mjs";
import { TASK_REPORTS } from "../lib/agents.mjs";
import { loadConfig } from "../lib/config.mjs";
import { denyTool, readEvent } from "../lib/hook-io.mjs";
import { recordTurn, turnRefusal } from "../lib/loops.mjs";

const event = await readEvent();
if (!event.agent_type) process.exit(0);
const target = String(event.tool_input?.to ?? "");
const state = agentState(event.cwd, target);
if (!state) {
  if (event.agent_type === "manager") {
    denyTool(
      event,
      `SDLC: ${target} is not a known SDLC agent; resume task agents by their agent id.`,
    );
  }
  process.exit(0);
}
if (!TASK_REPORTS[state.type] || !state.task) process.exit(0);

const work = { feature: state.feature, task: state.task, agentType: state.type };
let refused;
try {
  refused = turnRefusal(event.cwd, loadConfig(event.cwd), work);
} catch (error) {
  refused = `the SDLC config cannot be read: ${error.message}`;
}
if (refused) {
  denyTool(event, `SDLC: ${refused}.`);
} else {
  recordTurn(event.cwd, work);
  startRound(event.cwd, target);
}
