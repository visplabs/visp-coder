import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { collectChildProfiles } = (await import(
  pathToFileURL(join(process.cwd(), "scripts/ci/child-coverage.mjs")).href
)) as {
  collectChildProfiles(
    rawDir: string,
    outFile: string,
    options: { distDir: string; testFile?: string },
  ): boolean;
};

let dir = "";
const dist = () => join(dir, "repo", "dist");
const raw = () => join(dir, "raw");
const out = () => join(dir, "out.json");

function script(url: string, count: number) {
  return {
    scriptId: "1",
    url,
    functions: [
      {
        functionName: "",
        isBlockCoverage: true,
        ranges: [{ startOffset: 0, endOffset: 100, count }],
      },
    ],
  };
}

function writeProfile(name: string, scripts: unknown[]) {
  writeFileSync(join(raw(), name), JSON.stringify({ result: scripts }));
}

describe("collectChildProfiles", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "visp-child-coverage-"));
    mkdirSync(raw());
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps only this repository's dist scripts, merged across processes", () => {
    const cli = pathToFileURL(join(dist(), "cli.js")).href;
    writeProfile("coverage-1.json", [script(cli, 1), script("node:fs", 9)]);
    writeProfile("coverage-2.json", [script(cli, 2), script("file:///elsewhere/dist/cli.js", 4)]);
    expect(
      collectChildProfiles(raw(), out(), { distDir: dist(), testFile: "tests/x.test.ts" }),
    ).toBe(true);
    const merged = JSON.parse(readFileSync(out(), "utf8"));
    expect(merged.testFile).toBe("tests/x.test.ts");
    expect(merged.processes).toBe(2);
    expect(merged.result.map((entry: { url: string }) => entry.url)).toEqual([cli]);
    expect(merged.result[0].functions[0].ranges[0].count).toBe(3);
    expect(existsSync(raw())).toBe(false);
  });

  it("skips a profile still being written and writes nothing when no dist script ran", () => {
    writeFileSync(join(raw(), "coverage-1.json"), '{"result": [');
    writeProfile("coverage-2.json", [script("node:fs", 1)]);
    expect(collectChildProfiles(raw(), out(), { distDir: dist() })).toBe(false);
    expect(existsSync(out())).toBe(false);
    expect(existsSync(raw())).toBe(false);
  });
});
