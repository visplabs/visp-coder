// Which feature and task a subagent works on, its agent type, how often its stop was refused in
// the current round, and whether its report for the round is filed (an agent may stop again
// after it handed back, for example when a background wait ends). Found once from the task or feature line in the subagent's transcript,
// then kept in .sdlc/run/agents/<agent_id>.json. A resume by SendMessage starts a new round.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { validateDocument } from "../schemas/index.mjs";
import { featureDir, sdlcRoot } from "./paths.mjs";
import { findAgentTranscript, readTranscript, workMarker } from "./transcript.mjs";

export function taskOf(event) {
  const state = readState(event);
  if (state.feature) return state;
  const marker = workMarker(readTranscript(findAgentTranscript(event)));
  if (!marker) return undefined;
  const next = { ...state, ...marker, type: event.agent_type };
  writeState(event, next);
  return next;
}

// The state of another agent, for the SendMessage hook; undefined when it has none.
export function agentState(cwd, agentId) {
  if (!/^[\w-]+$/.test(agentId ?? "")) return undefined;
  const state = readState({ cwd, agent_id: agentId });
  return state.feature ? state : undefined;
}

export function startRound(cwd, agentId) {
  const event = { cwd, agent_id: agentId };
  writeState(event, { ...readState(event), blocks: 0, filed: false });
}

export function markFiled(event) {
  writeState(event, { ...readState(event), filed: true });
}

export function countBlock(event) {
  const state = readState(event);
  const blocks = (state.blocks ?? 0) + 1;
  writeState(event, { ...state, blocks });
  return blocks;
}

export function loadTask(cwd, { feature, task }) {
  const path = join(featureDir(feature, cwd), "tasks", task, "task.yml");
  if (!existsSync(path)) throw new Error(`no contract at ${path}`);
  const result = validateDocument(parse(readFileSync(path, "utf8")));
  if (!result.ok) throw new Error(`${path}: ${result.errors.join("; ")}`);
  return result.value;
}

function statePath(event) {
  return join(sdlcRoot(event.cwd), "run", "agents", `${event.agent_id}.json`);
}

function readState(event) {
  const path = statePath(event);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

function writeState(event, state) {
  const path = statePath(event);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state));
}
