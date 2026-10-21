import { afterEach, expect, it } from "vitest";
import { runProductDone, runProductReport } from "../../../../src/workflow/product/index.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace | undefined;
afterEach(async () => {
  await workspace?.destroy();
  workspace = undefined;
});

function value<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

// A human reviewer needs intent, what changed, what ran and what is still open, in one place.
it("gives a human reviewer the request, outcomes, changes, checks, review status and next step", async () => {
  const fixture = await productWorkspace();
  workspace = fixture.workspace;
  value(await runProductWork(await workspace.state(), { task: "T001" }));
  await workspace.write("src/value.mjs", "export const value = 2;\n");
  value(await runProductDone(await workspace.state(), { task: "T001" }));
  // The evidence record leads; the full handoff document follows it with --full.
  const { markdown } = value(await runProductReport(await workspace.state(), { full: true }));
  expect(markdown.indexOf("# Evidence record")).toBe(0);

  expect(markdown).toContain(`# ${fixture.brief.goal}`);
  expect(markdown).toContain("## Request");
  expect(markdown).toContain(`> ${fixture.brief.originalRequest}`);
  expect(markdown).toMatch(/## Outcomes[\s\S]*\| O001 \|/);
  expect(markdown).toMatch(/## Changes[\s\S]*src\/value\.mjs/);
  expect(markdown).toMatch(/## Checks[\s\S]*C001[\s\S]*passed/);
  expect(markdown).toContain("node --test");
  expect(markdown).toMatch(/## Independent review[\s\S]*No independent review/);
  expect(markdown).toContain("## Next");
});
