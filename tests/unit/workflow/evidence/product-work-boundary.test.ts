import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vispError } from "../../../../src/core/errors.js";
import { err, type Result } from "../../../../src/core/result.js";
import * as graph from "../../../../src/graph/index.js";
import { registerEvidenceTools } from "../../../../src/mcp/tools/evidence.js";
import { outcomeStatuses } from "../../../../src/workflow/product/assessment.js";
import {
  createProductFeature,
  runProductDone,
  runProductNext,
  runProductReview,
  runProductVerify,
  updateProductBrief,
} from "../../../../src/workflow/product/index.js";
import type { ProductBrief } from "../../../../src/workflow/product/model.js";
import { productRefinement } from "../../../../src/workflow/product/refinement.js";
import {
  authorizationPath,
  productStatePath,
  readProductRecord,
} from "../../../../src/workflow/product/store.js";
import { runProductContext, runProductWork } from "../../../../src/workflow/product/work.js";
import { runJson } from "../../cli/support/cli.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace;
let brief: ProductBrief;
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
beforeEach(async () => {
  ({ workspace, brief } = await productWorkspace());
});
afterEach(async () => {
  vi.restoreAllMocks();
  await workspace.destroy();
});
async function bytes() {
  const state = await workspace.state();
  return {
    state: await readFile(productStatePath(state, brief.feature), "utf8"),
    auth: value(await state.files.readTextIfExists(authorizationPath(state, brief.feature))),
  };
}
async function revise(next: ProductBrief) {
  brief = value(
    await updateProductBrief(await workspace.state(), {
      brief: next,
      reason: "Refine the next bounded implementation",
    }),
  );
}
async function closeSlice() {
  value(await runProductWork(await workspace.state()));
  await workspace.write("src/value.mjs", "export const value = 2;\n");
  expect(value(await runProductDone(await workspace.state())).closed).toBe(true);
}

describe("product work authorization boundaries", () => {
  it("reads useful context without authorizing, indexing, or rewriting evidence", async () => {
    const before = await bytes();
    const refresh = vi.spyOn(graph, "refreshRepository");
    const context = value(await runProductContext(await workspace.state()));
    expect(context).toMatchObject({ task: "T001", mayEdit: false });
    expect(context.files).toContainEqual(
      expect.objectContaining({ path: "src/value.mjs", content: "export const value = 1;\n" }),
    );
    expect(refresh).not.toHaveBeenCalled();
    expect(await bytes()).toEqual(before);
    value(await runProductWork(await workspace.state()));
    const authorized = await bytes();
    expect(value(await runProductContext(await workspace.state())).mayEdit).toBe(true);
    expect(await bytes()).toEqual(authorized);
  });

  it("rejects unknown explicit selections without touching authorization", async () => {
    const before = await bytes();
    const state = await workspace.state();
    for (const operation of [runProductContext, runProductWork]) {
      expect(await operation(state, { task: "T999" })).toMatchObject({
        ok: false,
        error: { code: "TASK_NOT_FOUND" },
      });
      expect(await operation(state, { feature: "999-missing" })).toMatchObject({
        ok: false,
        error: { code: "ARTIFACT_MISSING" },
      });
    }
    expect(await bytes()).toEqual(before);
  });

  it("recovers a stale saved slice without granting edits until work is requested", async () => {
    const before = await bytes();
    const state = await workspace.state();
    const stale = {
      ...state,
      status: state.status ? { ...state.status, activeTask: "T999" } : undefined,
    };
    expect(value(await runProductContext(stale))).toMatchObject({
      task: "T001",
      mayEdit: false,
    });
    expect(await bytes()).toEqual(before);
    const work = value(await runProductWork(stale));
    expect(work).toMatchObject({ task: "T001", mayEdit: true });
    expect(work.notes.join()).toContain("T999");
    const after = await bytes();
    expect(after.auth && JSON.parse(after.auth)).toMatchObject({ task: "T001" });
  });

  it("leaves a feature without a next slice incomplete instead of granting broad scope", async () => {
    const created = value(
      await createProductFeature(await workspace.state(), { goal: "Next unknown behavior" }),
    );
    brief = created.brief;
    const before = await bytes();
    for (const operation of [runProductContext, runProductWork])
      expect(await operation(await workspace.state())).toMatchObject({
        ok: false,
        error: { code: "NO_ACTIVE_TASK" },
      });
    expect(await bytes()).toEqual(before);
  });

  it.each(["incomplete draft", "empty scope", "unlinked outcome"])(
    "refuses %s before authorizing source changes",
    async (scenario) => {
      await revise({
        ...brief,
        incomplete: scenario === "incomplete draft",
        slices: brief.slices.map((slice) => ({
          ...slice,
          outcomes: scenario === "unlinked outcome" ? [] : slice.outcomes,
          scope: scenario === "empty scope" ? { ...slice.scope, allowed: [] } : slice.scope,
        })),
      });
      const before = await bytes();
      expect(await runProductWork(await workspace.state(), { task: "T001" })).toMatchObject({
        ok: false,
        error: { code: "STAGE_BLOCKED" },
      });
      expect(await bytes()).toEqual(before);
    },
  );

  it("refuses a dependent slice while authorizing its usable prerequisite", async () => {
    const first = brief.slices[0];
    if (!first) throw new Error("fixture needs a slice");
    await revise({
      ...brief,
      slices: [
        { ...first, dependsOn: ["T002"] },
        { ...first, id: "T002", goal: "Establish the required public value" },
      ],
    });
    const before = await bytes();
    expect(await runProductWork(await workspace.state(), { task: "T001" })).toMatchObject({
      ok: false,
      error: { code: "STAGE_BLOCKED", message: expect.stringContaining("depends on T002") },
    });
    expect(await bytes()).toEqual(before);
    expect(value(await runProductWork(await workspace.state())).task).toBe("T002");
  });

  it("runs a shared check for each slice before granting that slice closure", async () => {
    const first = brief.slices[0];
    if (!first) throw new Error("fixture needs a slice");
    await revise({
      ...brief,
      slices: [
        first,
        { ...first, id: "T002", goal: "Verify the same public promise independently" },
      ],
    });
    value(await runProductWork(await workspace.state(), { task: "T002" }));
    await workspace.write("src/value.mjs", "export const value = 2;\n");
    expect(value(await runProductVerify(await workspace.state(), { task: "T002" })).passed).toBe(
      true,
    );
    expect(value(await runProductDone(await workspace.state(), { task: "T002" })).closed).toBe(
      true,
    );
    value(await runProductWork(await workspace.state(), { task: "T001" }));
    const before = value(await readProductRecord(await workspace.state()));
    expect(before.state.executions.filter((entry) => entry.task === "T001")).toHaveLength(0);
    expect(value(await runProductDone(await workspace.state(), { task: "T001" })).closed).toBe(
      true,
    );
    const after = value(await readProductRecord(await workspace.state()));
    expect(after.state.executions.filter((entry) => entry.task === "T001")).toHaveLength(1);
  });

  it("does not satisfy a slice review with the other slice's shared-check receipt", async () => {
    const first = brief.slices[0];
    if (!first) throw new Error("fixture needs a slice");
    await revise({
      ...brief,
      slices: [
        first,
        { ...first, id: "T002", goal: "Verify the same public promise independently" },
      ],
    });
    value(await runProductWork(await workspace.state(), { task: "T002" }));
    await workspace.write("src/value.mjs", "export const value = 2;\n");
    value(await runProductVerify(await workspace.state(), { task: "T002" }));
    const record = value(await readProductRecord(await workspace.state()));
    const other = record.state.executions.find((entry) => entry.task === "T002");
    if (!other) throw new Error("Missing other-slice execution");
    const bundle = value(await runProductReview(await workspace.state(), { task: "T001" }));
    const input = {
      task: "T001",
      subjectDigest: bundle.subjectDigest,
      assessments: [
        {
          outcome: "O001",
          status: "satisfied" as const,
          summary: "The other slice's check passed",
          evidence: [other.id],
        },
      ],
    };
    const submitted = await runProductReview(await workspace.state(), input);
    expect(submitted).toMatchObject({
      ok: false,
      error: {
        code: "EVIDENCE_FAILED",
        message: expect.stringContaining("Unknown evidence reference"),
      },
    });
    const { task: _task, ...draft } = input;
    await workspace.write(".visp/drafts/wrong-slice.json", JSON.stringify(draft));
    const cli = await runJson<{ assessments: { status: string }[] }>(
      workspace.root,
      "review",
      "--task",
      "T001",
      "--from",
      ".visp/drafts/wrong-slice.json",
    );
    expect(cli.exitCode, JSON.stringify(cli.envelope)).toBe(1);
    expect(cli.envelope.ok).toBe(false);
    expect(JSON.stringify(cli.envelope)).toContain("Unknown evidence reference");
    type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;
    let handler: Handler | undefined;
    registerEvidenceTools(
      {
        registerTool(name: string, _config: unknown, callback: Handler) {
          if (name === "visp_review") handler = callback;
        },
      } as unknown as McpServer,
      workspace.root,
    );
    if (!handler) throw new Error("Missing review tool");
    const response = await handler(input);
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.structuredContent)).toContain("Unknown evidence reference");
  });

  it("does not carry another slice's assessment into the selected slice", async () => {
    const first = brief.slices[0];
    if (!first) throw new Error("fixture needs a slice");
    await revise({
      ...brief,
      slices: [first, { ...first, id: "T002", goal: "Independent shared outcome" }],
    });
    value(await runProductWork(await workspace.state(), { task: "T002" }));
    await workspace.write("src/value.mjs", "export const value = 2;\n");
    value(await runProductVerify(await workspace.state(), { task: "T002" }));
    const record = value(await readProductRecord(await workspace.state()));
    const execution = record.state.executions.find((entry) => entry.task === "T002");
    if (!execution) throw new Error("Missing other-slice execution");
    const otherBundle = value(await runProductReview(await workspace.state(), { task: "T002" }));
    value(
      await runProductReview(await workspace.state(), {
        task: "T002",
        subjectDigest: otherBundle.subjectDigest,
        assessments: [
          {
            outcome: "O001",
            status: "satisfied",
            summary: "The T002 execution returned two",
            evidence: [execution.id],
          },
        ],
      }),
    );
    const selected = value(await runProductReview(await workspace.state(), { task: "T001" }));
    expect(selected.assessments).toEqual([]);
    const after = value(await readProductRecord(await workspace.state()));
    expect(outcomeStatuses(after, selected.subjectDigest, first)[0]?.review).toBe("unassessed");
  });

  it("validates a runnable command before granting authorization", async () => {
    await revise({
      ...brief,
      checks: brief.checks.map((check) => ({ ...check, command: "node 'unterminated" })),
    });
    const before = await bytes();
    expect(await runProductWork(await workspace.state())).toMatchObject({
      ok: false,
      error: { code: "ARTIFACT_INVALID", message: expect.stringContaining("C001") },
    });
    expect(await bytes()).toEqual(before);
  });

  it("requires the installed scope enforcement foundation", async () => {
    await unlink(join(workspace.root, "AGENTS.visp.md"));
    const before = await bytes();
    expect(await runProductWork(await workspace.state())).toMatchObject({
      ok: false,
      error: { code: "STAGE_BLOCKED" },
    });
    expect(await bytes()).toEqual(before);
  });

  it("will not reopen a closed slice without a current mandatory failure", async () => {
    await closeSlice();
    const before = await bytes();
    expect(await runProductWork(await workspace.state(), { task: "T001" })).toMatchObject({
      ok: false,
      error: { code: "STAGE_BLOCKED", message: expect.stringContaining("already closed") },
    });
    expect(await bytes()).toEqual(before);
  });

  it("preserves exhausted final-review failures when explicitly asked to reopen", async () => {
    await closeSlice();
    for (let cycle = 0; cycle < 3; cycle++) {
      await workspace.write(
        "src/value.mjs",
        `export const value = 2; export const transition = ${cycle};\n`,
      );
      const bundle = value(await runProductReview(await workspace.state()));
      value(
        await runProductReview(await workspace.state(), {
          subjectDigest: bundle.subjectDigest,
          assessments: [
            {
              outcome: "O001",
              status: "failed",
              summary: "The intermediate transition still exposes the wrong public value",
            },
          ],
        }),
      );
    }
    expect(value(await runProductNext(await workspace.state()))).toMatchObject({
      action: "fix",
      mayEdit: false,
    });
    const before = value(await readProductRecord(await workspace.state()));
    const budget = productRefinement(before);
    expect(budget.exhausted).toBe(true);
    expect(await runProductWork(await workspace.state(), { task: "T001" })).toMatchObject({
      ok: true,
      value: { mayEdit: true },
    });
    const after = value(await readProductRecord(await workspace.state()));
    expect(productRefinement(after)).toEqual(budget);
    expect(after.state.reviews).toEqual(before.state.reviews);
  });
});

describe("bounded and optional product context", () => {
  it("authorizes bounded work when the index refresh fails", async () => {
    const state = await workspace.state();
    vi.spyOn(graph, "refreshRepository").mockResolvedValue(
      err(vispError("IO_ERROR", "index unavailable")),
    );
    const context = value(await runProductWork(state));
    expect(context.mayEdit).toBe(true);
    expect(context.notes.join()).not.toContain("index unavailable");
    expect((await bytes()).auth).toBeDefined();
  });

  it("bounds excerpts without injecting binary or empty files into the agent context", async () => {
    await workspace.write("src/value.mjs", `//${"x".repeat(7000)}\nexport const value = 1;\n`);
    await workspace.write("test/value.test.mjs", "");
    await workspace.write("src/binary.dat", "bad\0content");
    await revise({
      ...brief,
      slices: brief.slices.map((slice) => ({
        ...slice,
        scope: { ...slice.scope, allowed: ["src/**", "test/**"] },
      })),
    });
    const before = await bytes();
    const state = await workspace.state();
    const context = value(await runProductContext(state));
    expect(context.files).toHaveLength(1);
    expect(context.files[0]).toMatchObject({ path: "src/value.mjs", truncated: true });
    expect(context.files[0]?.content.length).toBeLessThanOrEqual(6000);
    expect(context.notes.join()).toContain("Context is bounded");
    expect(await bytes()).toEqual(before);
    const constrained = value(
      await runProductContext({
        ...state,
        config: { ...state.config, context: { ...state.config.context, tokenBudget: 10 } },
      }),
    );
    expect(constrained.files).toEqual([]);
    expect(constrained.budget.status).toBe("essential-overflow");
    expect(constrained.outcomes).toEqual(context.outcomes);
    expect(constrained.scope).toEqual(context.scope);
    expect(constrained.skills).toEqual([]);
  });
});
