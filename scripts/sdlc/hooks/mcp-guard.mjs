#!/usr/bin/env node
// Claude Code PreToolUse hook for MCP tools (matcher `mcp__.*`). An SDLC agent may call only
// the MCP tools its entry in sdlc.config.json lists by prefix; every other MCP call is refused.
// Connectors attached to the owner's claude.ai account act as the owner, so an agent that
// reached them could write to Jira, or approve a spec, in the owner's name. Agents the config
// does not name, and the owner's own session, pass untouched.

import { loadConfig } from "../lib/config.mjs";
import { denyTool, readEvent } from "../lib/hook-io.mjs";

const event = await readEvent();
const type = event.agent_type;
if (!type) process.exit(0);

let agents;
try {
  agents = loadConfig(event.cwd).agents;
} catch (error) {
  denyTool(
    event,
    `SDLC MCP guard: the config cannot be read, so MCP stays closed: ${error.message}`,
  );
  process.exit(0);
}
const allowed = agents[type]?.mcp;
if (allowed && !allowed.some((prefix) => String(event.tool_name).startsWith(prefix))) {
  denyTool(
    event,
    `SDLC MCP guard: ${type} may not call ${event.tool_name}. Its MCP tools are set in ` +
      "sdlc.config.json, and only the owner changes them.",
  );
}
