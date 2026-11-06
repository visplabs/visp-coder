// Runs the GitHub CLI for the CI check (pr-check.mjs), with the session's identity. SDLC_GH
// replaces the gh binary in tests.

import { execFileSync } from "node:child_process";

export function gh(args) {
  return execFileSync(process.env.SDLC_GH ?? "gh", args, { encoding: "utf8" });
}

export function ghJson(args) {
  return JSON.parse(gh(args));
}
