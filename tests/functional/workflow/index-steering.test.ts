import { afterEach, describe, expect, it } from "vitest";
import { productProject, succeeded } from "../support/product.js";
import type { TestProject } from "../support/project.js";

let project: TestProject | undefined;
afterEach(async () => project?.destroy());
describe("graph retrieval during the product loop", () => {
  it("refreshes useful repository context inside work without a separate index gate", async () => {
    ({ project } = await productProject({
      files: { "src/app.ts": "export function runApp(){return 1;}" },
      definition: {
        outcomes: [{ id: "O001", kind: "functional", statement: "Run the app" }],
        checks: [{ id: "C001", command: ["node", "--test"], outcomes: ["O001"] }],
        slices: [
          {
            id: "T001",
            goal: "Run the app",
            outcomes: ["O001"],
            scope: { allowed: ["src/**"] },
            checks: ["C001"],
          },
        ],
      },
    }));
    const next = project.json<{ command: string }>("next");
    expect(next.envelope.data?.command).toContain("visp work");
    succeeded(project, "work");
    expect(project.run("query", "search", "runApp").exitCode).toBe(0);
  });
  it("authorizes greenfield scope when there is no source yet to index", async () => {
    ({ project } = await productProject({
      files: {},
      definition: {
        outcomes: [{ id: "O001", kind: "functional", statement: "Run the app" }],
        checks: [{ id: "C001", command: ["node", "--test"], outcomes: ["O001"] }],
        slices: [
          {
            id: "T001",
            goal: "Create the first app module",
            outcomes: ["O001"],
            scope: { allowed: ["src/app.ts"] },
            checks: ["C001"],
          },
        ],
      },
    }));
    const work = project.json<{ mayEdit: boolean; files: unknown[] }>("work");
    expect(work.result.exitCode, work.result.stdout).toBe(0);
    expect(work.envelope.data?.mayEdit).toBe(true);
    expect(work.envelope.data?.files).toEqual([]);
    expect(
      project.json<{ allowed: boolean }>("guard", "--path", "src/app.ts").envelope.data?.allowed,
    ).toBe(true);
  });
});
