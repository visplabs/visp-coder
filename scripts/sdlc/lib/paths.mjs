// Where SDLC artifacts live. `.sdlc/` sits in the main checkout, found through git's common
// directory, so every worktree of the repository reads and writes the same artifacts.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { workKey } from "../schemas/spec.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

export function repoRoot(cwd = process.cwd()) {
  return git(cwd, "rev-parse", "--show-toplevel");
}

export function sdlcRoot(cwd = process.cwd()) {
  return join(
    dirname(git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")),
    ".sdlc",
  );
}

// The key comes from the owner, an agent or Jira's answer; only a real key names a folder, so
// none can point outside .sdlc/features.
export function featureDir(feature, cwd = process.cwd()) {
  return join(sdlcRoot(cwd), "features", parseFeature(feature));
}

export function parseFeature(value) {
  if (!workKey.test(value ?? "")) {
    throw new Error(`expected the epic's Jira key, like VISP-12, got "${value ?? ""}"`);
  }
  return value;
}

// UTC time as YYYYMMDDTHHMMSSZ, safe in file names on every platform.
export function stamp(date = new Date()) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}
