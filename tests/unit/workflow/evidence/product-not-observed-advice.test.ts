import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { hashValue, sha256 } from "../../../../src/core/hash.js";
import type { Result } from "../../../../src/core/result.js";
import { registerEvidenceTools } from "../../../../src/mcp/tools/evidence.js";
import { registerWorkflowTools } from "../../../../src/mcp/tools/workflow.js";
import type { ProductExecution } from "../../../../src/workflow/product/model.js";
import { withNotObservedAdvice } from "../../../../src/workflow/product/not-observed-advice.js";
import { runProductReview } from "../../../../src/workflow/product/review/review.js";
import type { ProductNext } from "../../../../src/workflow/product/status.js";
import { readProductRecord, saveProductState } from "../../../../src/workflow/product/store.js";
import {
  productContractDigest,
  productSourceDigest,
} from "../../../../src/workflow/product/subject.js";
import { runCli, runJson } from "../../cli/support/cli.js";
import { moduleFeedback } from "../../support/product-feedback.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

type Handler = (args: Record<string, unknown>, extra: object) => Promise<CallToolResult>;
type Channel = "cli" | "mcp";
const PREFIX = "VISP's tester never observed: ";
const GOAL = "Observed wins expose the correct next-screen control";
const SHOWN = `${GOAL}: 5000 attempts`;
const advice = (names = GOAL) =>
  `${PREFIX}${names}. If one is a goal the request defines (such as winning a level), make sure it can be reached through the request's interfaces; if it cannot, change the product.`;
let workspace: TestWorkspace;
let feature: string;
let handlers: Map<string, Handler>;

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

beforeEach(async () => {
  const fixture = await productWorkspace();
  workspace = fixture.workspace;
  feature = fixture.brief.feature;
  handlers = new Map();
  const server = {
    registerTool(name: string, _config: unknown, callback: Handler) {
      handlers.set(name, callback);
      return {};
    },
  } as unknown as McpServer;
  registerWorkflowTools(server, workspace.root);
  registerEvidenceTools(server, workspace.root);
});

afterEach(async () => {
  vi.useRealTimers();
  await workspace.destroy();
});

async function reply(channel: Channel, operation: string, task?: string) {
  if (channel === "cli") {
    const result = await runJson<Record<string, unknown>>(
      workspace.root,
      operation,
      "--feature",
      feature,
      ...(task ? ["--task", task] : []),
    );
    expect(result.envelope.ok, result.stderr).toBe(true);
    return result.envelope.data as Record<string, unknown>;
  }
  const handler = handlers.get(`visp_${operation}`);
  if (!handler) throw new Error(`Missing ${operation} tool`);
  const result = await handler({ feature, ...(task ? { task } : {}) }, {});
  expect(result.structuredContent?.ok, JSON.stringify(result)).toBe(true);
  const data = result.structuredContent?.data as Record<string, unknown>;
  const next = (operation === "next" ? data : data.next) as ProductNext | undefined;
  if (
    (operation === "next" || operation === "work") &&
    next?.evidence.some((line) => line.startsWith(PREFIX))
  )
    expect(
      result.content
        .filter((entry) => entry.type === "text")
        .map((entry) => entry.text)
        .join("\n"),
    ).toContain(next.evidence.find((line) => line.startsWith(PREFIX)));
  return data;
}

async function recordExecution(output: string, overrides: Partial<ProductExecution> = {}) {
  const state = await workspace.state();
  const record = value(await readProductRecord(state, { feature }));
  const execution: ProductExecution = {
    id: `EXEC-advice-${record.state.executions.length}`,
    check: "PINNED_1",
    subjectDigest: value(await productSourceDigest(state, record.brief)),
    contractDigest: productContractDigest(record.brief),
    createdAt: new Date().toISOString(),
    command: "node acceptance/value.mjs",
    status: "passed",
    exitCode: 0,
    durationMs: 1,
    output,
    provenance: "supervisor-executed",
    assertions: "runner-observed",
    ...overrides,
  };
  value(
    await saveProductState(state, record, {
      ...record.state,
      executions: [...record.state.executions, execution],
    }),
  );
}

describe.each(["cli", "mcp"] as const)("NOT OBSERVED advice through %s", (channel) => {
  it("puts one line first in implement next and work replies, changing only advice", async () => {
    const before = await reply(channel, "next", "T001");
    await recordExecution(`NOT OBSERVED: ${GOAL}: 4000 attempts\nPASS: public value`);
    expect(await reply(channel, "next", "T001")).toEqual({
      ...before,
      evidence: [advice(`${GOAL}: 4000 attempts`), ...(before.evidence as string[])],
    });
    for (const operation of ["work", "next", "work"]) {
      const data = await reply(channel, operation, "T001");
      const next = (operation === "next" ? data : data.next) as ProductNext;
      expect(next.action).toBe("implement");
      expect(next.evidence[0]).toBe(advice(`${GOAL}: 4000 attempts`));
      expect(next.evidence.filter((line) => line.startsWith(PREFIX))).toHaveLength(1);
    }
  });

  it.each([
    ["without coverage lines", "PASS: public value", {}],
    ["from an older subject", `NOT OBSERVED: ${GOAL}`, { subjectDigest: "old" }],
    ["from a worker check", `NOT OBSERVED: ${GOAL}`, { check: "OTHER" }],
    [
      "with only an informational note",
      "VISP: NOT OBSERVED marks an informational coverage gap",
      {},
    ],
  ])("does not advise %s", async (_name, output, overrides) => {
    await reply(channel, "work", "T001");
    const before = await reply(channel, "next");
    await recordExecution(output, overrides);
    expect(await reply(channel, "next")).toEqual(before);
  });

  it("uses only the latest pinned execution for the current subject", async () => {
    await reply(channel, "work", "T001");
    await recordExecution("PASS: public value");
    const before = await reply(channel, "next");
    expect((before.evidence as string[]).join("\n")).not.toContain(PREFIX);
    await recordExecution(`NOT OBSERVED: ${GOAL}`);
    await recordExecution("PASS: public value", { check: "PINNED_2" });
    expect(await reply(channel, "next")).toEqual(before);
    await recordExecution(`NOT OBSERVED: ${GOAL}`);
    await recordExecution("PASS: public value", { subjectDigest: "old" });
    await recordExecution("PASS: public value", { check: "OTHER" });
    expect(((await reply(channel, "next")).evidence as string[])[0]).toBe(advice());
  });

  it("still closes and accepts, advises at the final step, and stops advising after acceptance", async () => {
    const path = "acceptance/value.mjs";
    const content = `import assert from 'node:assert/strict';
import {value} from '../src/value.mjs';
assert.equal(value, 2);
console.log('NOT OBSERVED: ${GOAL}: 5000 attempts');
console.log('PASS: public value');
console.log('log tail\\n'.repeat(4000));
`;
    await workspace.write(path, content);
    const state = await workspace.state();
    const record = value(await readProductRecord(state, { feature }));
    record.brief.acceptanceBaseline = [
      {
        command: [process.execPath, path],
        files: [{ path, sha256: sha256(content) }],
      },
    ];
    record.state.intentSnapshot.acceptanceBaseline = record.brief.acceptanceBaseline;
    record.state.briefDigest = hashValue(record.brief);
    await workspace.write(`.visp/features/${feature}/brief.yaml`, stringify(record.brief));
    await workspace.write(
      `.visp/features/${feature}/product-state.json`,
      JSON.stringify(record.state),
    );
    await reply(channel, "work", "T001");
    await workspace.write("src/value.mjs", "export const value = 2;\n");
    const done = await reply(channel, "done", "T001");
    expect(done).toMatchObject({ passed: true, closed: true, gaps: [] });
    expect((done.next as ProductNext).evidence[0]).toBe(advice(SHOWN));
    expect(
      (done.executions as ProductExecution[]).find((entry) => entry.check === "PINNED_1")?.output,
    ).toContain(`NOT OBSERVED: ${GOAL}: 5000 attempts`);
    const final = await reply(channel, "next");
    expect(final).toMatchObject({ action: "refine", mayEdit: false });
    expect((final.evidence as string[])[0]).toBe(advice(SHOWN));
    expect((final.evidence as string[]).filter((line) => line.startsWith(PREFIX))).toHaveLength(1);
    if (channel === "cli") {
      const text = await runCli(workspace.root, "next", "--feature", feature);
      expect(text.exitCode, text.stderr).toBe(0);
      expect(text.stdout.match(/VISP's tester never observed:/g)).toHaveLength(1);
      expect(text.stdout).toContain(advice(SHOWN));
    }
    const bundle = value(await runProductReview(await workspace.state(), { feature }));
    value(
      await runProductReview(await workspace.state(), {
        feature,
        subjectDigest: bundle.subjectDigest,
        feedback: moduleFeedback(bundle),
        assessments: [
          {
            outcome: "O001",
            status: "satisfied",
            summary: "The executed public import returns two",
            evidence: bundle.executions.map((entry) => entry.id),
          },
        ],
      }),
    );
    const ready = await reply(channel, "next");
    expect(ready).toMatchObject({ action: "accept", evidence: [advice(SHOWN)] });
    expect(await reply(channel, "accept")).toMatchObject({ passed: true, gaps: [] });
    const accepted = await reply(channel, "next");
    expect(accepted).toMatchObject({ action: "complete", evidence: [] });
  });
});

it("puts the coverage line after first-done advice and keeps it visible in CLI text", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const started = Date.now();
  await reply("cli", "work", "T001");
  await recordExecution(`NOT OBSERVED: ${GOAL}`);
  vi.setSystemTime(started + 16 * 60_000);
  const next = await reply("cli", "next");
  expect((next.evidence as string[])[0]).toMatch(/^No visp done yet after 16 minutes:/);
  expect((next.evidence as string[])[1]).toBe(advice());
  for (const operation of ["next", "work"]) {
    const result = await runCli(workspace.root, operation, "--feature", feature);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.match(/VISP's tester never observed:/g)).toHaveLength(1);
    expect(result.stdout).toContain(advice());
  }
});

it("deduplicates saved lines, keeps colon-bearing names whole, and limits the list to four", async () => {
  await recordExecution(
    [
      "VISP: NOT OBSERVED marks an informational coverage gap",
      "  NOT OBSERVED: first goal: 4000 attempts",
      "NOT OBSERVED: second goal",
      "not observed: third goal: no events",
      "NOT OBSERVED: fourth goal",
      "NOT OBSERVED: fifth goal",
      "NOT OBSERVED: sixth goal",
      "NOT OBSERVED: first goal: 4000 attempts",
      "NOT OBSERVED: ",
    ].join("\r\n"),
  );
  const next = await reply("cli", "next");
  expect((next.evidence as string[])[0]).toBe(
    advice(
      "first goal: 4000 attempts, second goal, third goal: no events, fourth goal, and 2 more",
    ),
  );
});

it("does not insert the advice twice or advise accepted features", async () => {
  await recordExecution(`NOT OBSERVED: ${GOAL}`);
  const state = await workspace.state();
  const record = value(await readProductRecord(state, { feature }));
  const subject = value(await productSourceDigest(state, record.brief));
  const next = (await reply("cli", "next")) as unknown as ProductNext;
  expect(withNotObservedAdvice(next, record, subject)).toEqual(next);
  const plain = { ...next, evidence: [] };
  expect(
    withNotObservedAdvice(
      plain,
      {
        ...record,
        state: { ...record.state, status: "accepted" },
      },
      subject,
    ),
  ).toEqual(plain);
});

it("keeps distinct colon-bearing names that share a prefix", async () => {
  await recordExecution(
    ["NOT OBSERVED: Level: win: 4000 attempts", "NOT OBSERVED: Level: next-screen"].join("\r\n"),
  );
  const next = await reply("cli", "next");
  expect((next.evidence as string[])[0]).toBe(
    advice("Level: win: 4000 attempts, Level: next-screen"),
  );
});
