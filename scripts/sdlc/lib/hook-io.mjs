import { basename } from "node:path";
import { logMistake } from "./mistakes.mjs";

// Input and output for Claude Code command hooks: the event arrives as JSON on stdin, and a
// decision leaves as JSON on stdout. Hooks do nothing unless SDLC_OWNER=1, so contributors to
// the repository are unaffected.

export async function readEvent({ ownerOnly = true } = {}) {
  if (ownerOnly && process.env.SDLC_OWNER !== "1") process.exit(0);
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    console.error("sdlc hook: input is not JSON");
    process.exit(1);
  }
}

export function respond(output) {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

// Refuses the tool call and records the refusal in the mistake log.
export function denyTool(event, reason) {
  logMistake(event, hookName(), reason);
  respond({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

export function tail(text, lines) {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

// The running hook's file name without extension, such as "scope".
export function hookName() {
  return basename(process.argv[1] ?? "hook").replace(/\.mjs$/, "");
}
