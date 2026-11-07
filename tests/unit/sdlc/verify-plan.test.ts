import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type SdlcRepo, sdlcRepo } from "./support/sdlc-repo.js";

const { runVerification, verificationPlan } = (await import(
  pathToFileURL(join(process.cwd(), "scripts/sdlc/lib/verify.mjs")).href
)) as {
  runVerification(
    cwd: string,
    changed: string[],
    handoffTests: string[],
  ): { failed?: string; ran?: string[] };
  verificationPlan(
    changed: string[],
    handoffTests: string[],
    directTests: (files: string[]) => string[],
  ): string[][];
};

const direct = (files: string[]) =>
  files.includes("src/core/exec.ts") ? ["tests/unit/core/exec.test.ts"] : [];

describe("verification plan", () => {
  it("builds, runs direct and named tests once each, then typechecks", () => {
    const plan = verificationPlan(
      ["src/core/exec.ts", "tests/unit/core/paths.test.ts", "README.md"],
      ["tests/unit/core/exec.test.ts > exec > runs", "tests/unit/core/fs.test.ts > fs > reads"],
      direct,
    );
    expect(plan).toEqual([
      ["pnpm", "build:fast"],
      [
        "pnpm",
        "exec",
        "vitest",
        "run",
        "--bail=1",
        "tests/unit/core/exec.test.ts",
        "tests/unit/core/fs.test.ts",
        "tests/unit/core/paths.test.ts",
      ],
      ["pnpm", "typecheck"],
    ]);
  });

  it("skips the test run when nothing testable changed", () => {
    expect(verificationPlan(["docs/x.md"], [], direct)).toEqual([
      ["pnpm", "build:fast"],
      ["pnpm", "typecheck"],
    ]);
  });
});

describe("running the verification", () => {
  let fixture: SdlcRepo | undefined;
  const path = process.env.PATH;
  afterEach(() => {
    process.env.PATH = path;
    fixture?.cleanup();
  });

  // Puts first on PATH a pnpm that logs each call with the child-coverage folder it was given.
  function fakePnpm(exitCode = 0) {
    fixture = sdlcRepo();
    const log = join(fixture.repo, "..", "pnpm.log");
    const stub = `#!/bin/sh\necho "$* | \${VISP_CHILD_COVERAGE:-none}" >> ${log}\nexit ${exitCode}\n`;
    fixture.write("../bin/pnpm", stub);
    chmodSync(join(fixture.repo, "..", "bin", "pnpm"), 0o755);
    process.env.PATH = `${join(fixture.repo, "..", "bin")}:${path}`;
    return { repo: fixture.repo, log };
  }

  it("runs the tests with child coverage on, as CI does, and lists what ran", () => {
    const { repo, log } = fakePnpm();
    const result = runVerification(repo, ["tests/unit/x.test.ts"], []);
    expect(result.failed).toBeUndefined();
    expect(result.ran).toEqual([
      "pnpm build:fast",
      "pnpm exec vitest run --bail=1 tests/unit/x.test.ts",
      "pnpm typecheck",
    ]);
    const vitest = readFileSync(log, "utf8")
      .split("\n")
      .find((line) => line.includes("vitest"));
    expect(vitest).not.toMatch(/\| none$/);
  });

  it("says which command failed", () => {
    const { repo } = fakePnpm(1);
    expect(runVerification(repo, ["docs/x.md"], []).failed).toContain("`pnpm build:fast` failed");
  });
});
