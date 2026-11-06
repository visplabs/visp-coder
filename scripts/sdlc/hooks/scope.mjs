#!/usr/bin/env node
// Claude Code PreToolUse hook for Edit, Write, MultiEdit, NotebookEdit and Bash. A coder agent
// may change only the paths its task contract allows, never SDLC, CI, lint, test or package
// files. Every other agent may not change SDLC state (settings, hooks, config, .sdlc/). The
// owner's own session passes untouched.

import { loadTask, taskOf } from "../lib/agent-task.mjs";
import { CODERS } from "../lib/agents.mjs";
import { denyTool, readEvent } from "../lib/hook-io.mjs";
import { repoRoot, sdlcRoot } from "../lib/paths.mjs";
import { pathRefusal, shellWriteTargets, stateRefusal } from "../lib/scope-rules.mjs";

const event = await readEvent();
if (!event.agent_type) process.exit(0);
const input = event.tool_input ?? {};
const paths =
  event.tool_name === "Bash"
    ? shellWriteTargets(String(input.command ?? ""))
    : [input.file_path ?? input.notebook_path].filter(Boolean);
const root = repoRoot(event.cwd);
if (!CODERS.has(event.agent_type)) {
  refuseFirst((path) => stateRefusal(root, event.cwd, path, sdlcRoot(event.cwd)));
  process.exit(0);
}

const task = taskOf(event);
if (!task?.task) {
  denyTool(
    'No SDLC task is known for this agent; the manager must start it with "SDLC-Task: F-12/T-13".',
  );
  process.exit(0);
}

let scope;
try {
  scope = loadTask(event.cwd, task).scope.paths;
} catch (error) {
  denyTool(`The contract of ${task.feature}/${task.task} cannot be read: ${error.message}`);
  process.exit(0);
}

refuseFirst((path) => pathRefusal(root, event.cwd, path, scope));

function refuseFirst(check) {
  for (const path of paths) {
    const reason = check(path);
    if (reason) {
      denyTool(`SDLC scope: ${reason}.`);
      return;
    }
  }
}
