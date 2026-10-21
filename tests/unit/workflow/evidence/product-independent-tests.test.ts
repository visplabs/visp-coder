import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { sha256 } from "../../../../src/core/hash.js";
import { processIdentity } from "../../../../src/core/process-identity.js";
import { ok } from "../../../../src/core/result.js";
import { withStateLock } from "../../../../src/core/state-lock.js";
import { updateProductBrief } from "../../../../src/workflow/product/brief.js";
import { runProductDone } from "../../../../src/workflow/product/evidence.js";
import { runProductReport } from "../../../../src/workflow/product/index.js";
import {
  runProductAcceptReviewed,
  runProductDoneReviewed,
} from "../../../../src/workflow/product/review/done-review.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import {
  createProductFeatureWithTests,
  independentTestsBeforeWork,
  startIndependentTests,
  writeConfiguredTests,
} from "../../../../src/workflow/product/tester/independent-tests.js";
import type {
  IndependentTester,
  TesterRequest,
} from "../../../../src/workflow/product/tester/independent-tests-model.js";
import { acceptanceProgress } from "../../../../src/workflow/product/tester/independent-tests-progress.js";
import {
  readTestsRecord,
  saveTestsRecord,
} from "../../../../src/workflow/product/tester/independent-tests-record.js";
import { writeIndependentTests } from "../../../../src/workflow/product/tester/independent-tests-run.js";
import {
  backgroundTests,
  configuredTestsStarter,
  inlineTests,
} from "../../../../src/workflow/product/tester/independent-tests-starters.js";
import { TESTER_BROWSER_KIT } from "../../../../src/workflow/product/tester/tester-browser-kit.js";
import { codexTester } from "../../../../src/workflow/product/tester/tester-session.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { compactProductReply } from "../../../../src/workflow/product-compact-text.js";
import { productWorkspace } from "../../support/product-workspace.js";
import { TestWorkspace } from "../../support/workspace.js";

// VISP's own browser probe, so tests decide whether a browser "starts" here.
const browser = vi.hoisted(() => ({ down: false, probes: 0 }));
vi.mock("../../../../src/testing/browser-capability.js", () => ({
  probeBrowserCapability: async () => {
    browser.probes += 1;
    if (browser.down) throw new Error("Chrome executable not found");
  },
}));

let workspace: TestWorkspace | undefined;
afterEach(async () => {
  await workspace?.destroy();
  workspace = undefined;
});

/**
 * A suite that reports its own failure the way VISP asks testers to: assertions run inside
 * one guarded test that prints `FAIL: <declared name>: <reason>` and sets a non-zero exit.
 */
const selfReporting = (body: string, name = "value") => `import assert from "node:assert/strict";
try {
${body}
} catch (error) {
  console.log(\`FAIL: ${name}: \${String(error?.message ?? error).replace(/\\s+/g, " ")}\`);
  process.exitCode = 1;
}
`;

// The fixture's module returns 1; the request promises 2.
const FAILS_FIRST = selfReporting(`  const { value } = await import("../../src/value.mjs");
  assert.equal(typeof value, "number");
  assert.ok(Number.isInteger(value));
  assert.equal(value, 2);`);

async function testerWorkspace() {
  const fixture = await productWorkspace({ critic: true });
  workspace = fixture.workspace;
  const config = parse(await readFile(join(workspace.root, "visp.yml"), "utf8"));
  config.critic = { ...config.critic, harness: "codex", launch: "codex-exec", mode: "auto" };
  await workspace.write("visp.yml", stringify(config));
  workspace.commit("VISP launches the reviewer and tester");
  return fixture;
}

function tester(file: { name: string; content: string } | null, calls: string[] = []) {
  const run: IndependentTester = async (request) => {
    calls.push(request.prompt);
    return { file, tests: [{ name: "value", quote: "Return two" }], notes: "" };
  };
  return run;
}

it("reports a skipped tester when codex-exec uses a non-Codex critic", async () => {
  const fixture = await productWorkspace({ critic: true });
  workspace = fixture.workspace;
  const config = parse(await readFile(join(workspace.root, "visp.yml"), "utf8"));
  config.critic = { ...config.critic, harness: "cursor", launch: "codex-exec", mode: "auto" };
  await workspace.write("visp.yml", stringify(config));
  const state = await workspace.state();
  expect(configuredTestsStarter(state)).toBeUndefined();
  expect(await independentTestsBeforeWork(state, undefined, undefined, 0)).toMatchObject({
    ok: true,
    value: { status: "skipped", reason: expect.stringContaining("critic.harness: codex") },
  });
});

it("pins tests written from the original request when they fail before implementation", async () => {
  const fixture = await testerWorkspace();
  const prompts: string[] = [];
  const state = await fixture.workspace.state();
  const work = await runProductWork(
    state,
    { task: "T001" },
    inlineTests(tester({ name: "value.test.mjs", content: FAILS_FIRST }, prompts)),
  );
  expect(work.ok, JSON.stringify(work)).toBe(true);
  if (!work.ok) return;
  const file = `acceptance/${fixture.brief.feature}/value.acceptance.mjs`;
  expect(work.value.independentTests).toMatchObject({
    status: "pinned",
    file,
    command: ["node", file],
  });
  // The tester sees the request, never the worker's plan or code.
  expect(prompts[0]).toContain("Return two from the public module");
  expect(prompts[0]).not.toContain("Return the promised value");
  const record = await readProductRecord(await fixture.workspace.state(), {});
  if (!record.ok) throw new Error(record.error.message);
  expect(record.value.brief.acceptanceBaseline).toEqual([
    { command: ["node", file], files: [{ path: file, sha256: expect.any(String) }] },
  ]);
  expect(record.value.state.revisions.at(-1)).toMatchObject({ provenance: "visp-tester" });
  // Authorization follows the pin, so the slice contract already includes the tests.
  expect(record.value.state.slices.T001?.status).toBe("in-progress");
});

it.each([true, false])(
  "preserves ambiguity notes in records and both work reply channels (file: %s)",
  async (hasFile) => {
    const fixture = await testerWorkspace();
    const ambiguity = {
      quote: "Return two from the public module",
      readings: ["Export the number directly", "Return a promise of the number"],
      conventionalReading: "Export the number directly",
    };
    const work = await runProductWork(
      await fixture.workspace.state(),
      { task: "T001" },
      inlineTests(async (request) => {
        expect(request.prompt).toContain("ambiguities");
        expect(request.prompt).toContain("Do not write tests for ambiguous cases");
        expect(request.schema).toMatchObject({ required: expect.arrayContaining(["ambiguities"]) });
        return {
          file: hasFile ? { name: "value.mjs", content: FAILS_FIRST } : null,
          tests: [],
          ambiguities: [ambiguity],
          notes: "",
        };
      }),
    );
    expect(work.ok, JSON.stringify(work)).toBe(true);
    if (!work.ok) return;
    const record = await readTestsRecord(await fixture.workspace.state(), fixture.brief.feature);
    expect(record.ok && record.value).toMatchObject({
      ambiguities: [ambiguity],
      status: hasFile ? "pinned" : "declined",
    });
    expect(work.value.independentTests).toMatchObject({ ambiguities: [ambiguity] });
    for (const channel of ["cli", "mcp"] as const) {
      const text = compactProductReply(
        channel === "cli" ? "work" : "visp_work",
        work.value,
        channel,
      );
      expect(text).toContain("default reading (advice, not a requirement)");
      expect(text).toContain(
        "Use it unless the request, a pinned test or an explicit user decision says otherwise",
      );
      expect(text).toContain(ambiguity.quote);
      expect(text).toContain(ambiguity.conventionalReading);
    }
    const later = await runProductWork(await fixture.workspace.state(), { task: "T001" });
    expect(later.ok && later.value.independentTests).toMatchObject({ ambiguities: [ambiguity] });
  },
);

it("rejects tests that already pass, removes them and still authorizes the slice", async () => {
  const fixture = await testerWorkspace();
  const passing = `import assert from "node:assert/strict";\nassert.ok(true);\nassert.ok(1);\nassert.equal(1, 1);\n`;
  const work = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    inlineTests(tester({ name: "vacuous.test.mjs", content: passing })),
  );
  expect(work.ok, JSON.stringify(work)).toBe(true);
  if (!work.ok) return;
  expect(work.value.independentTests).toMatchObject({
    status: "rejected",
    reason: expect.stringContaining("pass before any implementation"),
  });
  const record = await readProductRecord(await fixture.workspace.state(), {});
  if (!record.ok) throw new Error(record.error.message);
  expect(record.value.brief.acceptanceBaseline).toEqual([]);
  await expect(
    readFile(join(fixture.workspace.root, `acceptance/${fixture.brief.feature}/vacuous.test.mjs`)),
  ).rejects.toThrow();
});

it("rejects a test file without enough assertions", async () => {
  const fixture = await testerWorkspace();
  const work = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    inlineTests(tester({ name: "thin.test.mjs", content: "process.exit(1);\n" })),
  );
  expect(work.ok && work.value.independentTests).toMatchObject({
    status: "rejected",
    reason: expect.stringContaining("assertions"),
  });
});

// Testers sometimes import Node's assert module under another name; those calls are assertions.
it("counts calls through an aliased assert import as assertions", async () => {
  const fixture = await testerWorkspace();
  const content = `import check from "node:assert/strict";
const strict = require("assert");
check.equal(1, 2); check(false); strict.ok(false);
`;
  const work = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    inlineTests(tester({ name: "aliased.test.mjs", content })),
  );
  expect(work.ok && work.value.independentTests).not.toMatchObject({
    reason: expect.stringContaining("assertions"),
  });
});

// A method of the same name on another object (a page's `check`) is not an assertion.
it("does not count another object's method named like the assert alias", async () => {
  const fixture = await testerWorkspace();
  const content = `import check from "node:assert/strict";
await page.check("#agree"); await page.check("#terms"); form.check.call(form);
check(true);
`;
  const work = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    inlineTests(tester({ name: "methods.test.mjs", content })),
  );
  expect(work.ok && work.value.independentTests).toMatchObject({
    status: "rejected",
    reason: expect.stringContaining("2 assertions"),
  });
});

it("does not pin a suite when its interpreter exits with command-not-found", async () => {
  const fixture = await testerWorkspace();
  const content = `import assert from "node:assert/strict";
assert.ok(true); assert.ok(true); assert.ok(true);
process.exit(127);
`;
  const result = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    tester({ name: "missing-runtime.mjs", content }),
  );
  expect(result.ok && result.value.status).toBe("rejected");
  expect(result.ok && result.value.reason).toContain("could not start");
});

it("does not expose operator secrets to candidate tests", async () => {
  const fixture = await testerWorkspace();
  const previous = process.env.VISP_TEST_OPERATOR_SECRET;
  process.env.VISP_TEST_OPERATOR_SECRET = "secret";
  try {
    const content = selfReporting(`  const { value } = await import("../../src/value.mjs");
  assert.equal(process.env.VISP_TEST_OPERATOR_SECRET, undefined);
  assert.equal(typeof value, "number");
  assert.equal(value, 2);`);
    const result = await writeIndependentTests(
      await fixture.workspace.state(),
      fixture.brief.feature,
      tester({ name: "secret-check.mjs", content }),
    );
    expect(result.ok && result.value.status).toBe("pinned");
    expect((await runProductWork(await fixture.workspace.state(), { task: "T001" })).ok).toBe(true);
    await fixture.workspace.write("src/value.mjs", "export const value = 2;\n");
    const done = await runProductDone(await fixture.workspace.state(), { task: "T001" });
    expect(done.ok && done.value.executions.find((run) => run.check === "PINNED_1")?.status).toBe(
      "passed",
    );
  } finally {
    if (previous === undefined) delete process.env.VISP_TEST_OPERATOR_SECRET;
    else process.env.VISP_TEST_OPERATOR_SECRET = previous;
  }
});

it("redacts baseline output using the real project's env files when running in a copy", async () => {
  const fixture = await testerWorkspace();
  await fixture.workspace.write(".env", "PRIVATE_TOKEN=launch-private-value\n");
  const result = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    tester({ name: "value.mjs", content: `console.log("launch-private-value");\n${FAILS_FIRST}` }),
  );
  expect(result.ok && result.value.status, JSON.stringify(result)).toBe("pinned");
  expect(result.ok && result.value.baseline?.output).toContain("[REDACTED]");
  expect(result.ok && result.value.baseline?.output).not.toContain("launch-private-value");
});

it("runs each baseline in a private HOME and temporary directory that are removed afterwards", async () => {
  const fixture = await testerWorkspace();
  const report = `import { writeFileSync, statSync } from "node:fs";
writeFileSync(process.env.TMPDIR + "/scratch", "x");
console.log("HOME_REPORT " + JSON.stringify({ home: process.env.HOME, tmp: process.env.TMPDIR,
  temp: process.env.TEMP, mode: (statSync(process.env.HOME).mode & 0o777).toString(8) }));
`;
  const result = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    tester({ name: "value.mjs", content: `${report}${FAILS_FIRST}` }),
  );
  expect(result.ok && result.value.status, JSON.stringify(result)).toBe("pinned");
  const line = /HOME_REPORT (.*)/.exec((result.ok && result.value.baseline?.output) || "")?.[1];
  const seen = JSON.parse(line ?? "{}") as Record<string, string>;
  expect(seen.home).toMatch(/\/visp-baseline-[A-Za-z0-9]{6}$/);
  expect(seen).toMatchObject({ tmp: `${seen.home}/tmp`, temp: `${seen.home}/tmp`, mode: "700" });
  expect(existsSync(seen.home ?? "")).toBe(false);
});

it("still pins when the baseline leaves a read-only directory in its private home", async () => {
  const fixture = await testerWorkspace();
  const leave = `import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
mkdirSync(process.env.HOME + "/mod/deep", { recursive: true });
writeFileSync(process.env.HOME + "/mod/deep/file", "x");
chmodSync(process.env.HOME + "/mod/deep", 0o500);
chmodSync(process.env.HOME + "/mod", 0o500);
console.log("HOME_IS " + process.env.HOME);
`;
  const result = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    tester({ name: "value.mjs", content: `${leave}${FAILS_FIRST}` }),
  );
  expect(result.ok && result.value.status, JSON.stringify(result)).toBe("pinned");
  const home = /HOME_IS (.*)/.exec((result.ok && result.value.baseline?.output) || "")?.[1] ?? "";
  expect(home).toMatch(/visp-baseline-/);
  expect(existsSync(home)).toBe(false);
});

it("pins against launch-time source even when the worker implements it while tests are written", async () => {
  const fixture = await testerWorkspace();
  const result = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    async () => {
      await fixture.workspace.write("src/value.mjs", "export const value = 2;\n");
      return {
        file: { name: "value.mjs", content: FAILS_FIRST },
        existingBehavior: false,
        tests: [{ name: "value", quote: "Return two" }],
        notes: "",
      };
    },
  );
  expect(result.ok && result.value.status, JSON.stringify(result)).toBe("pinned");
  expect(result.ok && result.value.baseline?.exitCode).toBe(1);
  expect(await readFile(join(fixture.workspace.root, "src/value.mjs"), "utf8")).toContain(
    "value = 2",
  );
});

it("rejects tests that passed at launch even when later worker edits would make them fail", async () => {
  const fixture = await testerWorkspace();
  const result = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    async () => {
      await fixture.workspace.write("src/value.mjs", "export const value = 2;\n");
      return {
        file: { name: "value.mjs", content: FAILS_FIRST.replace("value, 2", "value, 1") },
        tests: [],
        notes: "",
      };
    },
  );
  expect(result.ok && result.value.status, JSON.stringify(result)).toBe("rejected");
  expect(result.ok && result.value.reason).toContain("pass before any implementation");
});

it("isolates each baseline and repair attempt and cleans up the launch copy", async () => {
  const fixture = await testerWorkspace();
  let sourceRoot = "";
  let calls = 0;
  const result = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    async (request) => {
      sourceRoot = request.sourceRoot ?? "";
      calls += 1;
      return {
        file: {
          name: "value.mjs",
          content:
            calls === 1
              ? `import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
assert.ok(true); assert.ok(true); assert.ok(true);
writeFileSync("src/value.mjs", "export const value = 2;\\n");
`
              : FAILS_FIRST,
        },
        tests: [],
        notes: "",
      };
    },
  );
  expect(result.ok && result.value.status, JSON.stringify(result)).toBe("pinned");
  expect(calls).toBe(2);
  expect(sourceRoot).not.toBe("");
  expect(sourceRoot).not.toBe(fixture.workspace.root);
  await expect(readFile(join(sourceRoot, "src/value.mjs"))).rejects.toThrow();
  expect(await readFile(join(fixture.workspace.root, "src/value.mjs"), "utf8")).toContain(
    "value = 1",
  );
});

it("checks existing behavior on a fresh launch copy even after a full baseline writes source", async () => {
  const fixture = await testerWorkspace();
  const result = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    async () => {
      await fixture.workspace.write("src/value.mjs", "export const value = 2;\n");
      return {
        existingBehavior: true,
        file: {
          name: "value.mjs",
          content: selfReporting(`  const { writeFileSync } = await import("node:fs");
  const { value } = await import("../../src/value.mjs");
  assert.equal(typeof value, "number");
  assert.ok(Number.isInteger(value));
  if (process.env.VISP_TEST_SCOPE === "existing") assert.equal(value, 1);
  else {
    writeFileSync("src/value.mjs", "export const value = 2;\\n");
    assert.equal(value, 2);
  }`),
        },
        tests: [],
        notes: "",
      };
    },
  );
  expect(result.ok && result.value.status, JSON.stringify(result)).toBe("pinned");
});

it("removes launch copies when the tester declines or throws", async () => {
  const fixture = await testerWorkspace();
  let root = "";
  const result = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    async (request) => {
      root = request.sourceRoot ?? "";
      throw new Error("tester unavailable");
    },
  );
  expect(result.ok && result.value.status).toBe("failed");
  expect(root).not.toBe("");
  await expect(readFile(join(root, "src/value.mjs"))).rejects.toThrow();
  const retried = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    async (request) => {
      root = request.sourceRoot ?? "";
      return { file: null, tests: [], notes: "" };
    },
    true,
  );
  expect(retried.ok && retried.value.status).toBe("declined");
  await expect(readFile(join(root, "src/value.mjs"))).rejects.toThrow();
});

it("captures source before launching a detached tester", async () => {
  const fixture = await testerWorkspace();
  const state = await fixture.workspace.state();
  let calls = 0;
  await startIndependentTests(state, fixture.brief.feature, async (workspace, feature) => {
    await fixture.workspace.write("src/value.mjs", "export const value = 2;\n");
    return writeIndependentTests(workspace, feature, async () => {
      calls += 1;
      return { file: null, tests: [], notes: "" };
    });
  });
  const record = await readTestsRecord(await fixture.workspace.state(), fixture.brief.feature);
  expect(record.ok && record.value?.status).toBe("declined");
  expect(record.ok && record.value?.reason).toContain("before the tester started");
  expect(calls).toBe(0);
});

it("declines a suite that admits it checks only file structure", async () => {
  const fixture = await testerWorkspace();
  const result = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    async () => ({
      file: {
        name: "structure.mjs",
        content:
          "import assert from 'node:assert/strict'; assert.ok(true); assert.ok(true); assert.ok(true); process.exit(1);",
      },
      existingBehavior: false,
      tests: [{ name: "file exists and parses", quote: "Create a game" }],
      notes: "I cannot test the behavior from this interface",
    }),
  );
  expect(result.ok && result.value.status).toBe("declined");
});

it("asks the tester once per feature, even when it fails", async () => {
  const fixture = await testerWorkspace();
  let calls = 0;
  const failing: IndependentTester = async () => {
    calls += 1;
    throw new Error("model unavailable");
  };
  const first = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    inlineTests(failing),
  );
  expect(first.ok && first.value.independentTests).toMatchObject({
    status: "failed",
    reason: "model unavailable",
  });
  const second = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    inlineTests(failing),
  );
  expect(second.ok, JSON.stringify(second)).toBe(true);
  expect(calls).toBe(1);
  const record = await readTestsRecord(await fixture.workspace.state(), fixture.brief.feature);
  expect(record.ok && record.value?.status).toBe("failed");
});

it("retries a failed tester only when explicitly requested", async () => {
  const fixture = await testerWorkspace();
  const state = await fixture.workspace.state();
  const failed = await writeIndependentTests(state, fixture.brief.feature, async () => {
    throw new Error("model unavailable");
  });
  expect(failed.ok && failed.value.status).toBe("failed");
  const retry = await writeIndependentTests(state, fixture.brief.feature, tester(null), true);
  expect(retry.ok && retry.value.status).toBe("declined");
});

it("does not spawn a background tester when Codex is missing", async () => {
  const fixture = await testerWorkspace();
  const previous = process.env.PATH;
  process.env.PATH = "";
  try {
    expect(configuredTestsStarter(await fixture.workspace.state(), "mcp")).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});

it("waits through a long done lock instead of discarding candidate tests", async () => {
  const fixture = await testerWorkspace();
  let locked!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const held = withStateLock(fixture.workspace.root, async () => {
    locked();
    await new Promise((resolve) => setTimeout(resolve, 5500));
    return ok(undefined);
  });
  await ready;
  const result = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    tester({ name: "value.test.mjs", content: FAILS_FIRST }),
  );
  await held;
  expect(result.ok && result.value.status).toBe("pinned");
});

it("reports a live tester as running beyond ten minutes", async () => {
  const fixture = await testerWorkspace();
  await fixture.workspace.write(
    `.visp/features/${fixture.brief.feature}/acceptance-tests.json`,
    JSON.stringify({
      version: 1,
      status: "running",
      startedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
      pid: process.pid,
    }),
  );
  const work = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    inlineTests(tester(null)),
  );
  expect(work.ok && work.value.independentTests?.status).toBe("running");
});

// Codex runs every sandboxed command in its own pid namespace; kill(pid, 0) proves nothing there.
const DEAD_PID = 2 ** 22 + 7;
async function workWithRunningRecord(record: Record<string, unknown>) {
  const fixture = await testerWorkspace();
  await fixture.workspace.write(
    `.visp/features/${fixture.brief.feature}/acceptance-tests.json`,
    JSON.stringify({ version: 1, status: "running", ...record }),
  );
  const work = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    inlineTests(tester(null)),
  );
  return work.ok ? work.value.independentTests : undefined;
}

it.skipIf(process.platform !== "linux")(
  "keeps a tester from another pid namespace running while it is young",
  async () => {
    expect(
      await workWithRunningRecord({
        startedAt: new Date().toISOString(),
        pid: DEAD_PID,
        pidNamespace: "pid:[4026539999]",
      }),
    ).toMatchObject({ status: "running" });
  },
);

it.skipIf(process.platform !== "linux")(
  "ends a tester from another pid namespace by age alone",
  async () => {
    expect(
      await workWithRunningRecord({
        startedAt: new Date(Date.now() - 27 * 60_000).toISOString(),
        pid: process.pid,
        pidNamespace: "pid:[4026539999]",
      }),
    ).toMatchObject({ status: "failed" });
  },
);

it.skipIf(process.platform !== "linux")(
  "still judges a same-namespace tester by whether its process is alive",
  async () => {
    const { pidNamespace } = await processIdentity(process.pid);
    const startedAt = new Date().toISOString();
    expect(
      await workWithRunningRecord({ startedAt, pid: process.pid, pidNamespace }),
    ).toMatchObject({ status: "running" });
    await workspace?.destroy();
    expect(await workWithRunningRecord({ startedAt, pid: DEAD_PID, pidNamespace })).toMatchObject({
      status: "failed",
    });
  },
);

it.skipIf(process.platform !== "linux")("records the writer's pid namespace", async () => {
  const fixture = await testerWorkspace();
  let seen: unknown;
  await writeIndependentTests(await fixture.workspace.state(), fixture.brief.feature, async () => {
    seen = await readTestsRecord(await fixture.workspace.state(), fixture.brief.feature);
    return { file: null, tests: [], notes: "" };
  });
  const { pidNamespace } = await processIdentity(process.pid);
  expect(seen).toMatchObject({
    ok: true,
    value: { status: "running", pid: process.pid, pidNamespace },
  });
});

it("records the tester's own reason when it writes no file", async () => {
  const fixture = await testerWorkspace();
  await writeIndependentTests(await fixture.workspace.state(), fixture.brief.feature, async () => ({
    file: null,
    tests: [],
    notes: "The pasted kit plus the tests would exceed the\n500-line limit.",
  }));
  const record = await readTestsRecord(await fixture.workspace.state(), fixture.brief.feature);
  expect(record).toMatchObject({
    ok: true,
    value: {
      status: "declined",
      reason:
        "The tester wrote no file: The pasted kit plus the tests would exceed the 500-line limit.",
    },
  });
});

it("keeps the generic decline reason when the tester explains nothing", async () => {
  const fixture = await testerWorkspace();
  await writeIndependentTests(await fixture.workspace.state(), fixture.brief.feature, async () => ({
    file: null,
    tests: [],
    notes: " ",
  }));
  const record = await readTestsRecord(await fixture.workspace.state(), fixture.brief.feature);
  expect(record).toMatchObject({
    ok: true,
    value: { status: "declined", reason: "No testable interface in the request" },
  });
});

it("does not launch a tester unless VISP launches the reviewer", async () => {
  const fixture = await productWorkspace({ critic: true });
  workspace = fixture.workspace;
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
});

it("runs the pinned tests when the last open slice is done", async () => {
  const fixture = await testerWorkspace();
  const work = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    inlineTests(tester({ name: "value.test.mjs", content: FAILS_FIRST })),
  );
  expect(work.ok && work.value.independentTests?.status).toBe("pinned");
  // Pinned tests point the worker at done, which records each failure without spending a review.
  expect(work.ok && work.value.independentTests?.instructions).toContain(
    "run it as soon as the slice works instead of waiting for every test to pass by hand",
  );
  expect(work.ok && work.value.independentTests?.instructions).toContain(
    "No review call is spent while a check fails, unless the only failures are pinned tests you disputed.",
  );
  await fixture.workspace.write("src/value.mjs", "export const value = 3;\n");
  await fixture.workspace.write(
    "test/value.test.mjs",
    "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; test('the promised value',()=>assert.equal(value,3));\n",
  );
  const done = await runProductDone(await fixture.workspace.state(), { task: "T001" });
  expect(done.ok, JSON.stringify(done)).toBe(true);
  if (!done.ok) return;
  const pinned = done.value.executions.find((execution) => execution.check === "PINNED_1");
  expect(pinned?.status).toBe("failed");
  expect(done.value.closed).toBe(false);
  // The human reviewer sees what the tester relied on and who changed protected intent.
  const report = await runProductReport(await fixture.workspace.state(), { full: true });
  if (!report.ok) throw new Error(report.error.message);
  expect(report.value.record?.suites).toContainEqual(
    expect.objectContaining({ check: "PINNED_1", author: "independent-tester", result: "failed" }),
  );
  expect(report.value.markdown).toMatch(/## Checks[\s\S]*PINNED_1[\s\S]*failed/);
  expect(report.value.markdown).toMatch(/## Acceptance tests[\s\S]*\| value \| Return two \|/);
  expect(report.value.markdown).toMatch(/## Intent changes[\s\S]*visp-tester/);
});

// Hosts kill long shell commands and MCP calls time out; the tester outlives `work`.
it("lets the worker continue while a detached tester is still writing", async () => {
  const fixture = await testerWorkspace();
  const { writeFile } = await import("node:fs/promises");
  const cli = join(fixture.workspace.root, "..", `fake-visp-${Date.now()}.mjs`);
  await writeFile(
    cli,
    `import { mkdirSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const root = args[args.indexOf("--project") + 1];
const feature = args[args.indexOf("--feature") + 1];
const path = root + "/.visp/features/" + feature + "/acceptance-tests.json";
const startedAt = new Date().toISOString();
writeFileSync(path, JSON.stringify({ version: 1, status: "running", startedAt }));
setTimeout(() => writeFileSync(path, JSON.stringify({ version: 1, status: "declined", startedAt, reason: "No testable interface in the request" })), 1500);
`,
  );
  const first = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    backgroundTests(cli),
    300,
  );
  expect(first.ok && first.value.independentTests).toMatchObject({ status: "running" });
  for (let waited = 0; waited < 50; waited += 1) {
    const record = await readTestsRecord(await fixture.workspace.state(), fixture.brief.feature);
    if (record.ok && record.value?.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const second = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    backgroundTests(cli),
    10_000,
  );
  expect(second.ok && second.value.independentTests).toMatchObject({ status: "declined" });
});

// The tester needs only the request, so it writes while the worker drafts the brief.
it("starts the tester with the feature and keeps the worker's first brief an initial draft", async () => {
  const created = await TestWorkspace.create(
    { "src/value.mjs": "export const value = 1;\n" },
    { critic: true },
  );
  workspace = created;
  const config = parse(await readFile(join(created.root, "visp.yml"), "utf8"));
  config.critic = { ...config.critic, harness: "codex", launch: "codex-exec", mode: "auto" };
  await created.write("visp.yml", stringify(config));
  await created.installFoundation();
  created.commit("install foundation");
  const starter = inlineTests(tester({ name: "value.test.mjs", content: FAILS_FIRST }));
  // A worker's summary would become the only contract the tester and reviewer see.
  const summarized = await createProductFeatureWithTests(
    await created.state(),
    { goal: "Return two" },
    starter,
  );
  expect(summarized.ok || summarized.error.recovery).toContain("--source-brief -");
  const feature = await createProductFeatureWithTests(
    await created.state(),
    { goal: "Return two", sourceBrief: "Return two from the public module" },
    starter,
  );
  expect(feature.ok, JSON.stringify(feature)).toBe(true);
  if (!feature.ok) return;
  const id = feature.value.brief.feature;
  const tests = await readTestsRecord(await created.state(), id);
  expect(tests.ok && tests.value?.status).toBe("pinned");
  // No --reason: the pin by VISP's tester does not make this a revision.
  const drafted = await updateProductBrief(await created.state(), {
    feature: id,
    patch: {
      outcomes: [{ id: "O001", kind: "functional", statement: "The public value is two" }],
      checks: [
        {
          id: "C001",
          command: [process.execPath, `acceptance/${id}/value.acceptance.mjs`],
          outcomes: ["O001"],
        },
      ],
      slices: [
        {
          id: "T001",
          goal: "Return two",
          outcomes: ["O001"],
          scope: { allowed: ["src/value.mjs"] },
          checks: ["C001"],
        },
      ],
    },
  });
  expect(drafted.ok, JSON.stringify(drafted)).toBe(true);
  const work = await runProductWork(await created.state(), { task: "T001" });
  expect(work.ok, JSON.stringify(work)).toBe(true);
});

// Workers waited 1–2 minutes for the tester; tests now pin mid-slice without revoking work.
it("pins tests that arrive after a slice started and keeps the slice authorized", async () => {
  const fixture = await testerWorkspace();
  const work = await runProductWork(await fixture.workspace.state(), { task: "T001" });
  expect(work.ok, JSON.stringify(work)).toBe(true);
  const late = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    tester({ name: "value.test.mjs", content: FAILS_FIRST }),
  );
  expect(late.ok && late.value.status).toBe("pinned");
  const record = await readProductRecord(await fixture.workspace.state(), {});
  if (!record.ok) throw new Error(record.error.message);
  expect(record.value.brief.acceptanceBaseline).toHaveLength(1);
  expect(record.value.state.slices.T001?.status).toBe("in-progress");
  await fixture.workspace.write("src/value.mjs", "export const value = 2;\n");
  const done = await runProductDone(await fixture.workspace.state(), { task: "T001" });
  expect(done.ok, JSON.stringify(done)).toBe(true);
});

// Weak workers passed summaries and paraphrases as the request.
it("uses the host-recorded prompt unless the worker quotes it verbatim", async () => {
  const created = await TestWorkspace.create({ "src/value.mjs": "export const value = 1;\n" });
  workspace = created;
  await created.installFoundation();
  created.commit("install foundation");
  const prompts = ["Return two from the public module.\nKeep the module name.", "go ahead"].map(
    (prompt) => JSON.stringify({ at: "2026-09-24T00:00:00Z", prompt }),
  );
  await created.write(".visp/session/user-prompts.jsonl", `${prompts.join("\n")}\n`);
  const quoted = await createProductFeatureWithTests(
    await created.state(),
    { goal: "Two", sourceBrief: "Return two from the public module. Keep the module name." },
    undefined,
  );
  expect(quoted.ok && quoted.value.brief.originalRequest).toBe(
    "Return two from the public module. Keep the module name.",
  );
  await expect(readFile(join(created.root, ".visp/session/user-prompts.jsonl"))).rejects.toThrow();
  // A repeat of one request within ten minutes returns the first feature, so each case differs.
  const other = JSON.stringify({
    at: "2026-09-24T00:00:00Z",
    prompt: "Return three from the public module.\nKeep the module name.",
  });
  await created.write(".visp/session/user-prompts.jsonl", `${other}\n`);
  const truncated = await createProductFeatureWithTests(
    await created.state(),
    { goal: "Four", sourceBrief: "Keep the module name." },
    undefined,
  );
  expect(truncated.ok && truncated.value.brief.originalRequest).toBe(
    "Return three from the public module.\nKeep the module name.",
  );
  const another = JSON.stringify({
    at: "2026-09-24T00:00:00Z",
    prompt: "Return four from the public module.\nKeep the module name.",
  });
  await created.write(".visp/session/user-prompts.jsonl", `${another}\n`);
  const paraphrased = await createProductFeatureWithTests(
    await created.state(),
    { goal: "Three", sourceBrief: "Make the module return 2" },
    undefined,
  );
  expect(paraphrased.ok && paraphrased.value.brief.originalRequest).toBe(
    "Return four from the public module.\nKeep the module name.",
  );
});

it("reports failing pinned tests at an earlier slice's done without blocking it", async () => {
  const fixture = await testerWorkspace();
  const brief = fixture.brief;
  const updated = await updateProductBrief(await fixture.workspace.state(), {
    reason: "Add a later slice",
    patch: {
      outcomes: [{ id: "O002", kind: "quality", statement: "The module is documented" }],
      slices: [
        {
          id: "T002",
          goal: "Document it",
          outcomes: ["O002"],
          dependsOn: ["T001"],
          scope: { allowed: ["README.md"] },
        },
      ],
    },
  });
  expect(updated.ok, JSON.stringify(updated)).toBe(true);
  const work = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    inlineTests(tester({ name: "value.test.mjs", content: FAILS_FIRST })),
  );
  expect(work.ok && work.value.independentTests?.status).toBe("pinned");
  await fixture.workspace.write("src/value.mjs", "export const value = 3;\n");
  await fixture.workspace.write(
    "test/value.test.mjs",
    "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; test('v',()=>assert.equal(value,3));\n",
  );
  const done = await runProductDoneReviewed(await fixture.workspace.state(), { task: "T001" });
  expect(done.ok, JSON.stringify(done)).toBe(true);
  if (!done.ok) return;
  expect(done.value.closed).toBe(true);
  expect(done.value.acceptanceTests).toEqual([
    expect.objectContaining({ passing: false, failure: expect.stringContaining("3 !== 2") }),
  ]);
  expect(brief.feature).toBeTruthy();
});

// Weak workers were sent to the host review protocol at acceptance and stopped there.
it("has VISP's reviewer assess the assembled product when acceptance lacks an assessment", async () => {
  const fixture = await productWorkspace({ critic: true });
  workspace = fixture.workspace;
  const work = await runProductWork(await fixture.workspace.state(), { task: "T001" });
  expect(work.ok, JSON.stringify(work)).toBe(true);
  await fixture.workspace.write("src/value.mjs", "export const value = 2;\n");
  const done = await runProductDone(await fixture.workspace.state(), { task: "T001" });
  expect(done.ok && done.value.closed, JSON.stringify(done)).toBe(true);
  const selections: unknown[] = [];
  const accepted = await runProductAcceptReviewed(
    await fixture.workspace.state(),
    {},
    async (_workspace, selection) => {
      selections.push(selection);
      return { reviewed: false, findings: [], reason: "reviewer unavailable in test" };
    },
  );
  expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
  if (!accepted.ok) return;
  expect(accepted.value.passed).toBe(false);
  expect(selections).toEqual([{ feature: fixture.brief.feature }]);
  expect(accepted.value.critic).toMatchObject({ reason: "reviewer unavailable in test" });
});

const BAD_THEN_GOOD = (expected: string) => FAILS_FIRST.replace("value, 2", `value, ${expected}`);

// On an existing codebase, trial suites were wrong in every variant tried.
it("does not launch the tester on an existing codebase", async () => {
  const fixture = await testerWorkspace();
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

it("gives the tester one repair round with the failure output", async () => {
  const fixture = await testerWorkspace();
  const prompts: string[] = [];
  const repairing: IndependentTester = async (request) => {
    prompts.push(request.prompt);
    return {
      // The first file passes before implementation, so it checks nothing new.
      file: { name: "value.test.mjs", content: BAD_THEN_GOOD(prompts.length === 1 ? "1" : "2") },
      tests: [{ name: "value", quote: "Return two" }],
      notes: "",
    };
  };
  const work = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    inlineTests(repairing),
  );
  expect(work.ok && work.value.independentTests?.status).toBe("pinned");
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("pass before any implementation");
});

// A pinned suite that crashes before any test ran leaves a later failure nobody can dispute.
const CRASHES = `import assert from "node:assert/strict";
import { value } from "../../src/missing.mjs";
assert.equal(value, 2); assert.ok(value); assert.ok(value);
`;

it("rejects a baseline that crashed before any declared test failed, then repairs it once", async () => {
  const fixture = await testerWorkspace();
  const prompts: string[] = [];
  const repairing: IndependentTester = async (request) => {
    prompts.push(request.prompt);
    return {
      file: { name: "value.test.mjs", content: prompts.length === 1 ? CRASHES : FAILS_FIRST },
      tests: [{ name: "value", quote: "Return two" }],
      notes: "",
    };
  };
  const result = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    repairing,
  );
  expect(result.ok && result.value.status, JSON.stringify(result)).toBe("pinned");
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("reported no declared test as failing");
  expect(prompts[1]).toContain('Declared names: "value"');
  expect(prompts[1]).toContain("Print `FAIL: <exact name from tests[].name>: <reason>`");
  expect(prompts[1]).toContain("ENVIRONMENT ERROR:");
  // The first prompt carries no repair-only text.
  expect(prompts[0]).not.toContain("reported no declared test as failing");
  // The full baseline output is used to attribute lines and is never stored.
  const stored = await readFile(
    join(fixture.workspace.root, `.visp/features/${fixture.brief.feature}/acceptance-tests.json`),
    "utf8",
  );
  expect(stored).not.toContain("fullOutput");
  expect(result.ok && Object.keys(result.value.baseline ?? {}).sort()).toEqual([
    "exitCode",
    "output",
    "spawnFailed",
    "timedOut",
  ]);
});

it("rejects FAIL lines that name no declared test and keeps the file when repair fails too", async () => {
  const fixture = await testerWorkspace();
  const prompts: string[] = [];
  const unnamed = `${FAILS_FIRST}console.log("FAIL: test_value (Suite.test_value): boom");\n`;
  const result = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    async (request) => {
      prompts.push(request.prompt);
      return {
        file: { name: "value.test.mjs", content: unnamed },
        tests: [{ name: "value", quote: "Return two" }],
        notes: "",
      };
    },
  );
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("Every FAIL line must be");
  expect(result.ok && result.value.status).toBe("rejected");
  expect(result.ok && result.value.reason).toContain("name no declared test");
  expect(result.ok && result.value.reason).toContain("test_value (Suite.test_value)");
  expect(result.ok && result.value.content).toBe(unnamed);
  const record = await readProductRecord(await fixture.workspace.state(), {});
  if (!record.ok) throw new Error(record.error.message);
  expect(record.value.brief.acceptanceBaseline).toEqual([]);
});

it("pins a self-reporting suite that declares no tests, and declines one that never says FAIL", async () => {
  const fixture = await testerWorkspace();
  const pinned = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    async () => ({ file: { name: "value.test.mjs", content: FAILS_FIRST }, tests: [], notes: "" }),
  );
  expect(pinned.ok && pinned.value.status, JSON.stringify(pinned)).toBe("pinned");
  const other = await testerWorkspace();
  const declined = await writeIndependentTests(
    await other.workspace.state(),
    other.brief.feature,
    async () => ({ file: { name: "value.test.mjs", content: CRASHES }, tests: [], notes: "" }),
  );
  expect(declined.ok && declined.value.status).toBe("declined");
  expect(declined.ok && declined.value.reason).toContain("declares no tests");
  const record = await readProductRecord(await other.workspace.state(), {});
  if (!record.ok) throw new Error(record.error.message);
  expect(record.value.brief.acceptanceBaseline).toEqual([]);
});

it("accepts FAIL lines that end in CRLF, as Python prints them on Windows", async () => {
  const fixture = await testerWorkspace();
  const crlf = FAILS_FIRST.replace(
    "process.exitCode = 1;",
    'process.stdout.write("FAIL: value: crlf line\\r\\n"); process.exitCode = 1;',
  );
  const result = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    tester({ name: "value.test.mjs", content: crlf }),
  );
  expect(result.ok && result.value.status, JSON.stringify(result)).toBe("pinned");
});

it("does not count unittest's runner lines as declared failures, and does not list secrets", async () => {
  const fixture = await testerWorkspace();
  await fixture.workspace.write(".env", "PRIVATE_TOKEN=launch-private-value\n");
  const noisy = `${FAILS_FIRST}console.log("FAIL: test_value (Suite.test_value)");
console.log("FAIL: " + "a".repeat(285) + "launch-private-value");
for (let index = 0; index < 8; index += 1) console.log("FAIL: other " + index);
`;
  const result = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    tester({ name: "value.test.mjs", content: noisy }),
  );
  expect(result.ok && result.value.status).toBe("rejected");
  const reason = (result.ok && result.value.reason) || "";
  expect(reason).toContain("name no declared test");
  expect(reason).not.toContain("launch-private");
  expect(reason).not.toContain("test_value (Suite");
  // At most five lines are listed, each cut to 300 characters after redaction.
  expect(reason.match(/"FAIL|"a{20}|"other/g)?.length ?? 0).toBeLessThanOrEqual(5);
  expect(reason).toContain("other 0");
  expect(reason).not.toContain("other 5");
});

it("still needs a declared name when the only FAIL lines are unittest's runner lines", async () => {
  const fixture = await testerWorkspace();
  const runnerOnly = `${CRASHES}console.log("FAIL: test_value (Suite.test_value)");\n`;
  const result = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    tester({ name: "value.test.mjs", content: runnerOnly }),
  );
  expect(result.ok && result.value.status).toBe("rejected");
  expect(result.ok && result.value.reason).toContain("reported no declared test as failing");
});

it("tells the tester to print a FAIL line per test with a browser carve-out", async () => {
  const fixture = await testerWorkspace();
  const prompts: string[] = [];
  await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    tester(null, prompts),
  );
  expect(prompts[0]).toContain("This holds when nothing is implemented yet");
  expect(prompts[0]).toContain("never import or start the product at file top level");
  expect(prompts[0]).toContain("when the browser itself cannot start, print `ENVIRONMENT ERROR:");
  expect(prompts[0]).toContain("PASS: <exact name from tests[].name>");
  expect(prompts[0]).toContain("print the qualifying event count");
  expect(prompts[0]).toContain("NOT OBSERVED: <exact name from tests[].name>");
  expect(prompts[0]).toContain("informational coverage gap, not a failure or pass");
});

// A suite whose browser cannot start says so instead of failing tests. VISP believes it only
// when its own probe agrees: a product or suite can print the line to dodge attribution.
const ENVIRONMENT_ONLY = `import assert from "node:assert/strict";
console.log("ENVIRONMENT ERROR: Chrome executable not found");
assert.ok(1); assert.ok(1); assert.ok(1);
process.exit(1);
`;

async function environmentTester(browserDown: boolean, second?: string) {
  browser.down = browserDown;
  browser.probes = 0;
  const fixture = await testerWorkspace();
  const prompts: string[] = [];
  const result = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    async (request) => {
      prompts.push(request.prompt);
      return {
        file: {
          name: "browser.test.mjs",
          content: prompts.length > 1 && second ? second : ENVIRONMENT_ONLY,
        },
        tests: [{ name: "value", quote: "Return two" }],
        notes: "",
      };
    },
  );
  const record = await readProductRecord(await fixture.workspace.state(), {});
  if (!record.ok) throw new Error(record.error.message);
  return { result, prompts, pinned: record.value.brief.acceptanceBaseline.length };
}

it("records a tester failure, without repair or pin, when only the environment stopped the suite", async () => {
  const { result, prompts, pinned } = await environmentTester(true);
  expect(prompts).toHaveLength(1);
  expect(result.ok && result.value.status).toBe("failed");
  expect(result.ok && result.value.reason).toContain("could not run in this environment");
  expect(result.ok && result.value.reason).toContain("Chrome executable not found");
  expect(pinned).toBe(0);
  expect(browser.probes).toBe(1);
});

it("repairs a suite that claims an environment error while a browser starts here", async () => {
  const { result, prompts, pinned } = await environmentTester(false, FAILS_FIRST);
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("do not print ENVIRONMENT ERROR");
  expect(prompts[1]).toContain("reported no declared test as failing");
  expect(result.ok && result.value.status, JSON.stringify(result)).toBe("pinned");
  expect(pinned).toBe(1);
  // Still rejected when the repair prints the line again.
  const again = await environmentTester(false);
  expect(again.result.ok && again.result.value.status).toBe("rejected");
  expect(again.pinned).toBe(0);
});

it("pins a suite that names a failing test even when it also prints an environment error", async () => {
  browser.down = true;
  browser.probes = 0;
  const fixture = await testerWorkspace();
  const result = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    tester({
      name: "value.test.mjs",
      content: `${FAILS_FIRST}console.log("ENVIRONMENT ERROR: teardown noise");\n`,
    }),
  );
  expect(result.ok && result.value.status, JSON.stringify(result)).toBe("pinned");
  expect(browser.probes).toBe(0);
});

it("classifies a pinned run as environment-failed only when VISP's own probe agrees", async () => {
  const fixture = await testerWorkspace();
  const suite = selfReporting(`  const { value } = await import("../../src/value.mjs");
  if (value === "env" || value === "mixed") {
    if (value === "mixed") console.log("FAIL: something else: broke");
    console.log("ENVIRONMENT ERROR: Chrome executable not found");
    process.exit(1);
  }
  if (value === "trace") {
    console.log("ENVIRONMENT ERROR: Chrome executable not found");
    throw new TypeError("boom");
  }
  assert.equal(typeof value, "number");
  assert.ok(Number.isInteger(value));
  assert.equal(value, 2);`);
  browser.down = false;
  const pinned = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    tester({ name: "value.test.mjs", content: suite }),
  );
  expect(pinned.ok && pinned.value.status, JSON.stringify(pinned)).toBe("pinned");
  expect((await runProductWork(await fixture.workspace.state(), { task: "T001" })).ok).toBe(true);
  const statusWith = async (value: string, down: boolean) => {
    browser.down = down;
    await fixture.workspace.write("src/value.mjs", `export const value = ${value};\n`);
    const done = await runProductDone(await fixture.workspace.state(), { task: "T001" });
    return done.ok ? done.value.executions.find((run) => run.check === "PINNED_1") : undefined;
  };
  const environment = await statusWith('"env"', true);
  expect(environment?.status).toBe("environment-failed");
  expect(environment?.output).toContain("ENVIRONMENT ERROR: Chrome executable not found");
  expect(environment?.output).toContain("not a product failure");
  // The same output with a browser that starts is a product failure printing the line itself.
  expect((await statusWith('"env"', false))?.status).toBe("failed");
  // Any other FAIL line, or an uncaught error, keeps a real failure a failure.
  expect((await statusWith('"mixed"', true))?.status).toBe("failed");
  expect((await statusWith('"trace"', true))?.status).toBe("failed");
  // A named failure is a product failure, and a passing run passes.
  expect((await statusWith("3", true))?.status).toBe("failed");
  expect((await statusWith("2", true))?.status).toBe("passed");
});

// Codex's sandbox ends background processes when a command finishes; the record said
// "running" forever.
it("reports a tester whose process has ended as failed", async () => {
  const fixture = await testerWorkspace();
  await fixture.workspace.write(
    `.visp/features/${fixture.brief.feature}/acceptance-tests.json`,
    JSON.stringify({
      version: 1,
      status: "running",
      startedAt: new Date().toISOString(),
      pid: 2 ** 22 + 7,
    }),
  );
  const work = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    inlineTests(tester({ name: "value.test.mjs", content: FAILS_FIRST })),
  );
  expect(work.ok && work.value.independentTests).toMatchObject({
    status: "failed",
    reason: expect.stringContaining("host may end background processes"),
  });
});

it("runs the tester on an existing codebase in a writable copy only when opted in", async () => {
  const fixture = await testerWorkspace();
  for (const name of ["a", "b", "c"])
    await fixture.workspace.write(`lib/${name}.mjs`, "export const x = 1;\n");
  const config = parse(await readFile(join(fixture.workspace.root, "visp.yml"), "utf8"));
  config.critic = { ...config.critic, existingCodeTests: true };
  await fixture.workspace.write("visp.yml", stringify(config));
  fixture.workspace.commit("existing code, opted in");
  const requests: { explore?: boolean; prompt: string }[] = [];
  const work = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    inlineTests(async (request) => {
      requests.push(request);
      return { file: null, existingBehavior: true, tests: [], notes: "" };
    }),
  );
  expect(work.ok, JSON.stringify(work)).toBe(true);
  expect(requests[0]?.explore).toBe(true);
  expect(requests[0]?.prompt).toContain("run the program and observe it");
});

// A retry used the project as it was then: files committed after a new-project launch gave
// a Codex tester a writable, networked copy the project never opted in to.
it("retries a new-project tester in new-project mode after the project gains source files", async () => {
  const fixture = await testerWorkspace();
  // Untracked at launch, so the project is still new; committing them changes no source bytes.
  for (const name of ["a", "b", "c"])
    await fixture.workspace.write(`lib/${name}.mjs`, "export const x = 1;\n");
  const failed = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    async () => {
      throw new Error("model unavailable");
    },
  );
  expect(failed.ok && failed.value.status).toBe("failed");
  fixture.workspace.commit("three tracked source files");
  const requests: TesterRequest[] = [];
  const retry = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    async (request) => {
      requests.push(request);
      return { file: null, existingBehavior: false, tests: [], notes: "" };
    },
    true,
  );
  expect(retry.ok && retry.value.status, JSON.stringify(retry)).toBe("declined");
  expect(requests).toHaveLength(1);
  expect(requests[0]?.explore).toBeFalsy();
  expect(requests[0]?.blockedPaths).toBeUndefined();
  expect(requests[0]?.prompt).toContain("You are in an empty temporary directory");
});

/** A new-project feature whose tester failed, with its recorded launch mode replaced. */
async function failedTesterLaunchedAs(mode: string, existingCodeTests = false) {
  const fixture = await testerWorkspace();
  if (existingCodeTests) {
    const config = parse(await readFile(join(fixture.workspace.root, "visp.yml"), "utf8"));
    config.critic = { ...config.critic, existingCodeTests };
    await fixture.workspace.write("visp.yml", stringify(config));
    fixture.workspace.commit("opt in to existing-code tests");
  }
  const failed = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    async () => {
      throw new Error("model unavailable");
    },
  );
  expect(failed.ok && failed.value.status).toBe("failed");
  const state = await fixture.workspace.state();
  const path = state.paths.featureFile(fixture.brief.feature, "tester-launch-mode");
  expect(await readFile(path, "utf8")).toBe("new-project\n");
  await fixture.workspace.write(relative(fixture.workspace.root, path), mode);
  const requests: TesterRequest[] = [];
  const recording: IndependentTester = async (request) => {
    requests.push(request);
    return { file: null, existingBehavior: false, tests: [], notes: "" };
  };
  return { fixture, requests, recording };
}

// The recorded mode decides, not the project as it looks at retry time.
it("retries a tester recorded on existing code in execution mode only with the opt-in", async () => {
  const refused = await failedTesterLaunchedAs("existing-code\n");
  expect(
    await writeIndependentTests(
      await refused.fixture.workspace.state(),
      refused.fixture.brief.feature,
      refused.recording,
      true,
    ),
  ).toMatchObject({
    ok: false,
    error: { code: "CONFIG_INVALID", message: expect.stringContaining("existingCodeTests") },
  });
  expect(refused.requests).toHaveLength(0);
  await workspace?.destroy();
  const opted = await failedTesterLaunchedAs("existing-code\n", true);
  const retried = await writeIndependentTests(
    await opted.fixture.workspace.state(),
    opted.fixture.brief.feature,
    opted.recording,
    true,
  );
  expect(opted.requests, JSON.stringify(retried)).toHaveLength(1);
  expect(opted.requests[0]?.explore).toBe(true);
});

it("refuses to retry a tester whose recorded launch mode is unreadable", async () => {
  const { fixture, requests, recording } = await failedTesterLaunchedAs("sideways\n");
  const feature = fixture.brief.feature;
  const unreadable = {
    ok: false,
    error: { code: "ARTIFACT_INVALID", message: "Unreadable tester-launch-mode" },
  };
  expect(
    await writeIndependentTests(await fixture.workspace.state(), feature, recording, true),
  ).toMatchObject(unreadable);
  const repeated = await createProductFeatureWithTests(
    await fixture.workspace.state(),
    { goal: fixture.brief.goal, sourceBrief: fixture.brief.originalRequest },
    inlineTests(recording),
  );
  expect(repeated.ok && repeated.value).toMatchObject({
    duplicateOf: feature,
    testsNote: "Unreadable tester-launch-mode",
  });
  expect(requests).toHaveLength(0);
});

it("refuses to retry a tester in execution mode on an existing codebase that did not opt in", async () => {
  const created = await TestWorkspace.create(
    {
      "src/value.mjs": "export const value = 1;\n",
      "lib/a.mjs": "export const a = 1;\n",
      "lib/b.mjs": "export const b = 1;\n",
    },
    { critic: true },
  );
  workspace = created;
  const config = parse(await readFile(join(created.root, "visp.yml"), "utf8"));
  config.critic = { ...config.critic, harness: "codex", launch: "codex-exec", mode: "auto" };
  // Recalling earlier requests would run a real Codex model call.
  config.memory = { ...config.memory, enabled: false };
  await created.write("visp.yml", stringify(config));
  await created.installFoundation();
  created.commit("existing code, not opted in");
  const request = "Return two from the public module.\nKeep the module name.";
  const feature = await createProductFeatureWithTests(
    await created.state(),
    { goal: "Two", sourceBrief: request },
    undefined,
  );
  if (!feature.ok) throw new Error(feature.error.message);
  const id = feature.value.brief.feature;
  // A failed record with no launch mode, as an earlier VISP version left it.
  const failed = {
    version: 1 as const,
    status: "failed" as const,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    model: "gpt-5",
    reason: "model unavailable",
  };
  expect((await saveTestsRecord(await created.state(), id, failed, undefined)).ok).toBe(true);
  const requests: TesterRequest[] = [];
  const recording: IndependentTester = async (testerRequest) => {
    requests.push(testerRequest);
    return { file: null, existingBehavior: true, tests: [], notes: "" };
  };
  const refusal = {
    ok: false,
    error: {
      code: "CONFIG_INVALID",
      message: expect.stringContaining("critic.existingCodeTests: true"),
    },
  };
  expect(await writeIndependentTests(await created.state(), id, recording, true)).toMatchObject(
    refusal,
  );
  // `visp work --feature <id> --retry-tests`.
  expect(await writeConfiguredTests(await created.state(), id, true)).toMatchObject(refusal);
  // A repeated `visp feature` request says why instead of restarting the tester.
  const repeated = await createProductFeatureWithTests(
    await created.state(),
    { goal: "Two", sourceBrief: request },
    inlineTests(recording),
  );
  expect(repeated.ok && repeated.value).toMatchObject({
    duplicateOf: id,
    testsNote: expect.stringContaining("execution mode"),
  });
  expect(requests).toHaveLength(0);
  const record = await readTestsRecord(await created.state(), id);
  expect(record.ok && record.value).toEqual(failed);
});

// Evidence: suites that covered only setup and shapes let a rewrite silently break the
// central outcomes. The tester must cover them, reaching them by bounded search when the
// request leaves the setup open, and drive time through the request's deterministic controls.
it("tells the tester to cover central outcomes and to reach them by bounded search", async () => {
  const fixture = await testerWorkspace();
  const prompts: string[] = [];
  const work = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    inlineTests(tester(null, prompts)),
  );
  expect(work.ok, JSON.stringify(work)).toBe(true);
  const prompt = prompts[0] ?? "";
  expect(prompt).toContain("Coverage priority");
  expect(prompt).toContain("drop shape and format checks before central outcomes");
  expect(prompt).toContain("bounded search over allowed inputs");
  expect(prompt).toContain("covers the whole stated input domain");
  expect(prompt).toContain("Bound every search by an iteration count");
  expect(prompt).toContain("instead of real-time waits");
  // Two stated-equivalent input paths are tested against one expected result, with
  // geometry that cannot hide a flipped sign or swapped axis.
  expect(prompt).toContain("Equivalent input paths");
  expect(prompt).toContain("non-zero component on every axis");
  // Precision rules stay, reconciled: ambiguity is about expected results, not open setup.
  expect(prompt).toContain("A wrong test is worse than a missing one");
  expect(prompt).toContain("different expected result");
  expect(prompt).toContain("Quote the sentence each test relies on");
  // Nothing domain- or benchmark-specific leaks into the generic prompt.
  expect(prompt).not.toMatch(/\b(game|bird|pig|slingshot|benchmark)s?\b/i);
});

// Execution mode gives a model network access: no secrets in its copy, every command logged.
it("keeps secret and blocked files out of the tester's copy and lists its commands", async () => {
  const fixture = await testerWorkspace();
  const { chmod, writeFile } = await import("node:fs/promises");
  for (const name of ["a", "b", "c"])
    await fixture.workspace.write(`lib/${name}.mjs`, "export const x = 1;\n");
  const config = parse(await readFile(join(fixture.workspace.root, "visp.yml"), "utf8"));
  config.critic = { ...config.critic, existingCodeTests: true };
  config.workflow = { ...config.workflow, blockedPaths: ["private/**"] };
  await fixture.workspace.write("visp.yml", stringify(config));
  fixture.workspace.commit("existing code, opted in");
  // Untracked but not ignored: git ls-files -co lists them.
  await fixture.workspace.write(".env", "TOKEN=secret\n");
  await fixture.workspace.write("config/server.pem", "key\n");
  await fixture.workspace.write("private/notes.txt", "internal\n");
  const fake = join(fixture.workspace.root, "..", `fake-codex-${Date.now()}.mjs`);
  await writeFile(
    fake,
    `#!${process.execPath}
import { readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
const args = process.argv.slice(2);
const root = args[args.indexOf("--cd") + 1];
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? walk(join(dir, entry.name)) : [relative(root, join(dir, entry.name))]);
console.log(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "curl -s http://localhost:8080/items" } }));
writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify({
  file: null, existingBehavior: false, tests: [],
  notes: JSON.stringify({ files: walk(root), env: args.includes('shell_environment_policy.inherit="core"') }),
}));
`,
  );
  await chmod(fake, 0o755);
  const state = await fixture.workspace.state();
  const record = await writeIndependentTests(
    state,
    fixture.brief.feature,
    codexTester({ executable: fake, lookup: async () => undefined }),
  );
  if (!record.ok) throw new Error(record.error.message);
  const seen = JSON.parse(record.value.notes ?? "{}") as { files: string[]; env: boolean };
  expect(seen.files).toContain("lib/a.mjs");
  expect(seen.files).not.toContain(".env");
  expect(seen.files).not.toContain("config/server.pem");
  expect(seen.files).not.toContain("private/notes.txt");
  expect(seen.env).toBe(true);
  const report = await runProductReport(await fixture.workspace.state(), { full: true });
  if (!report.ok) throw new Error(report.error.message);
  expect(report.value.record?.outsideAccess.testerNetworkCommands).toBeGreaterThan(0);
  expect(report.value.markdown).toMatch(
    /## Tester commands with network access[\s\S]*curl -s http:\/\/localhost:8080\/items/,
  );
});

it("runs a new-project tester in an empty directory and sweeps abandoned auth copies", async () => {
  const fixture = await testerWorkspace();
  const { chmod, mkdir, mkdtemp, utimes, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const stale = await mkdtemp(join(tmpdir(), "visp-tester-"));
  await mkdir(join(stale, "codex-home"));
  await writeFile(join(stale, "codex-home", "auth.json"), "secret");
  // Past two hours the copy is abandoned; a younger one may belong to a running tester, and
  // a directory that only looks like one (not mkdtemp's shape) is never touched.
  const old = new Date(Date.now() - 3 * 60 * 60_000);
  await utimes(stale, old, old);
  const young = await mkdtemp(join(tmpdir(), "visp-tester-"));
  const youngAge = new Date(Date.now() - 60 * 60_000);
  await utimes(young, youngAge, youngAge);
  const named = join(tmpdir(), `visp-tester-notes-${process.pid}`);
  await mkdir(named);
  await utimes(named, old, old);
  // The snapshot's launch-time source copy and baseline copies use their own prefixes.
  const copies = [
    await mkdtemp(join(tmpdir(), "visp-tester-source-")),
    await mkdtemp(join(tmpdir(), "visp-tester-baseline-")),
  ];
  for (const copy of copies) await utimes(copy, old, old);
  const fake = join(fixture.workspace.root, "..", `fake-codex-empty-${Date.now()}.mjs`);
  await writeFile(
    fake,
    `#!${process.execPath}
import { readdirSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const root = args[args.indexOf("--cd") + 1];
writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify({
  file: null, existingBehavior: false, tests: [], notes: JSON.stringify(readdirSync(root)),
}));
`,
  );
  await chmod(fake, 0o755);
  const response = (await codexTester({ executable: fake, lookup: async () => undefined })({
    root: fixture.workspace.root,
    model: "fake",
    prompt: "Test behavior",
    schema: {},
  })) as { notes: string };
  expect(JSON.parse(response.notes)).toEqual([]);
  await expect(readFile(join(stale, "codex-home", "auth.json"))).rejects.toThrow();
  const { stat, rm } = await import("node:fs/promises");
  try {
    for (const copy of copies) await expect(stat(copy)).rejects.toThrow();
    expect((await stat(young)).isDirectory()).toBe(true);
    expect((await stat(named)).isDirectory()).toBe(true);
  } finally {
    await rm(young, { recursive: true, force: true });
    await rm(named, { recursive: true, force: true });
    for (const copy of copies) await rm(copy, { recursive: true, force: true });
  }
});

it("says a pinned run cut off by the deadline was not shown failing", async () => {
  const fixture = await testerWorkspace();
  const suite = selfReporting(`  const { value } = await import("../../src/value.mjs");
  if (value === 3) await new Promise((resolve) => setTimeout(resolve, 30000));
  assert.equal(typeof value, "number");
  assert.ok(Number.isInteger(value));
  assert.equal(value, 2);`);
  const pinned = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    tester({ name: "value.test.mjs", content: suite }),
  );
  expect(pinned.ok && pinned.value.status, JSON.stringify(pinned)).toBe("pinned");
  const progress = async (value: number, deadline?: number) => {
    await fixture.workspace.write("src/value.mjs", `export const value = ${value};\n`);
    return acceptanceProgress(await fixture.workspace.state(), fixture.brief.feature, [], {
      ...(deadline ? { deadline } : {}),
    });
  };
  const [cutOff] = await progress(3, Date.now() + 1500);
  expect(cutOff?.passing).toBe(false);
  expect(cutOff?.note).toContain("cut off, not shown failing");
  expect(cutOff?.note).not.toContain("still fail");
  expect(cutOff?.failure).toBeUndefined();
  const [failing] = await progress(1);
  expect(failing?.note).toContain("still fail");
  expect(failing?.failure).toContain("FAIL: value");
  const [passing] = await progress(2);
  expect(passing).toMatchObject({ passing: true, note: "Pinned acceptance tests pass." });
});

// A suite that starts a server left it running after the baseline run.
it("ends every process a baseline test run started", async () => {
  const fixture = await testerWorkspace();
  const pidFile = join(fixture.workspace.root, "..", `leak-${Date.now()}.pid`);
  const leaking = `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const server = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)"], { stdio: "ignore" });
server.unref();
writeFileSync(${JSON.stringify(pidFile)}, String(server.pid));
${FAILS_FIRST}`;
  const work = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    inlineTests(tester({ name: "value.test.mjs", content: leaking })),
  );
  expect(work.ok && work.value.independentTests?.status).toBe("pinned");
  const pid = Number(await readFile(pidFile, "utf8"));
  const alive = (() => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  })();
  expect(alive).toBe(false);
});

// Evidence: hand-rolled `--dump-dom` tester files crashed or checked nothing. A request that
// describes a browser UI gets the native-input kit API in the prompt; other requests never do.
it.each([
  [
    "a browser game",
    "Build a small browser game where you drag the ball back and release it.",
    true,
  ],
  ["a plain module", "Return two from the public module", false],
])(
  "puts the browser kit API into the tester prompt only for a UI request (%s)",
  async (_name, request, kit) => {
    const created = await TestWorkspace.create(
      { "src/value.mjs": "export const value = 1;\n" },
      { critic: true },
    );
    workspace = created;
    const config = parse(await readFile(join(created.root, "visp.yml"), "utf8"));
    config.critic = { ...config.critic, harness: "codex", launch: "codex-exec", mode: "auto" };
    await created.write("visp.yml", stringify(config));
    await created.installFoundation();
    created.commit("install foundation");
    const prompts: string[] = [];
    const feature = await createProductFeatureWithTests(
      await created.state(),
      { goal: "Feature", sourceBrief: request },
      inlineTests(tester({ name: "value.test.mjs", content: FAILS_FIRST }, prompts)),
    );
    expect(feature.ok, JSON.stringify(feature)).toBe(true);
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0] as string;
    expect(prompt).toContain(
      "sample during the run, not only terminal snapshots, and include every named moving actor",
    );
    expect(prompt).toContain(
      "check only those objects over bounded idle simulation through the stated interfaces",
    );
    expect(prompt).toContain(
      "include one case for each value kind whose behavior the request defines there",
    );
    expect(prompt).toContain("Apply the stated rules together");
    expect(prompt).toContain("sample one allowed value near each end and one in the middle");
    expect(prompt).toContain("as one plain statement without caveats");
    expect(prompt).toContain(
      "Angles and directions are bounded (one full turn, or the range the request names)",
    );
    expect(prompt).toContain(
      "print `NOT OBSERVED: <exact name>: <attempts> attempts` instead of FAIL",
    );
    expect(prompt).toContain("Only a truly open domain goes to `ambiguities`.");
    expect(prompt).toContain(
      "put the case and its conventional reading in `ambiguities`, not a test",
    );
    expect(prompt).toContain("direct reference, operator, function argument, range");
    expect(prompt).toContain("happens as soon as (or immediately when) a trigger holds");
    expect(prompt).toContain("stop at the FIRST state where the trigger or state holds");
    expect(prompt).toContain("Where the request states a delay, check within that delay");
    expect(prompt).toContain("never assert an immediacy the request does not state");
    expect(prompt).not.toContain(TESTER_BROWSER_KIT.trim());
    expect(prompt.includes("openPage(url,")).toBe(kit);
    expect(prompt.includes("BrowserUnavailable")).toBe(kit);
    expect(prompt.includes("Cover the request's screen flow through the visible controls")).toBe(
      kit,
    );
    if (kit) {
      expect(prompt).toContain(
        "each stated effect over time (damage, burning, timers) at least once",
      );
      expect(prompt).toContain("assert the vertical direction as well as the horizontal one");
    }
    // The kit sits after the rules and before the save-path line and the request.
    if (kit) {
      expect(prompt.indexOf("openPage(url,")).toBeLessThan(
        prompt.indexOf("The file will be saved as"),
      );
    }
    expect(prompt.endsWith(request)).toBe(true);
  },
);

const UI_REQUEST = "Build a browser UI that displays the public module value as two.";
const USES_KIT = selfReporting(`
  assert.equal(typeof openPage, "function");
  const server = await serveDir(process.cwd());
  try {
    assert.equal((await fetch(server.url + "/src/value.mjs")).status, 200);
    process.env.CHROME_BIN = "/visp-no-such-chrome";
    await assert.rejects(openPage(server.url), BrowserUnavailable);
  } finally { server.close(); }
  const { value } = await import("../../src/value.mjs");
  assert.equal(value, 2);`);

async function createKitFeature(request: string, run: IndependentTester) {
  const created = await TestWorkspace.create(
    { "src/value.mjs": "export const value = 1;\n" },
    { critic: true },
  );
  workspace = created;
  const config = parse(await readFile(join(created.root, "visp.yml"), "utf8"));
  config.critic = { ...config.critic, harness: "codex", launch: "codex-exec", mode: "auto" };
  await created.write("visp.yml", stringify(config));
  await created.installFoundation();
  created.commit("install foundation");
  const feature = await createProductFeatureWithTests(
    await created.state(),
    { goal: "Feature", sourceBrief: request },
    inlineTests(run),
  );
  if (!feature.ok) throw new Error(feature.error.message);
  const state = await created.state();
  const record = await readTestsRecord(state, feature.value.brief.feature);
  if (!record.ok || !record.value) throw new Error("Missing tests record");
  return { created, state, feature: feature.value.brief.feature, record: record.value };
}

it.each([false, true])(
  "runs and pins a UI suite with one browser kit (already present: %s)",
  async (alreadyPresent) => {
    const content = (alreadyPresent ? TESTER_BROWSER_KIT : "") + USES_KIT;
    const result = await createKitFeature(UI_REQUEST, tester({ name: "value.mjs", content }));
    expect(result.record.status, result.record.reason).toBe("pinned");
    expect(result.record.baseline?.output).toContain("FAIL: value: Expected values");
    const file = result.record.file as string;
    const saved = await readFile(join(result.created.root, file), "utf8");
    expect(saved).toContain(TESTER_BROWSER_KIT);
    expect(saved.split("export async function openPage")).toHaveLength(2);
    expect(saved.endsWith(USES_KIT)).toBe(true);
    if (alreadyPresent) expect(saved).toBe(content);
    const product = await readProductRecord(result.state, { feature: result.feature });
    expect(product.ok && product.value.brief.acceptanceBaseline[0]?.files).toEqual([
      { path: file, sha256: sha256(saved) },
    ]);
    await result.created.write("src/value.mjs", "export const value = 2;\n");
    const later = await acceptanceProgress(await result.created.state(), result.feature, []);
    expect(later).toMatchObject([{ passing: true }]);
    expect(await readFile(join(result.created.root, file), "utf8")).toBe(saved);
  },
);

it("leaves a non-UI tester file unchanged even when it mentions kit names", async () => {
  const content = selfReporting(`
  const label = "openPage serveDir BrowserUnavailable";
  assert.equal(typeof label, "string");
  const { value } = await import("../../src/value.mjs");
  assert.ok(value);
  assert.equal(value, 2);`);
  const result = await createKitFeature(
    "Return two from the public module",
    tester({ name: "value.mjs", content }),
  );
  expect(result.record.status).toBe("pinned");
  expect(await readFile(join(result.created.root, result.record.file as string), "utf8")).toBe(
    content,
  );
});

it("rejects a UI tester file when the combined kit and own content exceed 64 KB", async () => {
  const content = `${USES_KIT}//${"x".repeat(64 * 1024 - Buffer.byteLength(USES_KIT) - 2)}`;
  const result = await createKitFeature(UI_REQUEST, tester({ name: "value.mjs", content }));
  expect(Buffer.byteLength(content)).toBe(64 * 1024);
  expect(result.record).toMatchObject({ status: "rejected", reason: "The test file is too large" });
  expect(result.record.baseline).toBeUndefined();
});

it("inserts the kit again for a repair without adding its source to repair feedback", async () => {
  const prompts: string[] = [];
  const result = await createKitFeature(UI_REQUEST, async (request) => {
    prompts.push(request.prompt);
    return {
      file: {
        name: "value.mjs",
        content:
          prompts.length === 1
            ? USES_KIT.replace("assert.equal(value, 2)", "assert.equal(value, 1)")
            : USES_KIT,
      },
      tests: [{ name: "value", quote: UI_REQUEST }],
      notes: "",
    };
  });
  expect(result.record.status, result.record.reason).toBe("pinned");
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("pass before any implementation");
  expect(prompts[1]).not.toContain(TESTER_BROWSER_KIT.trim());
  expect(prompts[1]).toContain("assert.equal(value, 1)");
});
