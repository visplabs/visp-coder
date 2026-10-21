import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProductBrief } from "../../../src/workflow/product/model.js";
import { productProject } from "../support/product.js";
import type { TestProject } from "../support/project.js";

let project: TestProject, feature: string;
beforeEach(async () => {
  ({ project, feature } = await productProject({
    files: {
      "src/auth/token.ts": "export function makeToken(user: string) { return user + '-token'; }",
      "src/auth/login.ts":
        "import {makeToken} from './token.js'; export function login(u:string){return makeToken(u);}",
      "src/billing.ts": "export function invoice(){return 1;}",
      "tests/token.test.ts":
        "import {makeToken} from '../src/auth/token.js'; import {test} from 'node:test';test('token',()=>makeToken('a'));",
    },
    definition: {
      outcomes: [{ id: "O001", kind: "functional", statement: "Tokens support login" }],
      checks: [
        {
          id: "C001",
          command: [process.execPath, "--version"],
          outcomes: ["O001"],
          files: ["tests/token.test.ts"],
        },
      ],
      slices: [
        {
          id: "T001",
          goal: "Harden the existing token helper",
          outcomes: ["O001"],
          scope: { allowed: ["src/auth/token.ts"] },
          checks: ["C001"],
        },
      ],
    },
  }));
});
afterEach(async () => project?.destroy());
describe("bounded repository context", () => {
  it("delivers selected source and relevant tests without granting neighboring edit scope", () => {
    const work = project.json<{
      files: { path: string }[];
      scope: { allowed: string[] };
    }>("work");
    expect(work.result.exitCode, work.result.stdout).toBe(0);
    expect(work.envelope.data?.files.map((file) => file.path)).toContain("src/auth/token.ts");
    expect(work.envelope.data?.files.map((file) => file.path)).toContain("tests/token.test.ts");
    expect(work.envelope.data?.files.map((file) => file.path)).not.toContain("src/billing.ts");
    expect(work.envelope.data?.scope.allowed).toEqual(["src/auth/token.ts"]);
    expect(
      project.json<{ allowed: boolean }>("guard", "--path", "src/auth/login.ts").envelope.data
        ?.allowed,
    ).toBe(false);
  });
  it("includes newly created declared files when a previous graph already exists", async () => {
    project.run("work");
    await project.write(
      "src/auth/new-token.ts",
      "export function parseNewToken(value:string){return value;}",
    );
    const brief = project.json<ProductBrief>("brief").envelope.data;
    if (!brief) throw new Error("Missing brief");
    await project.authorBrief(
      feature,
      {
        slices: brief.slices.map((slice) => ({
          ...slice,
          scope: { ...slice.scope, allowed: [...slice.scope.allowed, "src/auth/new-token.ts"] },
        })),
      },
      "Add the selected parser",
    );
    const work = project.json<{ files: { path: string }[] }>("work");
    expect(work.result.exitCode, work.result.stdout).toBe(0);
    expect(work.envelope.data?.files.map((file) => file.path)).toContain("src/auth/new-token.ts");
  });
  it("bounds actual delivered source and identifies truncation", async () => {
    await project.write(
      "src/auth/token.ts",
      `export const token = 1;\n${"// detail\n".repeat(10000)}`,
    );
    const work = project.json<{
      files: { path: string; content: string; truncated: boolean }[];
      notes: string[];
    }>("work");
    expect(work.result.exitCode, work.result.stdout).toBe(0);
    const file = work.envelope.data?.files.find((entry) => entry.path === "src/auth/token.ts");
    expect(file?.truncated).toBe(true);
    expect(file?.content.length).toBeLessThanOrEqual(6000);
    expect(work.result.stdout.length).toBeLessThan(40000);
  });
});
