#!/usr/bin/env node
// Claude Code WorktreeCreate hook. Claude Code's default worktree starts from the remote's
// default branch (main); SDLC work starts from sdlc.config.json's baseBranch, the same branch
// the stop hook diffs against. This hook fetches origin, adds .claude/worktrees/<name> on a new
// branch sdlc/<name> from origin/<baseBranch> (SDLC_BASE overrides it),
// installs and builds, and prints the path as its last line. It replaces git's default for every
// worktree Claude Code creates, so it is registered only in the owner's settings.local.json.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { loadConfig } from "../lib/config.mjs";
import { readEvent } from "../lib/hook-io.mjs";

const event = await readEvent({ ownerOnly: false });
const name = String(event.name ?? "");
if (!/^[A-Za-z0-9._-]+$/.test(name)) fail(`unexpected worktree name "${name}"`);

const base = process.env.SDLC_BASE ?? baseBranch();
const main = dirname(
  capture("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], event.cwd),
);
const path = join(main, ".claude", "worktrees", name);
run("git", ["fetch", "--quiet", "origin", base], main);
run("git", ["worktree", "add", "--quiet", "-b", `sdlc/${name}`, path, `origin/${base}`], main);
if (process.env.SDLC_WORKTREE_SETUP !== "0") {
  run("pnpm", ["install", "--frozen-lockfile"], path);
  run("pnpm", ["build:fast"], path);
}
process.stdout.write(`${path}\n`);

// Child output goes to stderr: Claude Code reads the last stdout line as the path.
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: ["ignore", 2, 2] });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed`);
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function fail(message) {
  console.error(`sdlc worktree: ${message}`);
  process.exit(1);
}

function baseBranch() {
  try {
    return loadConfig(event.cwd).baseBranch;
  } catch {
    return "develop";
  }
}
