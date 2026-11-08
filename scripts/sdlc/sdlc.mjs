#!/usr/bin/env node
// Commands for the agent SDLC. See CONTRIBUTING.md ("Agent SDLC").

import * as checkPr from "./commands/check-pr.mjs";
import * as ciFailures from "./commands/ci-failures.mjs";
import * as jira from "./commands/jira.mjs";
import * as packet from "./commands/packet.mjs";
import * as pull from "./commands/pull.mjs";
import * as releaseCheck from "./commands/release-check.mjs";
import * as retro from "./commands/retro.mjs";
import * as review from "./commands/review.mjs";
import * as syncStatus from "./commands/sync-status.mjs";
import * as trace from "./commands/trace.mjs";
import * as validate from "./commands/validate.mjs";

const COMMANDS = {
  pull,
  validate,
  trace,
  packet,
  jira,
  review,
  retro,
  "check-pr": checkPr,
  "ci-failures": ciFailures,
  "sync-status": syncStatus,
  "release-check": releaseCheck,
};
const USAGE = `usage: sdlc <command>
  pull VISP-12                      cache epic VISP-12: owner's words, spec, approval, tasks
  validate <file...>                check YAML files against their schema
  trace VISP-12 [--results <json>]  follow clauses to criteria, tests and results
  packet VISP-12 [--results <json>] write the owner packet
  jira show|create-task|move|comment ...  Jira as the agent account (writes: clerk only)
  review --task VISP-12/VISP-13 --worktree <dir>  one Codex review round (reviewer only)
  retro VISP-12                     the epic's retro report from the local records (read-only)
  check-pr <n> [--results <json>]   CI gate: spec approved, the task's linked tests pass
  ci-failures <n> --task VISP-13    print a PR's failed checks and log them as mistakes
  sync-status VISP-12               move task tickets forward to match their pull requests
  release-check <version>           fail if Sentry has new issues first seen in that release`;

const [name, ...args] = process.argv.slice(2);
const command = COMMANDS[name];
if (!command) {
  console.error(USAGE);
  process.exit(2);
}
try {
  process.exitCode = await command.run(args);
} catch (error) {
  console.error(`sdlc ${name}: ${error.message}`);
  process.exitCode = 1;
}
