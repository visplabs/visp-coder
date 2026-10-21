import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "../../../../src/core/result.js";
import { GraphStore, openProjectStore, refreshRepository } from "../../../../src/graph/index.js";
import { registerWorkflowTools } from "../../../../src/mcp/tools/workflow.js";
import { productEvidenceGaps } from "../../../../src/workflow/product/assessment.js";
import {
  runProductAccept,
  runProductDone,
  runProductNext,
  runProductReview,
  runProductReviewRequest,
  runProductWork,
  updateProductBrief,
} from "../../../../src/workflow/product/index.js";
import type { ProductExecution } from "../../../../src/workflow/product/model.js";
import {
  regressionScopeAdvice,
  withRegressionScopeAdvice,
} from "../../../../src/workflow/product/regression-scope-advice.js";
import { readProductAuthorization } from "../../../../src/workflow/product/scopes.js";
import { readProductRecord, saveProductState } from "../../../../src/workflow/product/store.js";
import {
  productSourceDigest,
  productSourceSnapshot,
} from "../../../../src/workflow/product/subject.js";
import { runCli, runJson } from "../../cli/support/cli.js";
import { moduleFeedback } from "../../support/product-feedback.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

const PREFIX = "Existing tests also exercise the files you changed: ";
const related = "test/other.test.mjs";
const advice = (paths = related) =>
  `${PREFIX}${paths}. Run them with your test command before visp done; a new failure there is a regression unless the request changes that behavior.`;
let workspace: TestWorkspace;
let feature: string;

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

beforeEach(async () => {
  const fixture = await productWorkspace();
  workspace = fixture.workspace;
  feature = fixture.brief.feature;
  await workspace.write(related, "import {value} from '../src/value.mjs'; console.log(value);\n");
});
afterEach(async () => {
  await workspace.destroy();
});

async function refresh() {
  const state = await workspace.state();
  value(await refreshRepository(workspace.root, state.config.graph, state.paths.graphStore));
}
async function change() {
  workspace.git("add", "test");
  workspace.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "existing tests");
  value(await runProductWork(await workspace.state(), { feature, task: "T001" }));
  await workspace.write("src/value.mjs", "export const value = 2;\n");
  await refresh();
}
async function next() {
  return value(await runProductNext(await workspace.state(), { feature }));
}

it("advises once for the unnamed pre-existing test and delivers the same bounded context in a reviewer packet", async () => {
  await change();
  expect((await next()).evidence.filter((line) => line.startsWith(PREFIX))).toEqual([advice()]);
  const state = await workspace.state();
  const record = value(await readProductRecord(state, { feature }));
  const subject = value(await productSourceDigest(state, record.brief));
  expect((await productEvidenceGaps(state, record, subject)).join("\n")).not.toContain(PREFIX);
  const prepared = value(
    await runProductReviewRequest(state, { feature, task: "T001", prepare: true }),
  ) as { packetPath: string };
  const packet = JSON.parse(value(await state.files.readText(prepared.packetPath)));
  expect(packet.limitations).toContain(advice());
  expect(packet.gaps.join("\n")).not.toContain(PREFIX);
});

it("prioritizes one advice line after first-done advice without changing the next action", async () => {
  await change();
  const state = await workspace.state();
  const record = value(await readProductRecord(state, { feature }));
  const plain = {
    ...(await next()),
    evidence: [
      "No visp done yet after 16 minutes: run it now.",
      ...Array.from({ length: 12 }, (_, i) => `Existing evidence ${i}`),
    ],
  };
  const advised = await withRegressionScopeAdvice(state, record, plain);
  expect(advised).toEqual({
    ...plain,
    evidence: [plain.evidence[0], advice(), ...plain.evidence.slice(1)],
  });
  expect(await withRegressionScopeAdvice(state, record, advised)).toEqual(advised);
});

describe.each(["cli", "mcp"] as const)("regression advice through %s", (channel) => {
  it.each(["implement", "final"])("is visible in %s next replies", async (phase) => {
    await change();
    if (phase === "final")
      value(await runProductDone(await workspace.state(), { feature, task: "T001" }));
    if (channel === "cli") {
      const result = await runJson<{ evidence: string[] }>(
        workspace.root,
        "next",
        "--feature",
        feature,
      );
      expect(result.envelope.ok, result.stderr).toBe(true);
      expect(result.envelope.data?.evidence.filter((line) => line.startsWith(PREFIX))).toEqual([
        advice(),
      ]);
      const text = await runCli(workspace.root, "next", "--feature", feature);
      expect(text.exitCode, text.stderr).toBe(0);
      expect(text.stdout).toContain(advice());
    } else {
      let handler: ((args: object, extra: object) => Promise<CallToolResult>) | undefined;
      const server = {
        registerTool(name: string, _config: unknown, callback: typeof handler) {
          if (name === "visp_next") handler = callback;
          return {};
        },
      } as unknown as McpServer;
      registerWorkflowTools(server, workspace.root);
      const result = await handler?.({ feature }, {});
      expect(result?.structuredContent?.ok).toBe(true);
      expect(
        result?.content
          .filter((entry) => entry.type === "text")
          .map((entry) => entry.text)
          .join("\n"),
      ).toContain(advice());
    }
  });
});

it.each([related, "test.other.test"])(
  "excludes tests already named in declared checks: %s",
  async (command) => {
    const state = await workspace.state();
    const record = value(await readProductRecord(state, { feature }));
    value(
      await updateProductBrief(state, {
        brief: {
          ...record.brief,
          checks: [
            { ...record.brief.checks[0], command: `node --test test/value.test.mjs ${command}` },
          ],
        },
        reason: "Name the related test in the worker check",
      }),
    );
    await change();
    expect((await next()).evidence.join("\n")).not.toContain(PREFIX);
  },
);

it("also discovers test imports targeting symbols without tested_by edges", async () => {
  await change();
  const state = await workspace.state();
  const store = value(
    await openProjectStore(state.files, state.paths.graphStore, { writable: true }),
  );
  try {
    const snapshot = value(store.requireHead());
    const symbol = snapshot.entities.find(
      (entity) => entity.path === "src/value.mjs" && entity.kind !== "file",
    );
    if (!symbol) throw new Error("Missing module symbol");
    value(
      store.publishSnapshot({
        ...snapshot,
        id: "imports-only",
        relations: snapshot.relations
          .filter((relation) => relation.kind !== "tested_by")
          .map((relation) =>
            relation.kind === "imports" && relation.path === related
              ? { ...relation, target: symbol.id }
              : relation,
          ),
      }),
    );
  } finally {
    store.close();
  }
  expect((await next()).evidence).toContain(advice());
});

it.each([related, "test.other.test", "test.other.test.TestValue"])(
  "excludes tests named by path or module in recorded slice commands: %s",
  async (command) => {
    await change();
    const state = await workspace.state();
    const record = value(await readProductRecord(state, { feature }));
    const execution: ProductExecution = {
      id: "EXEC-old",
      task: "T001",
      check: "C001",
      subjectDigest: "old",
      contractDigest: "old",
      command: `node --test ${command}`,
      createdAt: new Date().toISOString(),
      status: "passed",
      exitCode: 0,
      durationMs: 1,
      output: "passed",
      provenance: "supervisor-executed",
      assertions: "runner-observed",
    };
    value(await saveProductState(state, record, { ...record.state, executions: [execution] }));
    expect((await next()).evidence.join("\n")).not.toContain(PREFIX);
  },
);

it("shows nothing before edits or with no pre-existing tests", async () => {
  expect((await next()).evidence.join("\n")).not.toContain(PREFIX);
  await workspace.write("test/new.test.mjs", "import {value} from '../src/value.mjs';\n");
  // Both fixture tests are absent when authorization is granted.
  await rm(join(workspace.root, "test"), { recursive: true });
  const state = await workspace.state();
  const record = value(await readProductRecord(state, { feature }));
  value(
    await updateProductBrief(state, {
      brief: {
        ...record.brief,
        checks: [
          { ...record.brief.checks[0], files: ["src/value.mjs", "test/value.test.mjs", related] },
        ],
      },
      reason: "Declare future test inputs before they exist",
    }),
  );
  value(await runProductWork(await workspace.state(), { feature, task: "T001" }));
  await workspace.write("test/value.test.mjs", "import {value} from '../src/value.mjs';\n");
  await workspace.write(related, "import {value} from '../src/value.mjs';\n");
  await workspace.write("src/value.mjs", "export const value = 2;\n");
  await refresh();
  expect((await next()).evidence.join("\n")).not.toContain(PREFIX);
});

it("silently skips stale and unavailable graphs", async () => {
  await change();
  await workspace.write("src/value.mjs", "export const value = 3;\n");
  expect((await next()).evidence.join("\n")).not.toContain(PREFIX);
  await rm((await workspace.state()).paths.graphStore);
  expect((await next()).evidence.join("\n")).not.toContain(PREFIX);
});

it("caps the sorted list at eight and excludes new tests", async () => {
  for (let i = 9; i >= 0; i--)
    await workspace.write(`test/extra${i}.test.mjs`, "import {value} from '../src/value.mjs';\n");
  await change();
  await workspace.write("test/aaa-new.test.mjs", "import {value} from '../src/value.mjs';\n");
  await refresh();
  expect((await next()).evidence.filter((line) => line.startsWith(PREFIX))).toEqual([
    advice(Array.from({ length: 8 }, (_, i) => `test/extra${i}.test.mjs`).join(", ")),
  ]);
});

it("remains advisory through closure, final next and acceptance", async () => {
  await change();
  const done = value(await runProductDone(await workspace.state(), { feature, task: "T001" }));
  expect(done).toMatchObject({ passed: true, closed: true, gaps: [] });
  expect(done.next?.evidence).toContain(advice());
  const state = await workspace.state();
  expect(
    value(
      await readProductAuthorization(state, value(await readProductRecord(state, { feature }))),
    ),
  ).toBeUndefined();
  const bundle = value(await runProductReview(state, { feature }));
  value(
    await runProductReview(state, {
      feature,
      subjectDigest: bundle.subjectDigest,
      feedback: moduleFeedback(bundle),
      assessments: [
        {
          outcome: "O001",
          status: "satisfied",
          summary: "Executed public import returns two",
          evidence: bundle.executions.map((entry) => entry.id),
        },
      ],
    }),
  );
  expect(await next()).toMatchObject({ action: "accept", evidence: [advice()] });
  expect(value(await runProductAccept(await workspace.state(), { feature }))).toMatchObject({
    passed: true,
    gaps: [],
  });
  expect(await next()).toMatchObject({ action: "complete", evidence: [] });
});

describe.each(["declared", "recorded"])("command context in %s checks", (kind) => {
  it.each([
    ["env PYTHONPATH=src python3 -m unittest tests.test_value", "src/tests/test_value.py"],
    ["cd packages/pkg && node --test test/value.test.mjs", "packages/pkg/test/value.test.mjs"],
    ["python3 tests/runtests.py utils_tests.test_text", "tests/utils_tests/test_text.py"],
  ])("excludes the named existing test: %s", async (command, path) => {
    await workspace.write(path, "# existing regression test\n");
    if (kind === "declared") {
      const state = await workspace.state();
      const record = value(await readProductRecord(state, { feature }));
      value(
        await updateProductBrief(state, {
          brief: {
            ...record.brief,
            checks: record.brief.checks.map((check) => ({
              ...check,
              command: ["bash", "-c", command],
            })),
          },
          reason: "Declare the existing test in its command context",
        }),
      );
    }
    await change();
    const state = await workspace.state();
    const record = value(await readProductRecord(state, { feature }));
    const store = value(
      await openProjectStore(state.files, state.paths.graphStore, { writable: true }),
    );
    try {
      const snapshot = value(store.requireHead());
      const source = snapshot.entities.find(
        (entity) => entity.path === "src/value.mjs" && entity.kind === "file",
      );
      const test = snapshot.entities.find(
        (entity) => entity.path === path && entity.kind === "file",
      );
      if (!source || !test) throw new Error("Missing fixture file entities");
      value(
        store.publishSnapshot({
          ...snapshot,
          id: `command-${kind}`,
          relations: [
            ...snapshot.relations,
            { source: source.id, target: test.id, kind: "tested_by", path, line: 1 },
          ],
        }),
      );
    } finally {
      store.close();
    }
    if (kind === "recorded") {
      expect(await regressionScopeAdvice(state, record)).toContain(path);
      record.state.executions.push({
        id: "EXEC-context",
        task: "T001",
        check: "C001",
        subjectDigest: "old",
        contractDigest: "old",
        command,
        createdAt: new Date().toISOString(),
        status: "passed",
        exitCode: 0,
        durationMs: 1,
        output: "passed",
        provenance: "supervisor-executed",
        assertions: "runner-observed",
      });
    }
    const result = await regressionScopeAdvice(state, record);
    expect(result).toContain(related);
    expect(result).not.toContain(path);
  });
});

it("uses changed-content coverage without a currency walk and caches related paths across workspace loads", async () => {
  await change();
  const state = await workspace.state();
  const record = value(await readProductRecord(state, { feature }));
  const snapshot = value(await productSourceSnapshot(state, record.brief));
  const readHead = vi.spyOn(GraphStore.prototype, "requireHead");
  const readScope = vi.spyOn(GraphStore.prototype, "readTestScope");
  try {
    expect(await regressionScopeAdvice(state, record, undefined, snapshot)).toBe(advice());
    expect(readHead).not.toHaveBeenCalled();
    const reads = readScope.mock.calls.length;
    expect(await regressionScopeAdvice(await workspace.state(), record, undefined, snapshot)).toBe(
      advice(),
    );
    expect(readScope.mock.calls.length).toBe(reads);
    // A cache hit must still reject changed bytes, even with an old source snapshot supplied.
    await workspace.write("src/value.mjs", "export const value = 3;\n");
    expect(await regressionScopeAdvice(state, record, undefined, snapshot)).toBeUndefined();
    await refresh();
    expect(await regressionScopeAdvice(state, record)).toBe(advice());
  } finally {
    readHead.mockRestore();
    readScope.mockRestore();
  }
});
