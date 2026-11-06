import { mkdirSync, mkdtempSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, expect } from "vitest";

/**
 * With VISP_CHILD_COVERAGE set (by `pnpm test:coverage`), node processes a test file starts write
 * V8 coverage, so code the tests reach only through the CLI in dist/ is counted too. The value of
 * NODE_V8_COVERAGE stays the same for the whole file, because VISP treats NODE_ variables as part
 * of a check's toolchain identity. Processes a test kills write nothing.
 */
const target = process.env.VISP_CHILD_COVERAGE;
if (target) {
  const root = resolve(import.meta.dirname, "..");
  const out = resolve(root, target);
  mkdirSync(out, { recursive: true });
  const raw = mkdtempSync(join(out, "raw-"));
  process.env.NODE_V8_COVERAGE = raw;
  afterAll(async () => {
    const testPath = expect.getState().testPath;
    const { collectChildProfiles } = (await import(
      pathToFileURL(join(root, "scripts/ci/child-coverage.mjs")).href
    )) as {
      collectChildProfiles(
        rawDir: string,
        outFile: string,
        options: { distDir: string; testFile?: string },
      ): boolean;
    };
    collectChildProfiles(raw, join(out, `${basename(raw).slice(4)}.json`), {
      distDir: join(root, "dist"),
      ...(testPath ? { testFile: relative(root, testPath) } : {}),
    });
  });
}
