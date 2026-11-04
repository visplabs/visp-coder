// Runs the GitHub CLI. Agent calls use the session's identity (the agent bot, through
// GH_CONFIG_DIR). Owner calls drop it and use the owner's own login; they are made only from
// commands the owner types, so CI can tell an owner's approval from an agent's comment.
// SDLC_GH replaces the gh binary in tests.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function gh(args, { as = "agent" } = {}) {
  return execFileSync(process.env.SDLC_GH ?? "gh", args, {
    encoding: "utf8",
    env: as === "owner" ? ownerEnv() : process.env,
  });
}

export function ghJson(args, options) {
  return JSON.parse(gh(args, options));
}

// Passes `text` through a temporary --body-file, which keeps any characters intact.
export function ghWithBody(args, text, options) {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-gh-"));
  try {
    const file = join(dir, "body.md");
    writeFileSync(file, text);
    return gh([...args, "--body-file", file], options);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function ownerEnv() {
  const env = { ...process.env };
  delete env.GH_CONFIG_DIR;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  if (process.env.SDLC_OWNER_GH_CONFIG_DIR)
    env.GH_CONFIG_DIR = process.env.SDLC_OWNER_GH_CONFIG_DIR;
  return env;
}
