import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Result } from "../../../../src/core/result.js";
import { runProductAccept, runProductDone } from "../../../../src/workflow/product/evidence.js";
import { createProductFeature } from "../../../../src/workflow/product/feature-create.js";
import { unchangedInheritedPaths } from "../../../../src/workflow/product/inherited-changes.js";
import { runProductReview } from "../../../../src/workflow/product/review/review.js";
import { runProductNext, runProductStatus } from "../../../../src/workflow/product/status.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { moduleFeedback } from "../../support/product-feedback.js";
import { productWorkspace } from "../../support/product-workspace.js";

/**
 * Bench run co1-conventions-carryover-prose-visp-dev-1: a Haiku worker accepted its feature
 * and, as Claude Code commits only when the user asks, left it uncommitted. The next
 * session's `visp feature` refused the uncommitted files, `visp next` reported the old
 * feature complete, and the worker stopped with the new request unbuilt.
 */
let project: Awaited<ReturnType<typeof productWorkspace>>;
beforeEach(async () => {
  project = await productWorkspace();
});
afterEach(async () => {
  await project.workspace.destroy();
});

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

const state = () => project.workspace.state();

async function acceptUncommitted(): Promise<void> {
  value(await runProductWork(await state()));
  await project.workspace.write("src/value.mjs", "export const value = 2;\n");
  expect(value(await runProductDone(await state())).closed).toBe(true);
  const bundle = value(await runProductReview(await state()));
  value(
    await runProductReview(await state(), {
      subjectDigest: bundle.subjectDigest,
      feedback: moduleFeedback(bundle),
      assessments: [
        {
          outcome: "O001",
          status: "satisfied",
          summary: "The executed check observed the value two",
          evidence: ["C001"],
        },
      ],
    }),
  );
  expect(value(await runProductAccept(await state())).passed).toBe(true);
}

const prompt = (at: string, text: string) =>
  project.workspace.write(
    ".visp/session/user-prompts.jsonl",
    `${JSON.stringify({ at, prompt: text })}\n`,
  );

it("starts the next feature from the accepted feature's uncommitted work, without committing it", async () => {
  await acceptUncommitted();
  const head = project.workspace.git("rev-parse", "HEAD");
  const started = value(
    await createProductFeature(await state(), { goal: "Return three as well" }),
  );
  expect(started.inheritedChanges).toEqual(["src/value.mjs"]);
  expect(started.inheritedChangesNote).toContain(project.brief.feature);
  expect(started.inheritedChangesNote).toContain("Never discard them");
  expect(project.workspace.git("rev-parse", "HEAD")).toBe(head);
  // The accepted work is the new feature's starting point, not its change.
  expect([...(await unchangedInheritedPaths(await state(), started.brief.feature))]).toEqual([
    "src/value.mjs",
  ]);
  const report = value(await runProductStatus(await state())).report;
  expect(report).toContain("No uncommitted changes; review the commits for this feature.");
  expect(report).toContain("Uncommitted before this feature started, unchanged since:");
  expect(await readFile(join(project.workspace.root, "src/value.mjs"), "utf8")).toBe(
    "export const value = 2;\n",
  );
});

it.each([
  {
    case: "an accepted file edited after acceptance",
    path: "src/value.mjs",
    text: "export const value = 5;\n",
  },
  { case: "a file added after acceptance", path: "notes.txt", text: "mine\n" },
])("still asks to commit $case", async ({ path, text }) => {
  await acceptUncommitted();
  await project.workspace.write(path, text);
  const started = await createProductFeature(await state(), { goal: "Return three as well" });
  expect(!started.ok && started.error.message).toContain("committed baseline");
  expect(await readFile(join(project.workspace.root, path), "utf8")).toBe(text);
});

it("sends a request recorded after acceptance to a feature of its own", async () => {
  await acceptUncommitted();
  await prompt(new Date(Date.now() + 1000).toISOString(), "Also return three");
  const next = value(await runProductNext(await state()));
  expect(next).toMatchObject({
    action: "understand",
    command: `visp feature "<the user's request>"`,
    mayEdit: false,
  });
  expect(next.objective).toContain(`${project.brief.feature} was accepted`);
  const worked = await runProductWork(await state(), { check: "node --test" });
  expect(!worked.ok && worked.error).toMatchObject({
    message: expect.stringContaining(`${project.brief.feature} was accepted`),
    recovery: `visp feature "<the user's request>"`,
  });
  // A worker that names the feature has chosen to continue it.
  expect(
    value(await runProductNext(await state(), { feature: project.brief.feature })).action,
  ).toBe("complete");
});

it("keeps an accepted feature complete for prompts recorded before its acceptance", async () => {
  await prompt("2026-01-01T00:00:00.000Z", "Also keep it fast");
  await acceptUncommitted();
  expect(value(await runProductNext(await state())).action).toBe("complete");
});
