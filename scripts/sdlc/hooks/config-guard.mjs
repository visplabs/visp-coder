#!/usr/bin/env node
// Claude Code ConfigChange hook. In a pipeline session (started with `claude --agent <name>`),
// a changed settings or skill file does not take effect: settings reload live, and turning
// SDLC_OWNER off or dropping a hook would switch the gates off mid-run. Managed policy cannot
// be blocked and is left alone. The owner's own sessions pass untouched; the owner restarts the
// pipeline to pick up a change.

import { readEvent, respond } from "../lib/hook-io.mjs";

const BLOCKED = new Set(["user_settings", "project_settings", "local_settings", "skills"]);

const event = await readEvent();
if (event.agent_type && BLOCKED.has(event.source)) {
  respond({
    decision: "block",
    reason: `SDLC: ${event.source} changed during a pipeline run; restart the session to apply it`,
  });
}
