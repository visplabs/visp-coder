// The mistake log for the outer loop: every hook refusal (a denied tool call, a refused report,
// a blocked settings change) appends one JSON line to .sdlc/mistakes.jsonl, with a signature
// that groups repeats of the same mistake for the retro. Logging never fails the hook.
// SDLC_MISTAKE_LOG names another file, so tests that run hooks in this repository keep its log
// clean.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { sdlcRoot } from "./paths.mjs";

export function logMistake(event, hook, reason) {
  try {
    const file = process.env.SDLC_MISTAKE_LOG ?? join(sdlcRoot(event.cwd), "mistakes.jsonl");
    mkdirSync(dirname(file), { recursive: true });
    const entry = {
      at: new Date().toISOString(),
      hook,
      agent_type: event.agent_type ?? null,
      agent_id: event.agent_id ?? null,
      tool: event.tool_name ?? event.hook_event_name ?? null,
      reason,
      signature: `${hook}:${signature(reason)}`,
    };
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // The refusal still stands; only its record is lost.
  }
}

// The reason without the parts that change between repeats: keys, paths, hashes and numbers.
function signature(reason) {
  return reason
    .replace(/(?<![A-Z0-9])[A-Z][A-Z0-9]*-\d+/g, "KEY")
    .replace(/[0-9a-f]{12,}/g, "HASH")
    .split(/\s+/)
    .slice(0, 8)
    .map((word) => (word.includes("/") ? "PATH" : word.replace(/\d+/g, "N")))
    .join(" ");
}
