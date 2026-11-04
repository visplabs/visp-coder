// Which feature and task a subagent works on, and how often its stop was refused. Found once
// from the task or feature line in the subagent's transcript, then kept in
// .sdlc/run/agents/<agent_id>.json.

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
  const next = { ...state, ...marker };
  writeState(event, next);
  return next;
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
