#!/usr/bin/env node
// Claude Code PreToolUse hook for Bash. Refuses commands that publish, merge, release, tag,
// force-push, push to main or develop, delete branches or worktrees, or read credentials, so
// agents leave them to the owner. It does nothing unless SDLC_OWNER=1, which the owner sets in
// .claude/settings.local.json; other contributors to this repository are unaffected.

import { refusal } from "../lib/safety-rules.mjs";

if (process.env.SDLC_OWNER !== "1") process.exit(0);

const raw = await readStdin();
let event;
try {
  event = JSON.parse(raw);
} catch {
  console.error("sdlc safety: hook input is not JSON, so the command was not checked");
  process.exit(1);
}
if (event.tool_name !== "Bash") process.exit(0);

const reason = refusal(String(event.tool_input?.command ?? ""), event.cwd ?? process.cwd());
if (reason) {
  console.error(`sdlc safety: this command ${reason}. Leave it to the owner to run.`);
  process.exit(2);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
