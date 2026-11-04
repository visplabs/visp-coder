// What the stop hook runs before it accepts a coder's handoff: a fast build, the tests that cover
// the changed code plus the tests the handoff names, and the typecheck. The agent's claims are
// checked by running them, not by reading them.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tail } from "./hook-io.mjs";
import { withLock } from "./lock.mjs";
import { sdlcRoot } from "./paths.mjs";

export function verificationPlan(changed, handoffTests, directTests) {
  const sources = changed.filter((file) => file.startsWith("src/") && file.endsWith(".ts"));
  const tests = new Set([
    ...(sources.length > 0 ? directTests(sources) : []),
    ...handoffTests.map((test) => test.split(" > ")[0]),
    ...changed.filter((file) => file.endsWith(".test.ts")),
  ]);
  const run =
    tests.size > 0 ? [["pnpm", "exec", "vitest", "run", "--bail=1", ...[...tests].sort()]] : [];
  return [["pnpm", "build:fast"], ...run, ["pnpm", "typecheck"]];
}

// Runs the plan in the worktree; returns undefined when every step passes, else why it failed.
export function runVerification(cwd, changed, handoffTests) {
  const directTests = (files) => {
    const result = spawnSync("node", ["scripts/direct-tests.mjs", ...files], {
      cwd,
      encoding: "utf8",
    });
    return result.stdout.split(/\s+/).filter((file) => file && existsSync(join(cwd, file)));
  };
  const plan = verificationPlan(changed, handoffTests, directTests);
  return withLock(join(sdlcRoot(cwd), "run", "heavy.lock"), () => {
    for (const command of plan) {
      const result = spawnSync(command[0], command.slice(1), {
        cwd,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      if (result.status !== 0) {
        return `\`${command.join(" ")}\` failed:\n${tail(`${result.stdout}${result.stderr}`, 40)}`;
      }
    }
    return undefined;
  });
}
