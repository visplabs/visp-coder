// Commands only some agents may run: Codex only through `sdlc review`, which only the reviewer
// runs (it spends a Codex round); Jira writes only by the clerk; and a pull request only once
// its task may ship (ship-gate.mjs). Other `sdlc` subcommands and Jira reads are open to every
// agent. `sdlc` is recognised as `pnpm sdlc`, `pnpm run sdlc`, `npm run sdlc --` or a direct
// call of scripts/sdlc/sdlc.mjs.

import { basename } from "node:path";
import { shipGateRefusal } from "./ship-gate.mjs";

const JIRA_READS = new Set(["show", "search"]);
const RUNNERS = new Set(["pnpm", "npm", "yarn"]);

export function agentCommandRefusal(words, cwd, agentType) {
  const [cmd, ...args] = words;
  if (basename(cmd) === "codex") return "runs Codex outside `sdlc review`";
  if (basename(cmd) === "gh" && args[0] === "pr" && args[1] === "create") {
    return shipGateRefusal(args.slice(2), cwd);
  }
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
