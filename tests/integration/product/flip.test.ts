import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  runProductDone,
  runProductVerify,
  runProductWork,
  updateProductBrief,
} from "../../../src/workflow/product/index.js";
import { runProductReviewRequest } from "../../../src/workflow/product/review/review-request.js";
import { runProductNext } from "../../../src/workflow/product/status.js";
import { readProductRecord } from "../../../src/workflow/product/store.js";
import { productWorkspace } from "../../unit/support/product-workspace.js";

const projects: Awaited<ReturnType<typeof productWorkspace>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const p of projects.splice(0)) await p.workspace.destroy();
});

async function setup(
  options: {
    greenfield?: boolean;
    mode?: "auto" | "on" | "off";
    python?: boolean;
    test?: string;
    beforeWork?: string;
    timeoutMs?: number;
    baselineFiles?: Record<string, string>;
    beforeWorkFiles?: Record<string, string>;
    djangoReference?: string;
    command?: string[];
    verifierFiles?: string[];
    files?: string[];
  } = {},
) {
  const p = await productWorkspace({ flip: true });
  projects.push(p);
  const w = p.workspace;
  if (options.greenfield) await rm(join(w.root, "src/value.mjs"));
  if (options.python) await w.write("src/value.py", "value = 1\n");
  await writeFixtureFiles(w, options.baselineFiles);
  if (options.djangoReference)
    await cp(join(options.djangoReference, "django"), join(w.root, "django"), { recursive: true });
  if (options.test) await w.write("test/value.test.mjs", options.test);
  w.commit("baseline");
  const state = await w.state();
  if (options.mode) {
    const text = await readFile(state.paths.config, "utf8");
    await w.write("visp.yml", text.replace("flipCheck: auto", `flipCheck: ${options.mode}`));
    w.commit("flip setting");
  }
  const updated = await updateProductBrief(await w.state(), {
    brief: {
      ...p.brief,
      checks: [
        {
          ...p.brief.checks[0],
          ...(options.command ? { command: options.command } : {}),
          ...(options.verifierFiles ? { verifierFiles: options.verifierFiles } : {}),
          ...(options.files ? { files: options.files } : {}),
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.python
            ? {
                command: ["python3", "tests/test_value.py"],
                environment: "other",
                files: ["src/value.py", "tests/**"],
              }
            : {}),
        },
      ],
      slices: [{ ...p.brief.slices[0], scope: { allowed: ["**"], expected: [], forbidden: [] } }],
    },
    reason: "Exercise regression flip",
  });
  if (!updated.ok) throw new Error(updated.error.message);
  await writeFixtureFiles(w, options.beforeWorkFiles);
  if (options.beforeWork) await w.write("src/value.mjs", options.beforeWork);
  expect((await runProductWork(await w.state(), { task: "T001" })).ok).toBe(true);
  await w.write(
    options.python ? "src/value.py" : "src/value.mjs",
    options.python ? "value = 2\n" : "export const value = 2;\n",
  );
  if (options.python)
    await w.write(
      "tests/test_value.py",
      "import importlib.util\ns = importlib.util.spec_from_file_location('value', 'src/value.py')\nm = importlib.util.module_from_spec(s)\ns.loader.exec_module(m)\nassert m.value == 2\nprint('1 passed')\n",
    );
  return w;
}
async function verify(w: Awaited<ReturnType<typeof setup>>, done = false) {
  const result = await (done ? runProductDone : runProductVerify)(await w.state(), {
    task: "T001",
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

it.each([false, true])(
  "keeps the new regression test while reverting implementation (python=%s)",
  async (python) => {
    const w = await setup(
      python
        ? { python: true }
        : {
            command: [process.execPath, "--test"],
            test: "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; test('existing type',()=>assert.equal(typeof value,'number'));\n",
          },
    );
    if (!python)
      await w.write(
        "test/new-regression.test.mjs",
        "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; test('new regression',()=>assert.equal(value,2));\n",
      );
    const before = w.git("status", "--porcelain");
    const result = await verify(w, true);
    expect(result.executions[0]).toMatchObject({
      status: "passed",
      flip: {
        failsWithoutChange: true,
        signal: "behavioral",
        revertedFiles: [python ? "src/value.py" : "src/value.mjs"],
      },
    });
    expect(w.git("status", "--porcelain")).toBe(before);
    expect(w.git("worktree", "list").trim().split("\n")).toHaveLength(1);
    expect(
      await readFile(join(w.root, python ? "src/value.py" : "src/value.mjs"), "utf8"),
    ).toContain("2");
  },
);

it("discloses a check that passes both ways in advice and reviewer packets, without gating", async () => {
  const w = await setup({
    test: "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; test('existing type',()=>assert.equal(typeof value,'number'));\n",
  });
  const result = await verify(w, true);
  expect(result.passed).toBe(true);
  expect(result.executions[0]).toMatchObject({ flip: { failsWithoutChange: false } });
  expect(JSON.stringify(result.next)).toContain("also passes with your source change reverted");
  expect(JSON.stringify(await runProductNext(await w.state(), { task: "T001" }))).toContain(
    "Add a test that fails on the old code and passes now",
  );
  const review = await runProductReviewRequest(await w.state(), { prepare: true, task: "T001" });
  if (!review.ok) throw new Error(review.error.message);
  const packet = await readFile((review.value as { packetPath: string }).packetPath, "utf8");
  expect(packet).toContain(
    "Without the change (implementation reverted to the work-authorization baseline, tests kept): passed",
  );
  expect(packet).toContain("does not demonstrate the requested change");
});

it.each([{ greenfield: true }, { mode: "off" as const }])(
  "does not add flip metadata when skipped: %j",
  async (options) => {
    const w = await setup(options);
    expect((await verify(w)).executions[0]).not.toHaveProperty("flip");
  },
);

it("uses a persistent cache even when verify reruns the original check", async () => {
  const w = await setup();
  const first = await verify(w);
  const second = await verify(w);
  expect(first.executions[0]?.flip).toBeDefined();
  expect(second.executions[0]?.flip).toEqual(first.executions[0]?.flip);
  expect(second.executions[0]).toMatchObject({ flipDurationMs: 0 });
});

it("reports unrecoverable dirty authorization bytes as unchecked", async () => {
  const w = await setup({ beforeWork: "export const value = 3;\n" });
  expect((await verify(w)).executions[0]).toMatchObject({
    flip: { failsWithoutChange: "unchecked", reason: expect.stringContaining("baseline bytes") },
  });
});

it("loads old state with no flip metadata", async () => {
  const w = await setup({ mode: "off" });
  await verify(w);
  expect((await readProductRecord(await w.state(), {})).ok).toBe(true);
});

it("never turns a missing external dependency into a regression failure", async () => {
  const w = await setup({
    baselineFiles: {
      "src/value.mjs": "import 'b29a-missing-dependency'; export const value = 1;\n",
    },
  });
  expect((await verify(w)).executions[0]).toMatchObject({
    status: "passed",
    flip: {
      failsWithoutChange: "unchecked",
      reason: expect.stringContaining("environment/setup failure"),
    },
  });
});

it("reports added implementation absence as structural in on mode", async () => {
  const w = await setup({ greenfield: true, mode: "on" });
  expect((await verify(w)).executions[0]).toMatchObject({
    status: "passed",
    flip: { failsWithoutChange: true, signal: "structural", failedToLoad: true },
  });
});

it("invalidates the cache when the implementation or preserved tests change", async () => {
  const w = await setup();
  const first = (await verify(w)).executions[0];
  await w.write(
    "test/value.test.mjs",
    "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; test('updated regression',()=>assert.equal(value,2));\n",
  );
  const second = (await verify(w)).executions[0];
  expect(second?.flipCacheKey).not.toBe(first?.flipCacheKey);
  expect(second?.flipDurationMs).toBeGreaterThan(0);
  await w.write("src/value.mjs", "export const value = 2; // another source state\n");
  const third = (await verify(w)).executions[0];
  expect(third?.flipCacheKey).not.toBe(second?.flipCacheKey);
  expect(third?.flipDurationMs).toBeGreaterThan(0);
});

it("uses the authorization commit even after the fix is committed", async () => {
  const w = await setup();
  w.commit("commit source change");
  expect((await verify(w)).executions[0]).toMatchObject({ flip: { failsWithoutChange: true } });
});

it("recovers an unchanged dirty baseline overlay instead of substituting HEAD", async () => {
  const w = await setup({
    baselineFiles: { "src/helper.mjs": "export const helper = 1;\n" },
    beforeWorkFiles: { "src/helper.mjs": "export const helper = 2;\n" },
    test: "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; import {helper} from '../src/helper.mjs'; test('regression',()=>assert.equal(value, helper));\n",
  });
  expect((await verify(w)).executions[0]).toMatchObject({ flip: { failsWithoutChange: true } });
});

it("cleans up on the check's own timeout and leaves the user tree untouched", async () => {
  const w = await setup({
    timeoutMs: 1500,
    test: "import {value} from '../src/value.mjs'; if(value===1) await new Promise(r=>setTimeout(r,30000));\n",
  });
  const before = w.git("status", "--porcelain");
  expect((await verify(w)).executions[0]).toMatchObject({
    status: "passed",
    flip: { failsWithoutChange: "unchecked", reason: expect.stringContaining("timed out") },
  });
  expect(w.git("status", "--porcelain")).toBe(before);
  expect(w.git("worktree", "list").trim().split("\n")).toHaveLength(1);
  expect(await readFile(join(w.root, "src/value.mjs"), "utf8")).toBe("export const value = 2;\n");
});

it("cleans up an interrupted reverted run without changing the user's tree", async () => {
  const w = await setup({
    test: "import {value} from '../src/value.mjs'; if(value===1) await new Promise(r=>setTimeout(r,30000));\n",
  });
  const controller = new AbortController();
  const exec = await import("../../../src/core/exec.js");
  const original = exec.run;
  let flipped = false;
  vi.spyOn(exec, "run").mockImplementation((file, args, options) => {
    if (options.cwd.includes("visp-product-flip-") && file === process.execPath) {
      flipped = true;
      setTimeout(() => controller.abort(), 100);
    }
    return original(file, args, options);
  });
  const before = w.git("status", "--porcelain");
  const result = await runProductVerify(await w.state(), {
    task: "T001",
    signal: controller.signal,
  });
  expect(flipped).toBe(true);
  expect(result).toMatchObject({ ok: false, error: { details: { cancelled: true } } });
  expect(w.git("status", "--porcelain")).toBe(before);
  expect(w.git("worktree", "list").trim().split("\n")).toHaveLength(1);
});

it("reverts test-shaped implementation imported by production code even if declared as validation", async () => {
  const w = await setup({
    baselineFiles: {
      "tests/helper.mjs": "export const helper = 1;\n",
      "src/value.mjs": "import {helper} from '../tests/helper.mjs'; export const value = helper;\n",
    },
  });
  await w.write(
    "src/value.mjs",
    "import {helper} from '../tests/helper.mjs'; export const value = helper;\n",
  );
  await w.write("tests/helper.mjs", "export const helper = 2;\n");
  expect((await verify(w)).executions[0]).toMatchObject({
    status: "passed",
    flip: { failsWithoutChange: true, revertedFiles: ["tests/helper.mjs"] },
  });
});

it("copies untracked environment directories needed by the check", async () => {
  const w = await setup({
    baselineFiles: { ".gitignore": "node_modules/\n.venv/\nvenv/\nvendor/\n" },
    test: "import {readFileSync} from 'node:fs'; import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; for (const name of ['node_modules','.venv','venv','vendor']) assert.equal(readFileSync(name+'/fixture','utf8'),'support'); assert.equal(value,2);\n",
  });
  for (const name of ["node_modules", ".venv", "venv", "vendor"])
    await w.write(`${name}/fixture`, "support");
  expect((await verify(w)).executions[0]).toMatchObject({
    status: "passed",
    flip: { failsWithoutChange: true },
  });
  for (const name of ["node_modules", ".venv", "venv", "vendor"])
    expect(await readFile(join(w.root, name, "fixture"), "utf8")).toBe("support");
});

const djangoReference = process.env.VISP_FLIP_DJANGO_REFERENCE;
it.runIf(!!djangoReference)(
  "flips a truthy-predicate fix in a real Django source copy",
  async () => {
    const w = await setup({ python: true, djangoReference });
    await w.write("src/value.py", "value = 1\n");
    const loaded = await readProductRecord(await w.state(), {});
    if (!loaded.ok) throw new Error(loaded.error.message);
    const updated = await updateProductBrief(await w.state(), {
      brief: {
        ...loaded.value.brief,
        checks: [
          {
            ...loaded.value.brief.checks[0],
            command: ["python3", "tests/test_partition.py"],
            files: ["django/utils/functional.py", "tests/**"],
          },
        ],
      },
      reason: "Regress truthy predicates",
    });
    if (!updated.ok) throw new Error(updated.error.message);
    expect((await runProductWork(await w.state(), { task: "T001" })).ok).toBe(true);
    const path = "django/utils/functional.py";
    const old = await readFile(join(w.root, path), "utf8");
    await w.write(
      path,
      old.replace(
        "results[predicate(item)].append(item)",
        "results[bool(predicate(item))].append(item)",
      ),
    );
    await w.write(
      "tests/test_partition.py",
      "import importlib.util, unittest\ns=importlib.util.spec_from_file_location('functional','django/utils/functional.py')\nm=importlib.util.module_from_spec(s)\ns.loader.exec_module(m)\nclass Regression(unittest.TestCase):\n def test_truthy_predicate(self):\n  self.assertEqual(m.partition(lambda x: 'yes' if x > 1 else '', [0,1,2]), ([0,1],[2]))\nunittest.main()\n",
    );
    const result = await verify(w);
    console.info(
      `Real Django copy: original=${result.executions[0]?.durationMs}ms, flip=${result.executions[0]?.flipDurationMs}ms; ${JSON.stringify(result.executions[0]?.flip)}`,
    );
    expect(result.executions[0]).toMatchObject({
      status: "passed",
      flip: { failsWithoutChange: true, signal: "behavioral", revertedFiles: [path] },
    });
  },
  180_000,
);

const developRuntime = process.env.VISP_FLIP_DEVELOP_RUNTIME;
it.runIf(!!developRuntime)(
  "keeps greenfield execution, state and prepared packet bytes identical to develop",
  async () => {
    const w = await setup({ greenfield: true, command: [process.execPath, "-e", ""] });
    const workspace = await w.state();
    const loaded = await readProductRecord(workspace, {});
    if (!loaded.ok) throw new Error(loaded.error.message);
    const record = loaded.value;
    const subject = await import("../../../src/workflow/product/subject.js");
    const digest = await subject.productSourceDigest(workspace, record.brief);
    if (!digest.ok) throw new Error(digest.error.message);
    const current = await import("../../../src/workflow/product/check/check-execution.js");
    const legacy = (await import(/* @vite-ignore */ developRuntime as string)) as typeof current & {
      runProductReviewRequest: typeof runProductReviewRequest;
      saveProductState: typeof import("../../../src/workflow/product/store.js").saveProductState;
    };
    const check = record.brief.checks[0];
    if (!check) throw new Error("missing fixture check");
    const old = await legacy.executeProductCheck(
      workspace,
      record,
      record.brief.slices[0],
      check,
      digest.value,
    );
    const now = await current.executeProductCheck(
      workspace,
      record,
      record.brief.slices[0],
      check,
      digest.value,
    );
    // Execution ids and clocks are independent of the implementation being compared.
    const stable = (entry: typeof now.execution) => ({
      ...entry,
      id: "greenfield-receipt",
      createdAt: "2026-01-01T00:00:00.000Z",
      durationMs: 0,
    });
    expect(JSON.stringify(stable(now.execution))).toBe(JSON.stringify(stable(old.execution)));
    expect(JSON.stringify({ ...now.state, executions: [stable(now.execution)] })).toBe(
      JSON.stringify({ ...old.state, executions: [stable(old.execution)] }),
    );
    const store = await import("../../../src/workflow/product/store.js");
    const oldSaved = await legacy.saveProductState(workspace, record, {
      ...old.state,
      executions: [stable(old.execution)],
    });
    if (!oldSaved.ok) throw new Error(oldSaved.error.message);
    const oldStateBytes = await readFile(store.productStatePath(workspace, record.brief.feature));
    const beforeNew = await readProductRecord(workspace, {});
    if (!beforeNew.ok) throw new Error(beforeNew.error.message);
    const saved = await store.saveProductState(workspace, beforeNew.value, {
      ...now.state,
      executions: [stable(now.execution)],
    });
    if (!saved.ok) throw new Error(saved.error.message);
    const newStateBytes = await readFile(store.productStatePath(workspace, record.brief.feature));
    expect(newStateBytes.equals(oldStateBytes)).toBe(true);
    const baseline = await legacy.runProductReviewRequest(workspace, {
      prepare: true,
      task: "T001",
    });
    const changed = await runProductReviewRequest(workspace, { prepare: true, task: "T001" });
    if (!baseline.ok || !changed.ok) throw new Error("could not prepare compatibility packets");
    const oldText = await readFile((baseline.value as { packetPath: string }).packetPath, "utf8");
    const newText = await readFile((changed.value as { packetPath: string }).packetPath, "utf8");
    expect(newText).toBe(oldText);
    console.info(
      `Greenfield develop parity: state=${newStateBytes.length} bytes; packet=${newText.length} bytes, byte-identical`,
    );
  },
);

async function writeFixtureFiles(
  w: Awaited<ReturnType<typeof productWorkspace>>["workspace"],
  files?: Record<string, string>,
) {
  for (const [path, content] of Object.entries(files ?? {})) await w.write(path, content);
}

it("fills an old passing execution on done without rerunning it or creating evidence", async () => {
  const w = await setup();
  const before = await verify(w);
  const workspace = await w.state();
  const store = await import("../../../src/workflow/product/store.js");
  const record = await readProductRecord(workspace, {});
  if (!record.ok) throw new Error(record.error.message);
  const legacy = record.value.state.executions.map((entry) => {
    const copy = { ...entry };
    delete copy.flip;
    delete copy.flipCacheKey;
    delete copy.flipDurationMs;
    return copy;
  });
  expect(
    (
      await store.saveProductState(workspace, record.value, {
        ...record.value.state,
        executions: legacy,
      })
    ).ok,
  ).toBe(true);
  const exec = await import("../../../src/core/exec.js");
  const runs = vi.spyOn(exec, "run");
  const done = await verify(w, true);
  expect(done.executions).toEqual([]);
  expect(done.flipDurationMs).toBeGreaterThan(0);
  expect(
    runs.mock.calls.filter(
      ([file, , options]) => file === process.execPath && options.cwd === w.root,
    ),
  ).toHaveLength(0);
  const after = await readProductRecord(await w.state(), {});
  expect(after).toMatchObject({
    ok: true,
    value: {
      state: { executions: [{ id: before.executions[0]?.id, flip: { failsWithoutChange: true } }] },
    },
  });
});

it("does not preserve implementation merely because a syntax command names it", async () => {
  const w = await setup({ command: [process.execPath, "--check", "src/value.mjs"] });
  expect((await verify(w)).executions[0]).toMatchObject({
    flip: { failsWithoutChange: false, revertedFiles: ["src/value.mjs"] },
  });
});

it("keeps declared validation helpers outside test directories while reverting implementation", async () => {
  const w = await setup({
    command: [process.execPath, "quality/run.mjs"],
    files: ["src/**", "quality/**"],
    baselineFiles: {
      "quality/run.mjs": "import './helper.mjs';\n",
      "quality/helper.mjs": "throw new Error('old assertion helper');\n",
    },
  });
  await w.write(
    "quality/helper.mjs",
    "import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; assert.equal(value,2);\n",
  );
  expect((await verify(w)).executions[0]).toMatchObject({
    flip: {
      failsWithoutChange: true,
      signal: "behavioral",
      revertedFiles: ["src/value.mjs"],
      preservedValidationFiles: expect.arrayContaining(["quality/helper.mjs", "quality/run.mjs"]),
    },
  });
});

it("reverts a standalone implementation even when check.files names it", async () => {
  const w = await setup({
    command: [process.execPath, "test/root.test.mjs"],
    files: ["value.mjs", "test/**"],
    baselineFiles: {
      "value.mjs": "export const value = 1;\n",
      "test/root.test.mjs":
        "import assert from 'node:assert/strict'; import {value} from '../value.mjs'; assert.equal(value,2);\n",
    },
  });
  // The conventional source file stays at its baseline; only the standalone module changes.
  await w.write("src/value.mjs", "export const value = 1;\n");
  await w.write("value.mjs", "export const value = 2;\n");
  expect((await verify(w)).executions[0]).toMatchObject({
    flip: { failsWithoutChange: true, revertedFiles: ["value.mjs"] },
  });
});

it("reports a node:test before-hook failure in the reverted run as unchecked, not a positive flip", async () => {
  const w = await setup({
    command: [process.execPath, "--test"],
    test: "import {before, test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; before(() => { if (value !== 2) throw new Error('fixture data.json is missing'); }); test('value', () => assert.equal(value, 2));\n",
  });
  expect((await verify(w)).executions[0]).toMatchObject({
    status: "passed",
    flip: { failsWithoutChange: "unchecked", revertedFiles: ["src/value.mjs"] },
  });
});

async function changeAfterBaseline(
  w: Awaited<ReturnType<typeof productWorkspace>>["workspace"],
  p: Awaited<ReturnType<typeof productWorkspace>>,
  file: string,
  reason: string,
) {
  const updated = await updateProductBrief(await w.state(), {
    brief: {
      ...p.brief,
      checks: [
        {
          ...p.brief.checks[0],
          command: [process.execPath, file],
          files: ["test/**"],
          timeoutMs: 20000,
        },
      ],
      slices: [{ ...p.brief.slices[0], scope: { allowed: ["**"], expected: [], forbidden: [] } }],
    },
    reason,
  });
  expect(updated.ok).toBe(true);
  expect((await runProductWork(await w.state(), { task: "T001" })).ok).toBe(true);
}

it("reports git-ignored local state the check reads as unchecked, without a comparison", async () => {
  const p = await productWorkspace({ flip: true });
  projects.push(p);
  const w = p.workspace;
  await w.write(".gitignore", "node_modules/\nlocal/\n");
  await w.write("src/value.mjs", "export const value = 1;\n");
  await w.write(
    "test/local.test.mjs",
    "import assert from 'node:assert/strict'; import {existsSync} from 'node:fs'; import {value} from '../src/value.mjs'; assert.equal(value + (existsSync('local/flag') ? 1 : 0), 2);\n",
  );
  await mkdir(join(w.root, "local"), { recursive: true });
  await writeFile(join(w.root, "local/flag"), "1");
  w.commit("review baseline");
  await changeAfterBaseline(w, p, "test/local.test.mjs", "Exercise git-ignored local state");
  await w.write("src/value.mjs", "export const value = 1; // cosmetic change, no behavior\n");
  expect((await verify(w)).executions[0]).toMatchObject({
    status: "passed",
    flip: {
      failsWithoutChange: "unchecked",
      revertedFiles: ["src/value.mjs"],
      reason: "the project has git-ignored local state the comparison cannot reproduce: local",
    },
  });
  expect(await readFile(join(w.root, "local/flag"), "utf8")).toBe("1");
});

it("does not let a reverted run reach a .env that points into the user's project", async () => {
  const p = await productWorkspace({ flip: true });
  projects.push(p);
  const w = p.workspace;
  await w.write(".gitignore", ".env\nlocal/\nnode_modules/\n");
  await w.write("src/value.mjs", "export const value = 1;\n");
  await w.write(
    "test/escape.test.mjs",
    "import {value} from '../src/value.mjs'; import {readFileSync, writeFileSync} from 'node:fs'; import assert from 'node:assert/strict'; if (value === 1) { const target = readFileSync('.env', 'utf8').match(/COUNTER=(.*)/)[1].trim(); writeFileSync(target, String(Number(readFileSync(target, 'utf8')) + 1)); } assert.equal(value, 2);\n",
  );
  await mkdir(join(w.root, "local"), { recursive: true });
  await writeFile(join(w.root, "local/counter"), "0");
  await writeFile(join(w.root, ".env"), `COUNTER=${join(w.root, "local/counter")}\n`);
  w.commit("review baseline");
  await changeAfterBaseline(w, p, "test/escape.test.mjs", "Exercise an ignored .env");
  await w.write("src/value.mjs", "export const value = 2;\n");
  expect((await verify(w)).executions[0]).toMatchObject({
    flip: { failsWithoutChange: "unchecked", reason: expect.stringContaining(".env") },
  });
  expect(await readFile(join(w.root, "local/counter"), "utf8")).toBe("0");
});

it("removes a read-only directory from the comparison tree without leaving a temporary tree", async () => {
  const p = await productWorkspace({ flip: true });
  projects.push(p);
  const w = p.workspace;
  const privateTemp = await mkdtemp(join(tmpdir(), "visp-flip-temp-"));
  await w.write(".gitignore", "node_modules/\n");
  await w.write("src/value.mjs", "export const value = 1;\n");
  await w.write(
    "test/locked.test.mjs",
    "import {readFileSync} from 'node:fs'; import {value} from '../src/value.mjs'; import assert from 'node:assert/strict'; assert.equal(readFileSync('node_modules/locked/file.txt', 'utf8'), 'support'); assert.equal(value, 2);\n",
  );
  await mkdir(join(w.root, "node_modules/locked"), { recursive: true });
  await writeFile(join(w.root, "node_modules/locked/file.txt"), "support");
  w.commit("review baseline");
  await changeAfterBaseline(
    w,
    p,
    "test/locked.test.mjs",
    "Exercise a read-only environment directory",
  );
  await chmod(join(w.root, "node_modules/locked"), 0o555);
  try {
    await w.write("src/value.mjs", "export const value = 2;\n");
    vi.stubEnv("TMPDIR", privateTemp);
    try {
      expect((await verify(w)).executions[0]).toMatchObject({
        flip: { failsWithoutChange: true, revertedFiles: ["src/value.mjs"] },
      });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(
      (await readdir(privateTemp)).filter((name) =>
        /^visp-(product-flip|flip-environment)/.test(name),
      ),
    ).toEqual([]);
  } finally {
    await chmod(join(w.root, "node_modules/locked"), 0o755);
    await rm(privateTemp, { recursive: true, force: true });
  }
});

it.each([false, true])(
  "keeps a recorded flip when unrelated environment drifts, without rerunning the reverted check (node_modules=%s)",
  async (withNodeModules) => {
    const p = await productWorkspace({ flip: true });
    projects.push(p);
    const w = p.workspace;
    const scratch = await mkdtemp(join(tmpdir(), "visp-flip-drift-"));
    const log = join(scratch, "runs.log");
    const lines = async () =>
      (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
    try {
      await w.write(".gitignore", "node_modules/\n");
      await w.write("src/value.mjs", "export const value = 1;\n");
      await w.write(
        "test/drift.test.mjs",
        `import {value} from '../src/value.mjs'; import assert from 'node:assert/strict'; import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(log)}, value === 2 ? 'current\\n' : 'reverted\\n'); assert.equal(value, 2);\n`,
      );
      w.commit("review baseline");
      const updated = await updateProductBrief(await w.state(), {
        brief: {
          ...p.brief,
          checks: [
            {
              ...p.brief.checks[0],
              command: [process.execPath, "test/drift.test.mjs"],
              files: ["test/**"],
              timeoutMs: 20000,
            },
          ],
          slices: [
            { ...p.brief.slices[0], scope: { allowed: ["**"], expected: [], forbidden: [] } },
          ],
        },
        reason: "Exercise environment drift",
      });
      expect(updated.ok).toBe(true);
      expect((await runProductWork(await w.state(), { task: "T001" })).ok).toBe(true);
      if (withNodeModules) {
        await mkdir(join(w.root, "node_modules/cache"), { recursive: true });
        await writeFile(join(w.root, "node_modules/cache/x"), "1");
      }
      await w.write("src/value.mjs", "export const value = 2;\n");
      expect((await verify(w)).executions[0]).toMatchObject({
        flip: { failsWithoutChange: true },
      });
      expect(await lines()).toEqual(["current", "reverted"]);
      vi.stubEnv("VISP_FLIP_DRIFT_PROBE", `drift-${Date.now()}`);
      expect((await verify(w, true)).executions).toEqual([]);
      expect(await lines()).toEqual(["current", "reverted"]);
      const record = await readProductRecord(await w.state(), {});
      expect(record).toMatchObject({
        ok: true,
        value: { state: { executions: [{ flip: { failsWithoutChange: true } }] } },
      });
    } finally {
      vi.unstubAllEnvs();
      await rm(scratch, { recursive: true, force: true });
    }
  },
);

it("never fails the original check when the advisory's temporary directory is unusable", async () => {
  const w = await setup();
  vi.stubEnv("TMPDIR", "/nonexistent-visp-flip-tmp");
  try {
    const result = await runProductVerify(await w.state(), { task: "T001" });
    expect(result.ok).toBe(true);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("does not fail done when a recorded flip cannot be refreshed", async () => {
  const w = await setup();
  expect((await verify(w)).executions[0]?.flip?.failsWithoutChange).toBe(true);
  vi.stubEnv("TMPDIR", "/nonexistent-visp-done-tmp");
  try {
    const done = await runProductDone(await w.state(), { task: "T001" });
    expect(done.ok).toBe(true);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("does not report a missing regenerable build artifact as a regression", async () => {
  const p = await productWorkspace({ flip: true });
  projects.push(p);
  const w = p.workspace;
  await w.write(".gitignore", "dist/\nnode_modules/\n");
  await w.write("src/value.mjs", "export const value = 1;\n");
  await w.write(
    "test/cli.test.mjs",
    "import {spawnSync} from 'node:child_process'; import assert from 'node:assert/strict'; const r = spawnSync(process.execPath, ['dist/cli.mjs'], {encoding: 'utf8'}); assert.equal(r.stdout.trim(), '2');\n",
  );
  await mkdir(join(w.root, "dist"), { recursive: true });
  await writeFile(join(w.root, "dist/cli.mjs"), "console.log('2');\n");
  w.commit("review baseline");
  await changeAfterBaseline(w, p, "test/cli.test.mjs", "Exercise a regenerable build artifact");
  await w.write("src/value.mjs", "export const value = 1; // cosmetic change, no behavior\n");
  expect((await verify(w)).executions[0]).toMatchObject({
    status: "passed",
    flip: { failsWithoutChange: false, revertedFiles: ["src/value.mjs"] },
  });
});

it("copies regenerable nested state under a tracked directory into the comparison", async () => {
  const p = await productWorkspace({ flip: true });
  projects.push(p);
  const w = p.workspace;
  await w.write(".gitignore", ".cache/\nnode_modules/\n");
  await w.write("local/keep.txt", "tracked\n");
  await w.write("src/value.mjs", "export const value = 1;\n");
  await w.write(
    "test/nested.test.mjs",
    "import assert from 'node:assert/strict'; import {existsSync} from 'node:fs'; import {value} from '../src/value.mjs'; assert.equal(value + (existsSync('local/.cache/flag') ? 1 : 0), 2);\n",
  );
  await mkdir(join(w.root, "local/.cache"), { recursive: true });
  await writeFile(join(w.root, "local/.cache/flag"), "1");
  w.commit("review baseline");
  await changeAfterBaseline(w, p, "test/nested.test.mjs", "Exercise nested regenerable state");
  await w.write("src/value.mjs", "export const value = 1; // cosmetic change, no behavior\n");
  expect((await verify(w)).executions[0]).toMatchObject({
    status: "passed",
    flip: { failsWithoutChange: false, revertedFiles: ["src/value.mjs"] },
  });
});

it("blocks a comparison on nested state under a wholly ignored directory that is not regenerable", async () => {
  const p = await productWorkspace({ flip: true });
  projects.push(p);
  const w = p.workspace;
  await w.write(".gitignore", "local/.cache/\nnode_modules/\n");
  await w.write("src/value.mjs", "export const value = 1;\n");
  await w.write(
    "test/nested.test.mjs",
    "import assert from 'node:assert/strict'; import {existsSync} from 'node:fs'; import {value} from '../src/value.mjs'; assert.equal(value + (existsSync('local/.cache/flag') ? 1 : 0), 2);\n",
  );
  await mkdir(join(w.root, "local/.cache"), { recursive: true });
  await writeFile(join(w.root, "local/.cache/flag"), "1");
  w.commit("review baseline");
  await changeAfterBaseline(w, p, "test/nested.test.mjs", "Exercise nested local state");
  await w.write("src/value.mjs", "export const value = 1; // cosmetic change, no behavior\n");
  expect((await verify(w)).executions[0]).toMatchObject({
    flip: {
      failsWithoutChange: "unchecked",
      reason: "the project has git-ignored local state the comparison cannot reproduce: local",
    },
  });
});

it("runs no comparison when a tracked file names the project by absolute path", async () => {
  const p = await productWorkspace({ flip: true });
  projects.push(p);
  const w = p.workspace;
  await w.write(".gitignore", "node_modules/\n");
  await w.write("src/value.mjs", "export const value = 1;\n");
  await w.write("config.json", `${JSON.stringify({ counter: join(w.root, "counter.txt") })}\n`);
  await w.write("counter.txt", "0");
  await w.write(
    "test/cfg.test.mjs",
    "import {readFileSync, writeFileSync} from 'node:fs'; import {value} from '../src/value.mjs'; import assert from 'node:assert/strict'; const target = JSON.parse(readFileSync('config.json','utf8')).counter; const n = Number(readFileSync(target,'utf8')); writeFileSync(target, String(n + 1)); assert.equal(n, 0); assert.equal(value, 2);\n",
  );
  w.commit("review baseline");
  await changeAfterBaseline(w, p, "test/cfg.test.mjs", "Exercise a tracked absolute path");
  await w.write("src/value.mjs", "export const value = 2;\n");
  expect((await verify(w)).executions[0]).toMatchObject({
    flip: {
      failsWithoutChange: "unchecked",
      reason:
        "config.json refers to the project by absolute path; the comparison could change the project",
    },
  });
  // Only the original run wrote the counter; the comparison never ran the check on the old code.
  expect(await readFile(join(w.root, "counter.txt"), "utf8")).toBe("1");
});

// A copied file that names the project is rebased to the comparison, so the comparison still runs
// and never reaches the user's file: the counter below is written only by the reverted run.
const COUNT_ONLY_REVERTED = (variable: string) =>
  `if (value === 1) writeFileSync(${variable}, String(Number(readFileSync(${variable}, 'utf8')) + 1));`;

it("rebases a copied regenerable file that names the project, so the comparison runs without the user's file", async () => {
  const p = await productWorkspace({ flip: true });
  projects.push(p);
  const w = p.workspace;
  await w.write(".gitignore", "dist/\nnode_modules/\n");
  await w.write("src/value.mjs", "export const value = 1;\n");
  await mkdir(join(w.root, "dist"), { recursive: true });
  await writeFile(join(w.root, "dist/counter.txt"), "0");
  await writeFile(
    join(w.root, "dist/config.json"),
    `${JSON.stringify({ counter: join(w.root, "dist/counter.txt") })}\n`,
  );
  await w.write(
    "test/dist-config.test.mjs",
    `import {readFileSync, writeFileSync} from 'node:fs'; import {value} from '../src/value.mjs'; import assert from 'node:assert/strict'; const target = JSON.parse(readFileSync('dist/config.json','utf8')).counter; ${COUNT_ONLY_REVERTED("target")} assert.equal(value, 2);\n`,
  );
  w.commit("review baseline");
  await changeAfterBaseline(
    w,
    p,
    "test/dist-config.test.mjs",
    "Exercise a copied regenerable file",
  );
  await w.write("src/value.mjs", "export const value = 2;\n");
  expect((await verify(w)).executions[0]).toMatchObject({
    flip: { failsWithoutChange: true, revertedFiles: ["src/value.mjs"] },
  });
  expect(await readFile(join(w.root, "dist/counter.txt"), "utf8")).toBe("0");
});

it("reports a tracked file over 1 MiB that names the project as unchecked, without the comparison", async () => {
  const p = await productWorkspace({ flip: true });
  projects.push(p);
  const w = p.workspace;
  await w.write(".gitignore", "node_modules/\n");
  await w.write("src/value.mjs", "export const value = 1;\n");
  await w.write("counter.txt", "0");
  // Many short lines, so the 1.2 MB file is read in steps and its path sits past the first step.
  await w.write(
    "config.json",
    `${Array.from({ length: 20_000 }, () => "x".repeat(59)).join("\n")}\n${JSON.stringify({ counter: join(w.root, "counter.txt") })}\n`,
  );
  await w.write(
    "test/big-config.test.mjs",
    `import {readFileSync, writeFileSync} from 'node:fs'; import {value} from '../src/value.mjs'; import assert from 'node:assert/strict'; const target = JSON.parse(readFileSync('config.json','utf8').trim().split('\\n').at(-1)).counter; ${COUNT_ONLY_REVERTED("target")} assert.equal(value, 2);\n`,
  );
  w.commit("review baseline");
  await changeAfterBaseline(w, p, "test/big-config.test.mjs", "Exercise a large tracked config");
  await w.write("src/value.mjs", "export const value = 2;\n");
  expect((await verify(w)).executions[0]).toMatchObject({
    flip: {
      failsWithoutChange: "unchecked",
      reason:
        "config.json refers to the project by absolute path; the comparison could change the project",
    },
  });
  expect(await readFile(join(w.root, "counter.txt"), "utf8")).toBe("0");
});

it("rebases an environment module that names the project, so the comparison runs", async () => {
  const p = await productWorkspace({ flip: true });
  projects.push(p);
  const w = p.workspace;
  await w.write(".gitignore", "node_modules/\n");
  await w.write("src/value.mjs", "export const value = 1;\n");
  await mkdir(join(w.root, "node_modules/pkg"), { recursive: true });
  await writeFile(join(w.root, "node_modules/pkg/counter.txt"), "0");
  await writeFile(
    join(w.root, "node_modules/pkg/index.json"),
    `${JSON.stringify({ counter: join(w.root, "node_modules/pkg/counter.txt") })}\n`,
  );
  await w.write(
    "test/env-module.test.mjs",
    `import {readFileSync, writeFileSync} from 'node:fs'; import {value} from '../src/value.mjs'; import assert from 'node:assert/strict'; const target = JSON.parse(readFileSync('node_modules/pkg/index.json','utf8')).counter; ${COUNT_ONLY_REVERTED("target")} assert.equal(value, 2);\n`,
  );
  w.commit("review baseline");
  await changeAfterBaseline(w, p, "test/env-module.test.mjs", "Exercise an environment module");
  await w.write("src/value.mjs", "export const value = 2;\n");
  expect((await verify(w)).executions[0]).toMatchObject({
    flip: { failsWithoutChange: true, revertedFiles: ["src/value.mjs"] },
  });
  expect(await readFile(join(w.root, "node_modules/pkg/counter.txt"), "utf8")).toBe("0");
});

it("rebases a pnpm-style node_modules/.modules.yaml that names the project, so the comparison runs", async () => {
  const p = await productWorkspace({ flip: true });
  projects.push(p);
  const w = p.workspace;
  await w.write(".gitignore", "node_modules/\n");
  await w.write("src/value.mjs", "export const value = 1;\n");
  await mkdir(join(w.root, "node_modules"), { recursive: true });
  await writeFile(
    join(w.root, "node_modules/.modules.yaml"),
    `layoutVersion: 5\nlocation: ${join(w.root, "node_modules")}\n`,
  );
  await w.write(
    "test/modules.test.mjs",
    `import {readFileSync} from 'node:fs'; import {value} from '../src/value.mjs'; import assert from 'node:assert/strict'; const text = readFileSync('node_modules/.modules.yaml', 'utf8'); assert.ok(text.includes(process.cwd())); assert.equal(value, 2);\n`,
  );
  w.commit("review baseline");
  await changeAfterBaseline(w, p, "test/modules.test.mjs", "Exercise a pnpm module manifest");
  await w.write("src/value.mjs", "export const value = 2;\n");
  expect((await verify(w)).executions[0]).toMatchObject({
    flip: { failsWithoutChange: true, revertedFiles: ["src/value.mjs"] },
  });
});

it("rebases a Python virtualenv whose pyvenv.cfg and activate script name the project, so the comparison runs", async () => {
  const p = await productWorkspace({ flip: true });
  projects.push(p);
  const w = p.workspace;
  await w.write(".gitignore", ".venv/\n");
  await w.write("src/value.mjs", "export const value = 1;\n");
  await mkdir(join(w.root, ".venv/bin"), { recursive: true });
  await writeFile(join(w.root, ".venv/pyvenv.cfg"), `home = ${join(w.root, ".venv/bin")}\n`);
  await writeFile(join(w.root, ".venv/bin/activate"), `VIRTUAL_ENV="${join(w.root, ".venv")}"\n`);
  await w.write(
    "test/venv.test.mjs",
    `import {readFileSync} from 'node:fs'; import {value} from '../src/value.mjs'; import assert from 'node:assert/strict'; assert.ok(readFileSync('.venv/pyvenv.cfg', 'utf8').includes(process.cwd())); assert.ok(readFileSync('.venv/bin/activate', 'utf8').includes(process.cwd())); assert.equal(value, 2);\n`,
  );
  w.commit("review baseline");
  await changeAfterBaseline(w, p, "test/venv.test.mjs", "Exercise a Python virtualenv");
  await w.write("src/value.mjs", "export const value = 2;\n");
  expect((await verify(w)).executions[0]).toMatchObject({
    flip: { failsWithoutChange: true, revertedFiles: ["src/value.mjs"] },
  });
});

it("refuses a comparison when an environment binary names the project, and leaves it untouched", async () => {
  const p = await productWorkspace({ flip: true });
  projects.push(p);
  const w = p.workspace;
  await w.write(".gitignore", "node_modules/\n");
  await w.write("src/value.mjs", "export const value = 1;\n");
  await w.write(
    "test/blob.test.mjs",
    "import {value} from '../src/value.mjs'; import assert from 'node:assert/strict'; assert.equal(value, 2);\n",
  );
  await mkdir(join(w.root, "node_modules/bin"), { recursive: true });
  const blob = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(w.root)]);
  await writeFile(join(w.root, "node_modules/bin/blob.dat"), blob);
  w.commit("review baseline");
  await changeAfterBaseline(w, p, "test/blob.test.mjs", "Exercise an environment binary");
  await w.write("src/value.mjs", "export const value = 2;\n");
  expect((await verify(w)).executions[0]).toMatchObject({
    flip: {
      failsWithoutChange: "unchecked",
      reason:
        "node_modules/bin/blob.dat refers to the project by absolute path; the comparison could change the project",
    },
  });
  expect(await readFile(join(w.root, "node_modules/bin/blob.dat"))).toEqual(blob);
});

it("rebases the baseline bytes the comparison restores, so a baseline reference to the project never reaches the user's file", async () => {
  const p = await productWorkspace({ flip: true });
  projects.push(p);
  const w = p.workspace;
  await w.write(".gitignore", "node_modules/\n");
  await w.write("src/value.mjs", "export const value = 1;\n");
  await w.write("counter.txt", "0");
  // The committed implementation names the project by its absolute path; the worker changes it.
  await w.write("src/paths.json", `${JSON.stringify({ counter: join(w.root, "counter.txt") })}\n`);
  await w.write(
    "test/paths.test.mjs",
    `import {readFileSync, writeFileSync} from 'node:fs'; import {value} from '../src/value.mjs'; import assert from 'node:assert/strict'; const target = JSON.parse(readFileSync('src/paths.json','utf8')).counter; ${COUNT_ONLY_REVERTED("target")} assert.equal(value, 2);\n`,
  );
  w.commit("review baseline");
  await changeAfterBaseline(w, p, "test/paths.test.mjs", "Exercise a restored baseline reference");
  await w.write("src/paths.json", `${JSON.stringify({ counter: "counter.txt" })}\n`);
  await w.write("src/value.mjs", "export const value = 2;\n");
  expect((await verify(w)).executions[0]).toMatchObject({
    flip: {
      failsWithoutChange: true,
      revertedFiles: expect.arrayContaining(["src/paths.json", "src/value.mjs"]),
    },
  });
  expect(await readFile(join(w.root, "counter.txt"), "utf8")).toBe("0");
});

it("reports a UTF-16 file that names the project as unchecked, without the comparison", async () => {
  const p = await productWorkspace({ flip: true });
  projects.push(p);
  const w = p.workspace;
  await w.write(".gitignore", "node_modules/\n");
  await w.write("src/value.mjs", "export const value = 1;\n");
  await w.write("counter.txt", "0");
  await writeFile(
    join(w.root, "config16.json"),
    Buffer.from(JSON.stringify({ counter: join(w.root, "counter.txt") }), "utf16le"),
  );
  await w.write(
    "test/wide.test.mjs",
    "import {value} from '../src/value.mjs'; import assert from 'node:assert/strict'; assert.equal(value, 2);\n",
  );
  w.commit("review baseline");
  await changeAfterBaseline(w, p, "test/wide.test.mjs", "Exercise a UTF-16 reference");
  await w.write("src/value.mjs", "export const value = 2;\n");
  expect((await verify(w)).executions[0]).toMatchObject({
    flip: {
      failsWithoutChange: "unchecked",
      reason:
        "config16.json refers to the project by absolute path; the comparison could change the project",
    },
  });
  expect(await readFile(join(w.root, "counter.txt"), "utf8")).toBe("0");
});
