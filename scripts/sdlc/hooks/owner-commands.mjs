#!/usr/bin/env node
// Claude Code UserPromptExpansion hook for the owner-only commands /feature and /approve.
// /feature opens the epic in Jira and lets the command expand, with the result as context for
// the session; /approve always stops the turn and shows its result to the owner. A failure
// stops the turn with the reason.

import { readEvent, respond } from "../lib/hook-io.mjs";
import { approveCommand, featureCommand } from "../lib/owner-commands.mjs";

const event = await readEvent();
const name = String(event.command_name ?? "").replace(/^\//, "");
if (name !== "feature" && name !== "approve") process.exit(0);

const args = String(event.command_args ?? "");
try {
  if (name === "feature") {
    respond({
      hookSpecificOutput: {
        hookEventName: "UserPromptExpansion",
        additionalContext: await featureCommand(args, event.cwd),
      },
    });
  } else {
    respond({ decision: "block", reason: await approveCommand(args, event.cwd) });
  }
} catch (error) {
  respond({ decision: "block", reason: `sdlc /${name}: ${error.message}` });
}
