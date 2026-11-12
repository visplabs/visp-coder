import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  createProductFeatureChecked,
  independentTestsBeforeWork,
  writeConfiguredTests,
} from "../../../../src/workflow/product/tester/independent-tests.js";
import { writeIndependentTests } from "../../../../src/workflow/product/tester/independent-tests-run.js";
import {
  configuredTestsStarter,
  inlineTests,
} from "../../../../src/workflow/product/tester/independent-tests-starters.js";
import {
  claudeTester,
  testerCli,
  testsWaitMs,
} from "../../../../src/workflow/product/tester/tester-session.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import type { WorkspaceState } from "../../../../src/workflow/state.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace | undefined;
const temporary: string[] = [];
afterEach(async () => {
  await workspace?.destroy();
  workspace = undefined;
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// The fixture's module returns 1; the request promises 2.
const FAILS_FIRST = `import assert from "node:assert/strict";
try {
  const { value } = await import("../../src/value.mjs");
  assert.equal(typeof value, "number");
  assert.ok(Number.isInteger(value));
  assert.equal(value, 2);
} catch (error) {
  console.log(\`FAIL: value: \${String(error?.message ?? error)}\`);
  process.exitCode = 1;
}
`;

async function claudeWorkspace(critic: Record<string, unknown> = {}) {
  const fixture = await productWorkspace({ critic: true });
  workspace = fixture.workspace;
  const config = parse(await readFile(join(workspace.root, "visp.yml"), "utf8"));
  config.critic = {
    ...config.critic,
    harness: "claude-code",
    launch: "claude-exec",
    model: "claude-sonnet-5-5",
    mode: "auto",
    ...critic,
  };
  await workspace.write("visp.yml", stringify(config));
  workspace.commit("VISP launches a Claude reviewer and tester");
  return fixture;
}

/** A stand-in `claude` that records its call and answers with `answer` as structured output. */
async function fakeClaude(answer: unknown, loggedIn = true) {
  const dir = await mkdtemp(join(tmpdir(), "fake-claude-tester-"));
  temporary.push(dir);
  const fake = join(dir, "claude");
  await writeFile(
    fake,
    `#!${process.execPath}
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.0 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: ${loggedIn} })); process.exit(0); }
const stdin = readFileSync(0, "utf8");
writeFileSync(${JSON.stringify(join(dir, "call.json"))}, JSON.stringify({ args, cwd: process.cwd(), files: readdirSync(process.cwd()), stdin }));
process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "", structured_output: ${JSON.stringify(answer)} }));
`,
  );
  await chmod(fake, 0o755);
  return {
    fake,
    dir,
    call: async () => JSON.parse(await readFile(join(dir, "call.json"), "utf8")),
  };
}

it("pins tests a read-only claude -p tester wrote in an empty directory", async () => {
  const fixture = await claudeWorkspace();
  const claude = await fakeClaude({
    file: { name: "value.test.mjs", content: FAILS_FIRST },
    existingBehavior: false,
    tests: [{ name: "value", quote: "Return two" }],
    ambiguities: [],
    notes: "",
  });
  const work = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    inlineTests(claudeTester({ executable: claude.fake, lookup: async () => undefined })),
  );
  expect(work.ok, JSON.stringify(work)).toBe(true);
  if (!work.ok) return;
  const file = `acceptance/${fixture.brief.feature}/value.acceptance.mjs`;
  expect(work.value.independentTests).toMatchObject({ status: "pinned", file });
  const call = await claude.call();
  // The tester sees the request in an empty directory, never the product.
  expect(call.files).toEqual([]);
  expect(call.cwd).not.toBe(fixture.workspace.root);
  expect(call.stdin).toContain("You are an independent acceptance tester");
  expect(call.stdin).toContain("Return two from the public module");
  const args: string[] = call.args;
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  expect(value("--model")).toBe("claude-sonnet-5-5");
  expect(value("--tools")).toBe("Read,Grep,Glob");
  expect(value("--add-dir")).toBe(call.cwd);
  expect(JSON.parse(value("--json-schema") ?? "{}").required).toContain("existingBehavior");
  expect(value("--permission-mode")).toBe("dontAsk");
  expect(value("--permission-prompts")).toBe("none");
  expect(args).toEqual(
    expect.arrayContaining(["--restricted", "--safe-mode", "--strict-mcp-config"]),
  );
});

it("starts and waits for the Claude tester when claude-exec is configured", async () => {
  const fixture = await claudeWorkspace();
  const claude = await fakeClaude({});
  const previous = process.env.PATH;
  process.env.PATH = `${claude.dir}:${previous ?? ""}`;
  try {
    const state = await fixture.workspace.state();
    expect(configuredTestsStarter(state, "mcp")).toBeDefined();
    expect(testsWaitMs(state, "cli")).toBeGreaterThan(0);
    process.env.PATH = "";
    expect(configuredTestsStarter(state, "mcp")).toBeUndefined();
    expect(await independentTestsBeforeWork(state, undefined, undefined, 0)).toMatchObject({
      ok: true,
      value: { status: "skipped", reason: expect.stringContaining("claude CLI on PATH") },
    });
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});

it("says why a feature gets no tester instead of skipping it silently", async () => {
  const mismatched = await claudeWorkspace({ harness: "codex" });
  expect(
    await independentTestsBeforeWork(await mismatched.workspace.state(), undefined, undefined, 0),
  ).toMatchObject({
    ok: true,
    value: { status: "skipped", reason: expect.stringContaining("critic.harness: claude-code") },
  });
  await workspace?.destroy();
  const host = await claudeWorkspace({ launch: "host" });
  expect(
    await independentTestsBeforeWork(await host.workspace.state(), undefined, undefined, 0),
  ).toMatchObject({
    ok: true,
    value: { status: "skipped", reason: expect.stringContaining("codex-exec or claude-exec") },
  });
});

it("leaves existing-code tests to the Codex tester and says so", async () => {
  const fixture = await claudeWorkspace({ existingCodeTests: true });
  for (const name of ["a", "b", "c"])
    await fixture.workspace.write(`lib/${name}.mjs`, "export const x = 1;\n");
  fixture.workspace.commit("existing code, opted in");
  let calls = 0;
  const work = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    inlineTests(async () => {
      calls += 1;
      return {};
    }),
  );
  expect(work.ok, JSON.stringify(work)).toBe(true);
  expect(calls).toBe(0);
  expect(work.ok && work.value.independentTests).toMatchObject({
    status: "skipped",
    reason: expect.stringContaining("new projects only"),
  });
  await expect(
    claudeTester({ executable: "claude", lookup: async () => undefined })({
      root: fixture.workspace.root,
      model: "claude-sonnet-5-5",
      prompt: "Test behavior",
      schema: {},
      explore: true,
    }),
  ).rejects.toThrow("new projects only");
});

it("gives no notice on an existing codebase that did not opt in to tester runs", async () => {
  const fixture = await claudeWorkspace();
  for (const name of ["a", "b", "c"])
    await fixture.workspace.write(`lib/${name}.mjs`, "export const x = 1;\n");
  fixture.workspace.commit("existing code");
  let calls = 0;
  const work = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    inlineTests(async () => {
      calls += 1;
      return {};
    }),
  );
  expect(work.ok, JSON.stringify(work)).toBe(true);
  expect(calls).toBe(0);
  expect(work.ok && work.value.independentTests).toBeUndefined();
});

async function featureOnExistingCode(profile: "lean" | "full", existing: boolean, critic = {}) {
  const fixture = await claudeWorkspace(critic);
  if (existing)
    for (const name of ["a", "b", "c"])
      await fixture.workspace.write(`lib/${name}.mjs`, "export const x = 1;\n");
  const config = parse(await readFile(join(fixture.workspace.root, "visp.yml"), "utf8"));
  config.workflow = { ...config.workflow, profile };
  await fixture.workspace.write("visp.yml", stringify(config));
  await fixture.workspace.write("NOTES.md", `${profile}\n`);
  fixture.workspace.commit("existing code and profile");
  const created = await createProductFeatureChecked(
    await fixture.workspace.state(),
    { goal: "Return two again", sourceBrief: "Make the public value two.", branch: false },
    undefined,
  );
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

it("says a full-profile feature on existing code gets no tester under Claude Code", async () => {
  const created = await featureOnExistingCode("full", true);
  expect(created.profile?.name).toBe("full");
  expect(created.testsNote).toBe(
    "No independent tester runs for this feature: under Claude Code VISP starts it for new projects only, and this project has existing code.",
  );
});

it("says nothing when the tester runs, the profile is lean or another launcher is set", async () => {
  expect((await featureOnExistingCode("full", false)).testsNote).toBeUndefined();
  await workspace?.destroy();
  expect((await featureOnExistingCode("lean", true)).testsNote).toBeUndefined();
  await workspace?.destroy();
  const codex = await featureOnExistingCode("full", true, {
    harness: "codex",
    launch: "codex-exec",
  });
  expect(codex.testsNote).toBeUndefined();
});

it("records a failed tester with the reason when Claude Code is signed out", async () => {
  const fixture = await claudeWorkspace();
  const claude = await fakeClaude({}, false);
  const record = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    claudeTester({ executable: claude.fake, lookup: async () => undefined }),
  );
  expect(record.ok && record.value).toMatchObject({
    status: "failed",
    reason: expect.stringContaining("not signed in"),
  });
});

it("uses the project harness when the critic names none, as the reviewer does", () => {
  const state = (critic: Record<string, unknown>, harness: string) =>
    ({ config: { critic, harness } }) as unknown as WorkspaceState;
  expect(testerCli(state({ launch: "claude-exec" }, "claude-code"))).toBe("claude");
  expect(testerCli(state({ launch: "codex-exec" }, "codex"))).toBe("codex");
  expect(testerCli(state({ launch: "claude-exec", harness: "codex" }, "claude-code"))).toBe(
    undefined,
  );
  expect(testerCli(state({ launch: "host" }, "claude-code"))).toBe(undefined);
});

it("refuses a tester retry when VISP launches no tester, instead of starting Codex", async () => {
  const fixture = await claudeWorkspace({ launch: "host" });
  const retried = await writeConfiguredTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    true,
  );
  expect(retried).toMatchObject({
    ok: false,
    error: {
      code: "CONFIG_INVALID",
      message: expect.stringContaining("codex-exec or claude-exec"),
    },
  });
});
