#!/usr/bin/env node
// Decides whether a branch is kind (a) or kind (b) (AGENTS.md "Quality contract"). Any change
// under tests/golden/__snapshots__ since the merge base with <base> makes it kind (b), and then a
// commit on the branch must say "Kind (b)". This also catches snapshots rewritten by `vitest -u`.
// Usage: node scripts/sdlc/golden-gate.mjs [base, default origin/develop]

import { execFileSync } from "node:child_process";

const SNAPSHOTS = "tests/golden/__snapshots__";
const base = process.argv[2] ?? "origin/develop";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const mergeBase = git("merge-base", base, "HEAD");
const changed = git("diff", "--name-only", mergeBase, "HEAD", "--", SNAPSHOTS)
  .split("\n")
  .filter(Boolean);

if (changed.length === 0) {
  console.log("golden gate: snapshots unchanged, kind (a)");
  process.exit(0);
}
if (/kind \(b\)/i.test(git("log", "--format=%B", `${mergeBase}..HEAD`))) {
  console.log(`golden gate: ${changed.length} snapshot(s) changed, declared kind (b)`);
  process.exit(0);
}
console.error(
  `golden gate: ${changed.length} snapshot(s) changed but no commit says "Kind (b)".\n` +
    "A changed snapshot means agents see something different. Say which snapshots changed and\n" +
    "why in a commit body, or revert them if the change was meant to be kind (a):",
);
for (const file of changed.slice(0, 20)) console.error(`  ${file}`);
if (changed.length > 20) console.error(`  ... and ${changed.length - 20} more`);
process.exit(1);
