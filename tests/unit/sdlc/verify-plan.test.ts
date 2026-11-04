import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const { verificationPlan } = (await import(
  pathToFileURL(join(process.cwd(), "scripts/sdlc/lib/verify.mjs")).href
)) as {
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
