import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { MEMORY_HEADING } from "../../../../src/memory/project-memory.js";
import { productStatePath, readProductRecord } from "../../../../src/workflow/product/store.js";
import { createProductFeatureWithTests } from "../../../../src/workflow/product/tester/independent-tests.js";
import type { IndependentTester } from "../../../../src/workflow/product/tester/independent-tests-model.js";
import {
  readTestsRecord,
  saveTestsRecord,
} from "../../../../src/workflow/product/tester/independent-tests-record.js";
import { inlineTests } from "../../../../src/workflow/product/tester/independent-tests-starters.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { compactProductReply } from "../../../../src/workflow/product-compact-text.js";
import { productWorkspace } from "../../support/product-workspace.js";
import { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await workspace?.destroy();
  workspace = undefined;
});

const REQUEST = "Return two from the public module.\nKeep the module name.";
const FAILS_FIRST = `import assert from "node:assert/strict";
try {
  const { value } = await import("../../src/value.mjs");
  assert.equal(typeof value, "number");
  assert.ok(Number.isInteger(value));
  assert.equal(value, 2);
} catch (error) {
  console.log(\`FAIL: value: \${String(error?.message ?? error).replace(/\\s+/g, " ")}\`);
  process.exitCode = 1;
}
`;

async function launched() {
  const created = await TestWorkspace.create(
    { "src/value.mjs": "export const value = 1;\n" },
    { critic: true },
  );
  workspace = created;
  const config = parse(await readFile(join(created.root, "visp.yml"), "utf8"));
  config.critic = { ...config.critic, harness: "codex", launch: "codex-exec", mode: "auto" };
  // Recalling earlier requests would run a real Codex model call.
  config.memory = { ...config.memory, enabled: false };
  await created.write("visp.yml", stringify(config));
  await created.installFoundation();
  created.commit("install foundation");
  return created;
}

function tester(calls: string[], file = { name: "value.test.mjs", content: FAILS_FIRST }) {
  const run: IndependentTester = async (request) => {
    calls.push(request.prompt);
    return { file, tests: [{ name: "value", quote: "Return two" }], notes: "" };
  };
  return run;
}

const create = async (
  created: TestWorkspace,
  request: string,
  starter?: ReturnType<typeof inlineTests>,
) =>
  createProductFeatureWithTests(
    await created.state(),
    { goal: "Two", sourceBrief: request },
    starter,
  );

async function features(created: TestWorkspace): Promise<string[]> {
  return (await readdir(join(created.root, ".visp/features"))).sort();
}

it("returns the earlier feature for the same request and starts one tester", async () => {
  const created = await launched();
  const calls: string[] = [];
  const starter = inlineTests(tester(calls));
  const first = await create(created, REQUEST, starter);
  expect(first.ok, JSON.stringify(first)).toBe(true);
  if (!first.ok) return;
  expect(first.value.duplicateOf).toBeUndefined();
  // Whitespace differences do not make a new request.
  const second = await create(created, REQUEST.replace("\n", "  "), starter);
  expect(second.ok, JSON.stringify(second)).toBe(true);
  if (!second.ok) return;
  expect(second.value).toMatchObject({
    duplicateOf: first.value.brief.feature,
    brief: { feature: first.value.brief.feature },
    duplicateNote: expect.stringContaining(`visp work --feature ${first.value.brief.feature}`),
  });
  expect(await features(created)).toEqual([first.value.brief.feature]);
  expect(calls).toHaveLength(1);
  expect(compactProductReply("feature", second.value, "cli")).toContain(
    `Note: Feature ${first.value.brief.feature} already records this request`,
  );
});

it("creates one feature for two concurrent creates of a request", async () => {
  const created = await launched();
  const calls: string[] = [];
  const starter = inlineTests(tester(calls));
  const both = await Promise.all([
    create(created, REQUEST, starter),
    create(created, REQUEST, starter),
  ]);
  expect(
    both.every((result) => result.ok),
    JSON.stringify(both),
  ).toBe(true);
  expect(await features(created)).toHaveLength(1);
  expect(calls).toHaveLength(1);
});

it("creates a second feature for different text, or a request too short to compare", async () => {
  const created = await launched();
  const first = await create(created, REQUEST);
  const different = await create(created, "Return three from the public module.");
  expect(first.ok && different.ok).toBe(true);
  if (!first.ok || !different.ok) return;
  expect(different.value.duplicateOf).toBeUndefined();
  expect(different.value.brief.feature).not.toBe(first.value.brief.feature);
  const short = await createProductFeatureWithTests(
    await created.state(),
    { goal: "Two", sourceBrief: "Two" },
    undefined,
  );
  expect(short.ok && short.value.duplicateOf).toBeUndefined();
  expect(await features(created)).toHaveLength(3);
});

it("never merges into a worked, accepted or older feature", async () => {
  const fixture = await productWorkspace();
  workspace = fixture.workspace;
  const request = "Return two from the public module";
  const dedupe = async () =>
    createProductFeatureWithTests(
      await fixture.workspace.state(),
      { goal: request, sourceBrief: request },
      undefined,
    );
  // The fixture's feature records this goal as its request and has not been worked yet.
  const untouched = await dedupe();
  expect(untouched.ok && untouched.value.duplicateOf).toBe(fixture.brief.feature);
  const work = await runProductWork(await fixture.workspace.state(), { task: "T001" });
  expect(work.ok, JSON.stringify(work)).toBe(true);
  const worked = await dedupe();
  expect(worked.ok && worked.value.duplicateOf).toBeUndefined();
  expect(worked.ok && worked.value.brief.feature).not.toBe(fixture.brief.feature);
  // An accepted feature is never returned either.
  const loaded = await readProductRecord(await fixture.workspace.state(), {
    feature: fixture.brief.feature,
  });
  if (!loaded.ok) throw new Error(loaded.error.message);
  const path = productStatePath(await fixture.workspace.state(), fixture.brief.feature);
  await writeFile(path, JSON.stringify({ ...loaded.value.state, status: "accepted" }));
  const accepted = await dedupe();
  expect(accepted.ok && accepted.value.duplicateOf).not.toBe(fixture.brief.feature);
});

it("does not return a feature older than ten minutes", async () => {
  const created = await launched();
  const first = await create(created, REQUEST);
  expect(first.ok).toBe(true);
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 11 * 60_000 });
  const later = await create(created, REQUEST);
  expect(later.ok && later.value.duplicateOf).toBeUndefined();
  expect(await features(created)).toHaveLength(2);
});

it("starts the missing tester of the existing feature instead of a second feature", async () => {
  const created = await launched();
  const calls: string[] = [];
  const first = await create(created, REQUEST, undefined);
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  const feature = first.value.brief.feature;
  const missing = await readTestsRecord(await created.state(), feature);
  expect(missing.ok && missing.value).toBeUndefined();
  const second = await create(created, REQUEST, inlineTests(tester(calls)));
  expect(second.ok && second.value.duplicateOf).toBe(feature);
  const pinned = await readTestsRecord(await created.state(), feature);
  expect(pinned.ok && pinned.value?.status).toBe("pinned");
  expect(calls).toHaveLength(1);
  expect(await features(created)).toEqual([feature]);
  // A pinned suite is left alone by a third call.
  const third = await create(created, REQUEST, inlineTests(tester(calls)));
  expect(third.ok && third.value.duplicateOf).toBe(feature);
  expect(calls).toHaveLength(1);
});

it("restarts a failed or dead tester of the existing feature once", async () => {
  const created = await launched();
  const calls: string[] = [];
  const failing: IndependentTester = async () => {
    calls.push("failing");
    throw new Error("The tester could not run");
  };
  const first = await create(created, REQUEST, inlineTests(failing));
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  const feature = first.value.brief.feature;
  const failed = await readTestsRecord(await created.state(), feature);
  expect(failed.ok && failed.value?.status).toBe("failed");
  const second = await create(created, REQUEST, inlineTests(tester(calls)));
  expect(second.ok && second.value.duplicateOf).toBe(feature);
  const pinned = await readTestsRecord(await created.state(), feature);
  expect(pinned.ok && pinned.value?.status).toBe("pinned");
  expect(calls).toHaveLength(2);
});

it("restarts a tester that stopped without a result", async () => {
  const created = await launched();
  const calls: string[] = [];
  const first = await create(created, REQUEST, undefined);
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  const feature = first.value.brief.feature;
  const running = {
    version: 1 as const,
    status: "running" as const,
    startedAt: new Date().toISOString(),
    model: "gpt-5",
  };
  const live = await saveTestsRecord(await created.state(), feature, running, undefined);
  expect(live.ok).toBe(true);
  // A tester that may still be running is left alone.
  const untouched = await create(created, REQUEST, inlineTests(tester(calls)));
  expect(untouched.ok && untouched.value.duplicateOf).toBe(feature);
  expect(calls).toHaveLength(0);
  // A running record past every deadline belongs to a dead tester.
  const stale = { ...running, startedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString() };
  const marked = await saveTestsRecord(await created.state(), feature, stale, running);
  expect(marked.ok).toBe(true);
  const again = await create(created, REQUEST, inlineTests(tester(calls)));
  expect(again.ok && again.value.duplicateOf).toBe(feature);
  const restarted = await readTestsRecord(await created.state(), feature);
  expect(restarted.ok && restarted.value?.status).toBe("pinned");
  expect(calls).toHaveLength(1);
});

it("treats a request that is only a prefix of the recorded one as a different request", async () => {
  const created = await launched();
  const longer = "Add a login page with OAuth and remember-me support";
  const first = await create(created, longer);
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  // A narrower request, and one cut in the middle of a word, are new features.
  for (const request of ["Add a login page with OAuth", "Add a login page with OAuth and remem"]) {
    const other = await create(created, request);
    expect(other.ok && other.value.duplicateOf, request).toBeUndefined();
    expect(other.ok && other.value.brief.feature).not.toBe(first.value.brief.feature);
  }
  expect(await features(created)).toHaveLength(3);
});

it("recognizes a request followed only by the memory block VISP appended", async () => {
  const created = await launched();
  const first = await create(created, REQUEST);
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  const path = join(created.root, `.visp/features/${first.value.brief.feature}/intent.json`);
  const intent = JSON.parse(await readFile(path, "utf8"));
  const withMemory = {
    ...intent,
    sourceBrief: `${REQUEST}\n\n${MEMORY_HEADING}\nM1 Keep it small`,
  };
  await writeFile(path, JSON.stringify(withMemory));
  const repeat = await create(created, REQUEST);
  expect(repeat.ok && repeat.value.duplicateOf).toBe(first.value.brief.feature);
  // Other text after the request is a longer request, not a memory block.
  await writeFile(path, JSON.stringify({ ...intent, sourceBrief: `${REQUEST} Also add tests.` }));
  const longer = await create(created, REQUEST);
  expect(longer.ok && longer.value.duplicateOf).toBeUndefined();
});

it("does not merge a repeat that asks for a branch, another risk level or another goal", async () => {
  const created = await launched();
  const first = await create(created, REQUEST);
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  const state = async () => created.state();
  // The same goal, request and risk still merge.
  const same = await createProductFeatureWithTests(
    await state(),
    { goal: "Two", sourceBrief: REQUEST, riskLevel: "low" },
    undefined,
  );
  expect(same.ok && same.value.duplicateOf).toBe(first.value.brief.feature);
  const variants = [
    { goal: "Two", sourceBrief: REQUEST, branch: true },
    { goal: "Two", sourceBrief: REQUEST, riskLevel: "high" as const },
    { goal: "Return two, differently", sourceBrief: REQUEST },
  ];
  for (const options of variants) {
    const result = await createProductFeatureWithTests(await state(), options, undefined);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.ok && result.value.duplicateOf, JSON.stringify(options)).toBeUndefined();
    expect(result.ok && result.value.brief.feature).not.toBe(first.value.brief.feature);
  }
});
