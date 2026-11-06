import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

const TIMINGS = "tests/shard-timings.json";

/**
 * Splits test files across CI shards by recorded duration instead of vitest's hash order, which
 * left one shard at 213 s and another at 411 s. Every shard computes the same split and keeps its
 * own part. `node scripts/ci/shard-timings.mjs` records the durations.
 */
export default class ShardSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config;
    if (!shard) return files;
    const byPath = new Map(files.map((spec) => [testPath(root, spec), spec]));
    const parts = splitByDuration([...byPath.keys()], readTimings(root), shard.count);
    return (parts[shard.index - 1] ?? []).flatMap((path) => byPath.get(path) ?? []);
  }
}

/**
 * Longest first, each file to the least-loaded part. A file with no recorded time counts as the
 * median of the files that have one, so a new test lands somewhere sensible until it is recorded.
 */
export function splitByDuration(
  paths: string[],
  timings: Record<string, number>,
  count: number,
): string[][] {
  const fallback = median(paths.flatMap((path) => timings[path] ?? []));
  const weighted = paths
    .map((path) => ({ path, seconds: timings[path] ?? fallback }))
    .sort((a, b) => b.seconds - a.seconds || a.path.localeCompare(b.path));
  const loads: number[] = Array.from({ length: count }, () => 0);
  const parts: string[][] = Array.from({ length: count }, () => []);
  for (const { path, seconds } of weighted) {
    const target = loads.indexOf(Math.min(...loads));
    loads[target] = (loads[target] ?? 0) + seconds;
    parts[target]?.push(path);
  }
  return parts;
}

function testPath(root: string, spec: TestSpecification): string {
  return relative(root, spec.moduleId).split(sep).join("/");
}

function readTimings(root: string): Record<string, number> {
  try {
    return JSON.parse(readFileSync(join(root, TIMINGS), "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 1;
}
