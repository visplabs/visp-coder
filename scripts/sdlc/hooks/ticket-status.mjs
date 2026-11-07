#!/usr/bin/env node
// Claude Code Stop hook. After each turn of a pipeline session (`claude --agent manager`), moves
// the tickets of every approved epic in the cache forward to match their pull requests, so a
// merged task is Done without anyone asking. At most once a minute; it never blocks the turn,
// and a failure goes to the mistake log.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { loadConfig } from "../lib/config.mjs";
import { readEvent } from "../lib/hook-io.mjs";
import { jiraClient } from "../lib/jira.mjs";
import { logMistake } from "../lib/mistakes.mjs";
import { sdlcRoot } from "../lib/paths.mjs";
import { syncEpic } from "../lib/ticket-status.mjs";

const INTERVAL_MS = 60_000;

const event = await readEvent();
if (event.agent_type !== "manager") process.exit(0);
const root = sdlcRoot(event.cwd);
const stamp = join(root, "run", "ticket-status.json");
const last = existsSync(stamp) ? JSON.parse(readFileSync(stamp, "utf8")).at : 0;
if (Date.now() - last < INTERVAL_MS) process.exit(0);
mkdirSync(join(root, "run"), { recursive: true });
writeFileSync(stamp, JSON.stringify({ at: Date.now() }));

try {
  const jira = jiraClient(event.cwd);
  const config = loadConfig(event.cwd);
  for (const feature of approvedEpics(join(root, "features"))) {
    for (const line of await syncEpic(jira, config, feature)) console.error(`sdlc: ${line}`);
  }
} catch (error) {
  logMistake(event, "ticket-status", `ticket status sync failed: ${error.message}`);
}

function approvedEpics(features) {
  if (!existsSync(features)) return [];
  return readdirSync(features).filter((feature) => {
    const path = join(features, feature, "spec", "approval.yml");
    return existsSync(path) && parse(readFileSync(path, "utf8"))?.approved === true;
  });
}
