// Which agent may run which `sdlc` subcommand: only the reviewer runs `sdlc review` (it spends
// a Codex round), and only the clerk writes to Jira. Other subcommands and Jira reads are open
// to every agent. The command is recognised as `pnpm sdlc`, `pnpm run sdlc`, `npm run sdlc --`
// or a direct call of scripts/sdlc/sdlc.mjs.

import { basename } from "node:path";

const JIRA_READS = new Set(["show", "search"]);
const RUNNERS = new Set(["pnpm", "npm", "yarn"]);

export function sdlcCommandRefusal(words, agentType) {
  const [name, sub] = sdlcArgs(words) ?? [];
  if (name === "review" && agentType !== "reviewer") return "starts a review round";
  if (name === "jira" && !JIRA_READS.has(sub) && agentType !== "clerk") {
    return "writes to Jira; the clerk does that";
  }
  return undefined;
}

// The arguments after `sdlc`, or undefined when the words do not run the sdlc script.
function sdlcArgs(words) {
  const [cmd, ...rest] = words;
  const name = basename(cmd ?? "");
  if (RUNNERS.has(name)) {
    const args = rest[0] === "run" ? rest.slice(1) : rest;
    if (args[0] !== "sdlc") return undefined;
    return args.slice(args[1] === "--" ? 2 : 1);
  }
  const script = name === "node" ? rest[0] : cmd;
  if (!script?.endsWith("scripts/sdlc/sdlc.mjs")) return undefined;
  return name === "node" ? rest.slice(1) : rest;
}
