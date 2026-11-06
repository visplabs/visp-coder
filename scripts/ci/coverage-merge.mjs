#!/usr/bin/env node
// Merges coverage of a test run, or of several shards, into one report:
//   node scripts/ci/coverage-merge.mjs <out dir> <part dir>...
// A part dir holds vitest's coverage-final.json and the per-test-file profiles that
// tests/child-coverage.ts wrote under children/. The child profiles are merged, converted once
// per dist/ script through its source map, and added to vitest's own coverage. Vitest maps each
// src file through its own transform and the bundle through esbuild, so the two agree on what the
// branches, statements and functions are but not always on their exact columns: they are paired
// by type and line, and anything left unpaired is dropped and reported, never added. The result
// can undercount coverage, but never invent it. Writes coverage-final.json and lcov.info.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import v8Coverage from "@bcoe/v8-coverage";
import convert from "ast-v8-to-istanbul";
import libCoverage from "istanbul-lib-coverage";
import { parseAstAsync } from "vitest/node";
import { addPaired } from "./coverage-pairing.mjs";

const root = resolve(fileURLToPath(import.meta.url), "../../..");

async function main([outDir, ...parts]) {
  if (!outDir || parts.length === 0) {
    console.error("usage: node scripts/ci/coverage-merge.mjs <out dir> <part dir>...");
    return 2;
  }
  const base = libCoverage.createCoverageMap({});
  for (const part of parts)
    base.merge(JSON.parse(readFileSync(join(part, "coverage-final.json"), "utf8")));
  const child = await childCoverage(parts.flatMap((part) => profileFiles(join(part, "children"))));
  const dropped = { branches: 0, statements: 0, functions: 0 };
  for (const file of base.files()) {
    if (!child[file]) continue;
    const counts = addPaired(base.fileCoverageFor(file).data, child[file]);
    for (const kind of Object.keys(dropped)) dropped[kind] += counts[kind];
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "coverage-final.json"), JSON.stringify(base.toJSON()));
  writeFileSync(join(outDir, "lcov.info"), lcov(base));
  report(base, dropped);
  return 0;
}

function profileFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(dir, name));
}

async function childCoverage(files) {
  if (files.length === 0) return {};
  const merged = v8Coverage.mergeProcessCovs(
    files.map((file) => ({ result: JSON.parse(readFileSync(file, "utf8")).result })),
  );
  const map = libCoverage.createCoverageMap({});
  for (const script of merged.result) {
    const path = fileURLToPath(script.url);
    if (!existsSync(`${path}.map`)) continue;
    const code = readFileSync(path, "utf8");
    map.merge(
      await convert({
        code,
        sourceMap: JSON.parse(readFileSync(`${path}.map`, "utf8")),
        ast: await parseAstAsync(code),
        coverage: { functions: script.functions, url: script.url },
      }),
    );
  }
  return map.toJSON();
}

function lcov(map) {
  return map
    .files()
    .sort()
    .map((file) => lcovRecord(relative(root, file), map.fileCoverageFor(file)))
    .join("");
}

function lcovRecord(path, coverage) {
  const { fnMap, f, branchMap, b } = coverage.data;
  const lines = [`TN:`, `SF:${path}`];
  const fns = Object.keys(fnMap);
  for (const id of fns) lines.push(`FN:${fnMap[id].decl.start.line},${fnMap[id].name}`);
  for (const id of fns) lines.push(`FNDA:${f[id]},${fnMap[id].name}`);
  lines.push(`FNF:${fns.length}`, `FNH:${fns.filter((id) => f[id] > 0).length}`);
  const lineHits = Object.entries(coverage.getLineCoverage());
  for (const [line, hits] of lineHits) lines.push(`DA:${line},${hits}`);
  lines.push(`LF:${lineHits.length}`, `LH:${lineHits.filter(([, hits]) => hits > 0).length}`);
  let found = 0;
  let hit = 0;
  for (const id of Object.keys(branchMap)) {
    const line = branchMap[id].loc?.start.line ?? branchMap[id].locations[0].start.line;
    b[id].forEach((taken, arm) => {
      lines.push(`BRDA:${line},${id},${arm},${taken}`);
      found += 1;
      if (taken > 0) hit += 1;
    });
  }
  lines.push(`BRF:${found}`, `BRH:${hit}`, "end_of_record");
  return `${lines.join("\n")}\n`;
}

function report(map, dropped) {
  const summary = map.getCoverageSummary().toJSON();
  for (const kind of ["branches", "statements", "functions", "lines"]) {
    const { covered, total, pct } = summary[kind];
    console.log(`${kind.padEnd(10)} ${pct}% (${covered}/${total})`);
  }
  console.log(
    `unpaired child entries dropped: ${dropped.branches} branches, ${dropped.statements} statements, ${dropped.functions} functions`,
  );
}

process.exitCode = await main(process.argv.slice(2));
