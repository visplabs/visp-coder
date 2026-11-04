#!/usr/bin/env node
// Claude Code PostToolUse hook for Edit, Write and MultiEdit. Runs Biome on the file just
// written and, when it reports errors, tells the agent at once instead of at the next lint run.
// It cannot block: the edit already happened.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { readEvent, respond, tail } from "../lib/hook-io.mjs";
import { repoRoot } from "../lib/paths.mjs";

const CHECKED = /\.(ts|mts|cts|js|mjs|cjs|json)$/;
const biome = join(dirname(fileURLToPath(import.meta.url)), "../../../node_modules/.bin/biome");

const event = await readEvent();
const file = event.tool_input?.file_path;
if (!file || !CHECKED.test(file) || !existsSync(biome)) process.exit(0);

const root = repoRoot(event.cwd);
const result = spawnSync(
  biome,
  [
    "check",
    file,
    "--diagnostic-level=error",
    "--no-errors-on-unmatched",
    "--max-diagnostics=10",
    "--colors=off",
  ],
  { cwd: root, encoding: "utf8" },
);
if (result.status !== 0) {
  respond({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext:
        `Biome reports errors in ${relative(root, file)}. Fix them; "pnpm format" fixes formatting.\n` +
        tail(`${result.stdout}${result.stderr}`, 40),
    },
  });
}
