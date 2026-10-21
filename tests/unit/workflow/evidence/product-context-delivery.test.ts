import { afterEach, beforeEach, expect, it } from "vitest";
import type { Result } from "../../../../src/core/result.js";
import { updateProductBrief } from "../../../../src/workflow/product/brief.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import {
  type ProductWorkContext,
  runProductContext,
  runProductWork,
} from "../../../../src/workflow/product/work.js";
import { compactProductReply } from "../../../../src/workflow/product-compact-text.js";
import { productWorkspace } from "../../support/product-workspace.js";

/**
 * Re-authorizing an unchanged slice repeated the whole context pack. Only the worker knows
 * whether an earlier reply is still in its view (hosts keep one MCP server across chats,
 * /clear and compaction), so leaving material out is opt-in: every reply names its pack with a
 * contextId, and only a `work` that passes it back as `known` gets the unchanged reference
 * sections left out. Without it, or after the slice's contract changed, the full pack is sent.
 */
let setup: Awaited<ReturnType<typeof productWorkspace>>;

beforeEach(async () => {
  setup = await productWorkspace();
});

afterEach(async () => {
  await setup.workspace.destroy();
});

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const work = async (known?: string) =>
  value(
    await runProductWork(await setup.workspace.state(), {
      task: "T001",
      ...(known ? { known } : {}),
    }),
  );

const pack = (context: ProductWorkContext) => ({ files: context.files.length });

it("sends the full pack on every repeat unless the worker names an earlier reply", async () => {
  const first = await work();
  expect(first.contextId).toMatch(/^[a-f0-9]{12}$/);
  expect(first.files.length).toBeGreaterThan(0);
  const again = await work();
  expect(pack(again)).toEqual(pack(first));
  expect(again.delivery).toBeUndefined();
  expect(again.contextId).toBe(first.contextId);
  expect(compactProductReply("work", again, "cli")).toContain(`"contextId":"${first.contextId}"`);
});

it("leaves out what is unchanged since the reply the worker names", async () => {
  const first = await work();
  const known = await work(first.contextId);
  expect(pack(known)).toEqual({ files: 0 });
  expect(known.delivery).toEqual({ known: first.contextId, unchanged: ["files"] });
  // Never left out: the request, outcomes, scope, checks and findings.
  expect(known.originalRequest).toBe(first.originalRequest);
  expect(known.outcomes).toEqual(first.outcomes);
  expect(known.scope).toEqual(first.scope);
  expect(known.checks).toEqual(first.checks);
  expect(known.feedbackPlan).toEqual(first.feedbackPlan);
  expect(known.budget.estimatedTokens).toBeLessThan(first.budget.estimatedTokens);
  expect(compactProductReply("work", known, "cli")).toContain(
    `Source excerpts from your earlier visp work reply (context ${first.contextId}) are not repeated. If you don't have them in view, call visp work again without --known.`,
  );
  expect(compactProductReply("visp_work", known, "mcp")).toContain(
    `from your earlier visp_work reply (context ${first.contextId}) are not repeated. If you don't have them in view, call visp_work again without known.`,
  );

  // A changed excerpt is sent again.
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  const changed = await work(first.contextId);
  expect(changed.files.length).toBeGreaterThan(0);
  expect(changed.delivery).toBeUndefined();

  // Reading the context never leaves anything out.
  const inspected = value(await runProductContext(await setup.workspace.state(), { task: "T001" }));
  expect(pack(inspected)).toEqual(pack(first));
  expect(inspected.delivery).toBeUndefined();
});

it("sends everything when the named reply is unknown or the brief changed since", async () => {
  const first = await work();
  const unknown = await work("0123456789ab");
  expect(pack(unknown)).toEqual(pack(first));
  expect(unknown.delivery).toBeUndefined();

  const record = value(await readProductRecord(await setup.workspace.state()));
  value(
    await updateProductBrief(await setup.workspace.state(), {
      brief: {
        ...record.brief,
        slices: record.brief.slices.map((slice) => ({
          ...slice,
          goal: `${slice.goal}, as the public module's value`,
        })),
      },
      reason: "Name the module in the slice goal",
    }),
  );
  const revised = await work(first.contextId);
  expect(revised.files.length).toBeGreaterThan(0);
  expect(revised.delivery).toBeUndefined();
  expect(revised.contextId).not.toBe(first.contextId);
});

// Work moved to another branch: the feature follows it, so `visp pr` and CI find it there.
it("records the branch a slice is worked on when it moved", async () => {
  await work();
  setup.workspace.git("switch", "-q", "-c", "feature/value-two");
  await work();
  const state = await setup.workspace.state();
  const record = value(await readProductRecord(state));
  const intent = value(await state.store.readIntent(record.brief.feature));
  expect(intent.branch).toBe("feature/value-two");
});
