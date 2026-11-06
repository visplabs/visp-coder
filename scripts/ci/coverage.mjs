#!/usr/bin/env node
// `pnpm test:coverage`: the suite with coverage of src/, counting code the tests reach only through
// the CLI, merged into coverage/merged/ (coverage-final.json, lcov.info). Arguments go to vitest,
// so `pnpm test:coverage tests/functional` covers a part.
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const run = (command, args, env = process.env) =>
  spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  }).status ?? 1;

const tests = run("pnpm", ["exec", "vitest", "run", "--coverage", ...process.argv.slice(2)], {
  ...process.env,
  VISP_CHILD_COVERAGE: join("coverage", "children"),
});
const merge = run(process.execPath, [
  "scripts/ci/coverage-merge.mjs",
  "coverage/merged",
  "coverage",
]);
process.exitCode = tests || merge;
