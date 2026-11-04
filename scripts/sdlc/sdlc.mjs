#!/usr/bin/env node
// Commands for the agent SDLC. See CONTRIBUTING.md ("Agent SDLC").

import * as packet from "./commands/packet.mjs";
import * as pull from "./commands/pull.mjs";
import * as trace from "./commands/trace.mjs";
import * as validate from "./commands/validate.mjs";

const COMMANDS = { pull, validate, trace, packet };
const USAGE = `usage: sdlc <command>
  pull F-12                         cache the spec blocks of feature issue #12
  validate <file...>                check YAML files against their schema
  trace F-12 [--results <json>]     follow clauses to criteria, tests and results
  packet F-12 [--results <json>]    write the owner packet`;

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
