// The mistake log for the outer loop: every hook refusal (a denied tool call, a refused report,
// a blocked settings change) appends one JSON line to .sdlc/mistakes.jsonl, with a signature
// that groups repeats of the same mistake for the retro. Logging never fails the hook.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { sdlcRoot } from "./paths.mjs";

export function logMistake(event, hook, reason) {
  try {
    const root = sdlcRoot(event.cwd);
    mkdirSync(root, { recursive: true });
    const entry = {
      at: new Date().toISOString(),
      hook,
      agent_type: event.agent_type ?? null,
      agent_id: event.agent_id ?? null,
      tool: event.tool_name ?? event.hook_event_name ?? null,
      reason,
      signature: `${hook}:${signature(reason)}`,
    };
    appendFileSync(join(root, "mistakes.jsonl"), `${JSON.stringify(entry)}\n`);
  } catch {
    // The refusal still stands; only its record is lost.
  }
}

// The reason without the parts that change between repeats: keys, paths, hashes and numbers.
function signature(reason) {
  return reason
    .replace(/[A-Z][A-Z0-9]*-\d+/g, "KEY")
    .replace(/[0-9a-f]{12,}/g, "HASH")
    .replace(/\S*\/\S*/g, "PATH")
    .replace(/\d+/g, "N")
    .split(/\s+/)
    .slice(0, 8)
    .join(" ");
}
