#!/usr/bin/env node
// Records how long each test file takes, for tests/shard-sequencer.ts to balance CI shards. Use
// the reports of a green develop run, so the times are CI times:
//   gh run download <run id> --pattern 'test-timings-*' --dir timings
//   node scripts/ci/shard-timings.mjs timings/*/*.json
// Rerun it when the `test` shards of a run differ by more than a minute.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const reports = process.argv.slice(2);
if (reports.length === 0) {
  console.error("usage: node scripts/ci/shard-timings.mjs <vitest json report>...");
  process.exit(2);
}

const files = reports.flatMap(
  (report) => JSON.parse(readFileSync(report, "utf8")).testResults ?? [],
);
const timings = Object.fromEntries(
  files
    .map((file) => [repoPath(file.name), Math.round((file.endTime - file.startTime) / 100) / 10])
    .sort(([a], [b]) => a.localeCompare(b)),
);
writeFileSync(join(root, "tests/shard-timings.json"), `${JSON.stringify(timings, null, 2)}\n`);
console.log(`recorded ${Object.keys(timings).length} test files`);

// Reports from CI name files under the runner's checkout, so the path is cut at `tests/`.
function repoPath(name) {
  const path = name.replaceAll("\\", "/");
  return path.slice(path.indexOf("/tests/") + 1);
}
