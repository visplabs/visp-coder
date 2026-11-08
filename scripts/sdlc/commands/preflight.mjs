// sdlc preflight: the manager runs this before an epic's first stage. It proves the agent
// account's Jira token and the reviewer's Codex login work, so a broken credential stops the
// run at the start instead of halfway through (pilot 2 found its CI token broken only on the
// first agent PR). Exits 1 when any check fails. SDLC_CODEX replaces the codex binary in tests.

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { loadConfig } from "../lib/config.mjs";
import { jiraClient } from "../lib/jira.mjs";

export async function run() {
  const config = loadConfig();
  const results = [await jiraCheck(), codexCheck(config.reviewer.codexHome)];
  for (const line of results) console.log(line);
  return results.every((line) => line.includes(" ok")) ? 0 : 1;
}

async function jiraCheck() {
  try {
    const project = await jiraClient().project();
    return `jira ok: project ${project.key} readable with the agent's token`;
  } catch (error) {
    return `jira failed: ${error.message}`;
  }
}

function codexCheck(codexHome) {
  const home = codexHome.replace(/^~(?=\/)/, homedir());
  try {
    execFileSync(process.env.SDLC_CODEX ?? "codex", ["login", "status"], {
      env: { ...process.env, CODEX_HOME: home },
      stdio: ["ignore", "ignore", "pipe"],
    });
    return `codex ok: logged in at ${home}`;
  } catch (error) {
    return `codex failed: not logged in at ${home} (${String(error.message).split("\n")[0]})`;
  }
}
