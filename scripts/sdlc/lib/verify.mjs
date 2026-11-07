// What the stop hook runs before it accepts a coder's handoff: a fast build, the tests that cover
// the changed code plus the tests the handoff names, and the typecheck. The agent's claims are
// checked by running them, not by reading them.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { tail } from "./hook-io.mjs";
import { withLock } from "./lock.mjs";
import { sdlcRoot } from "./paths.mjs";
import { resultsIndex } from "./trace.mjs";

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

// Runs the plan in the worktree; returns { ran, results } when every step passes (results: each
// test's status by its "<path> > <describe> > <title>" name), else { failed } with why. Tests run with VISP_CHILD_COVERAGE set, as in CI, because child coverage changes the
// environment the code under test sees (NODE_V8_COVERAGE): pilot 1 shipped a test that passed
// here and failed in CI for that reason.
export function runVerification(cwd, changed, handoffTests) {
  const directTests = (files) => {
    const result = spawnSync("node", ["scripts/direct-tests.mjs", ...files], {
      cwd,
      encoding: "utf8",
    });
    return result.stdout.split(/\s+/).filter((file) => file && existsSync(join(cwd, file)));
  };
  const plan = verificationPlan(changed, handoffTests, directTests);
  const coverage = mkdtempSync(join(tmpdir(), "sdlc-child-coverage-"));
  const env = { ...process.env, VISP_CHILD_COVERAGE: coverage };
  const report = join(coverage, "results.json");
  const json = ["--reporter=default", "--reporter=json", `--outputFile.json=${report}`];
  try {
    return withLock(join(sdlcRoot(cwd), "run", "heavy.lock"), () => {
      for (const command of plan) {
        const args = command[2] === "vitest" ? [...command.slice(1), ...json] : command.slice(1);
        const result = spawnSync(command[0], args, {
          cwd,
          env,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        });
        if (result.status !== 0) {
          const output = tail(`${result.stdout}${result.stderr}`, 40);
          return { failed: `\`${command.join(" ")}\` failed:\n${output}` };
        }
      }
      const results = existsSync(report)
        ? resultsIndex(JSON.parse(readFileSync(report, "utf8")), cwd)
        : new Map();
      return { ran: plan.map((command) => command.join(" ")), results };
    });
  } finally {
    rmSync(coverage, { recursive: true, force: true });
  }
}

// The last passing run for a task, kept so the review packet can say what passed at which commit:
// Codex's sandbox breaks child-process output, so it cannot run the tests itself.
export function recordVerified(cwd, { feature, task }, commit, ran) {
  const path = verifiedPath(cwd, feature, task);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ commit, ran, at: new Date().toISOString() }));
}

export function verifiedRun(cwd, { feature, task }) {
  const path = verifiedPath(cwd, feature, task);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}

function verifiedPath(cwd, feature, task) {
  return join(sdlcRoot(cwd), "run", "verified", feature, `${task}.json`);
}
