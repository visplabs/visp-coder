import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import type { Result } from "../../../../src/core/result.js";
import {
  createProductFeature,
  type ProductBrief,
  runProductAccept,
  runProductDone,
  runProductNext,
  runProductReview,
  runProductWork,
  updateProductBrief,
} from "../../../../src/workflow/product/index.js";
import { readRegressionGate } from "../../../../src/workflow/product/regression/regression-report.js";
import { moduleFeedback } from "../../support/product-feedback.js";
import { TestWorkspace } from "../../support/workspace.js";

/**
 * `workflow.regressionGate`: at `done` and `accept`, existing tests the change reaches and
 * earlier work's checks run on the new code; each failure runs again, then on the old code.
 */
const LABEL_TEST = (expected: string) =>
  `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { label } from "../src/value.mjs";\ntest("label is ${expected}", () => assert.equal(label, "${expected}"));\n`;
const FILES = {
  "src/value.mjs": 'export const value = 1;\nexport const label = "one";\n',
  "test/value.test.mjs":
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { value } from "../src/value.mjs";\ntest("value is two", () => assert.equal(value, 2));\n',
  "test/label.test.mjs": LABEL_TEST("one"),
};
const CHANGED = 'export const value = 2;\nexport const label = "two";\n';
const KEPT = 'export const value = 2;\nexport const label = "one";\n';

type Mode = "off" | "advise" | "gate";
let workspace: TestWorkspace | undefined;
afterEach(async () => {
  await workspace?.destroy();
  workspace = undefined;
});

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function brief(started: ProductBrief, check: [string, ...string[]]) {
  return {
    ...started,
    outcomes: [
      {
        id: "O001",
        kind: "functional",
        statement: "The public value is two",
        priority: "must",
        provenance: "user-stated",
      },
    ],
    checks: [
      {
        id: "C001",
        command: check,
        outcomes: ["O001"],
        files: ["src/value.mjs", ...check.slice(1).filter((arg) => arg.includes("/"))],
        environment: "node",
      },
    ],
    slices: [
      {
        id: "T001",
        goal: "Return the promised value",
        outcomes: ["O001"],
        scope: { allowed: ["src/value.mjs"], expected: ["src/value.mjs"], forbidden: [] },
        checks: ["C001"],
      },
    ],
  };
}

/** A project with the gate configured and one feature whose slice is authorized. */
async function project(
  mode: Mode,
  options: {
    files?: Record<string, string>;
    flipCheck?: string;
    check?: [string, ...string[]];
  } = {},
): Promise<string> {
  const { workspace: created } = await TestWorkspace.cached(
    `regression-gate:${mode}:${JSON.stringify({ ...options, check: undefined })}`,
    async () => {
      const built = await TestWorkspace.create({ ...FILES, ...options.files });
      const config = parse(await readFile(join(built.root, "visp.yml"), "utf8"));
      config.workflow = {
        ...config.workflow,
        regressionGate: mode,
        ...(options.flipCheck ? { flipCheck: options.flipCheck } : {}),
      };
      await built.write("visp.yml", stringify(config));
      await built.installFoundation();
      built.commit("install foundation");
      return { workspace: built, value: undefined };
    },
  );
  workspace = created;
  return startFeature(
    created,
    options.check ?? [process.execPath, "--test", "test/value.test.mjs"],
  );
}

async function startFeature(target: TestWorkspace, check: [string, ...string[]]) {
  const started = value(
    await createProductFeature(await target.state(), { goal: "Return two from the module" }),
  );
  value(
    await updateProductBrief(await target.state(), {
      brief: brief(started.brief, check),
      reason: "Define the first usable behavior",
    }),
  );
  value(await runProductWork(await target.state(), { task: "T001" }));
  return started.brief.feature;
}

async function done() {
  if (!workspace) throw new Error("no project");
  return value(await runProductDone(await workspace.state()));
}

describe("gate mode", () => {
  it("blocks done on a test that passed before the change and fails after it", async () => {
    const feature = await project("gate");
    await workspace?.write("src/value.mjs", CHANGED);
    const blocked = await done();
    expect(blocked.closed).toBe(false);
    expect(blocked.regressionGate).toMatchObject({
      mode: "gate",
      status: "regression",
      ran: ["test/label.test.mjs"],
      regressions: [expect.stringMatching(/^test\/label\.test\.mjs › label is one: /)],
    });
    expect(blocked.gaps).toContainEqual(
      expect.stringMatching(
        /^Regression: test\/label\.test\.mjs › label is one: .*It passed before this change and fails now\./,
      ),
    );
    // `next` names the regression instead of advising the worker to run the test.
    const next = value(await runProductNext(await (workspace as TestWorkspace).state(), {}));
    expect(next.evidence[0]).toMatch(/^Regression: test\/label\.test\.mjs › label is one: /);
    expect(next.evidence.join("\n")).not.toContain("Existing tests also exercise");
    const saved = await readRegressionGate(await (workspace as TestWorkspace).state(), feature);
    expect(saved?.results[0]?.tests).toEqual([
      expect.objectContaining({ name: "label is one", status: "regression" }),
    ]);

    // An unchanged product is not run again.
    const again = await done();
    expect(again.closed).toBe(false);
    const reread = await readRegressionGate(await (workspace as TestWorkspace).state(), feature);
    expect(reread?.durationMs).toBe(saved?.durationMs);

    await workspace?.write("src/value.mjs", KEPT);
    const repaired = await done();
    expect(repaired.closed).toBe(true);
    expect(repaired.regressionGate).toMatchObject({
      status: "clear",
      ran: ["test/label.test.mjs"],
    });
  });

  it("reports a test that failed before the change too, without blocking", async () => {
    await project("gate", { files: { "test/label.test.mjs": LABEL_TEST("uno") } });
    await workspace?.write("src/value.mjs", CHANGED);
    const closed = await done();
    expect(closed.closed).toBe(true);
    expect(closed.regressionGate).toMatchObject({
      status: "clear",
      preExisting: [expect.stringMatching(/^test\/label\.test\.mjs › label is uno: /)],
    });
  });

  it("leaves a failure that passes on a rerun unchecked, never passed and never blocking", async () => {
    const counter = join(tmpdir(), `visp-flaky-${process.pid}-${Date.now()}`);
    await project("gate", {
      files: {
        "test/flaky.test.mjs": [
          'import { test } from "node:test";',
          'import { existsSync, rmSync, writeFileSync } from "node:fs";',
          'import "../src/value.mjs";',
          `const counter = ${JSON.stringify(counter)};`,
          'test("sometimes", () => {',
          "  if (existsSync(counter)) return rmSync(counter);",
          '  writeFileSync(counter, "1");',
          '  throw new Error("first run fails");',
          "});",
          "",
        ].join("\n"),
      },
    });
    await workspace?.write("src/value.mjs", KEPT);
    const closed = await done();
    expect(closed.closed).toBe(true);
    expect(closed.regressionGate).toMatchObject({
      status: "unchecked",
      unchecked: ["test/flaky.test.mjs › sometimes: flaky: passed on a rerun"],
    });
  });

  it("runs a black-box test that imports no application code, which the graph cannot rule out", async () => {
    await project("gate", {
      files: {
        "test/cli.test.mjs": [
          'import { test } from "node:test";',
          'import assert from "node:assert/strict";',
          'import { execFileSync } from "node:child_process";',
          "const script = \"import('./src/value.mjs').then((m) => process.stdout.write(m.label))\";",
          'test("prints the label", () =>',
          '  assert.equal(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }), "one"));',
          "",
        ].join("\n"),
      },
    });
    await workspace?.write("src/value.mjs", CHANGED);
    const blocked = await done();
    expect(blocked.closed).toBe(false);
    expect(blocked.regressionGate?.ran).toEqual(["test/label.test.mjs", "test/cli.test.mjs"]);
    expect(blocked.regressionGate?.regressions).toContainEqual(
      expect.stringMatching(/^test\/cli\.test\.mjs › prints the label: /),
    );
  });

  it("compares nothing when the flip check is off, so no command runs twice", async () => {
    await project("gate", { flipCheck: "off" });
    await workspace?.write("src/value.mjs", CHANGED);
    const closed = await done();
    expect(closed.closed).toBe(true);
    expect(closed.regressionGate).toMatchObject({
      status: "unchecked",
      unchecked: [
        "test/label.test.mjs › label is one: not compared: workflow.flipCheck is off, so no command runs twice",
      ],
    });
  });
});

it("advise mode reports a regression without blocking", async () => {
  await project("advise");
  await workspace?.write("src/value.mjs", CHANGED);
  const closed = await done();
  expect(closed.closed).toBe(true);
  expect(closed.regressionGate).toMatchObject({ mode: "advise", status: "regression" });
  expect(closed.gaps.join("\n")).not.toContain("Regression:");
});

it("off runs nothing and saves nothing", async () => {
  const feature = await project("off");
  await workspace?.write("src/value.mjs", CHANGED);
  const closed = await done();
  expect(closed.closed).toBe(true);
  expect(closed).not.toHaveProperty("regressionGate");
  expect(await readRegressionGate(await (workspace as TestWorkspace).state(), feature)).toBe(
    undefined,
  );
});

it("runs an earlier accepted feature's checks and blocks the later feature that breaks them", async () => {
  await project("gate", {
    files: {
      "checks/value.check.mjs": [
        'import { value } from "../src/value.mjs";',
        'if (value !== 2) { console.log("FAIL: value is two: got " + value); process.exit(1); }',
        "",
      ].join("\n"),
    },
    check: [process.execPath, "checks/value.check.mjs"],
  });
  const target = workspace as TestWorkspace;
  await target.write("src/value.mjs", KEPT);
  expect((await done()).closed).toBe(true);
  const bundle = value(await runProductReview(await target.state()));
  value(
    await runProductReview(await target.state(), {
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
  expect(value(await runProductAccept(await target.state())).passed).toBe(true);
  target.commit("value two");

  // The next feature's own check passes while the value it inherited breaks.
  await startFeature(target, [process.execPath, "--test", "test/label.test.mjs"]);
  await target.write("src/value.mjs", 'export const value = 3;\nexport const label = "one";\n');
  const blocked = await done();
  expect(blocked.closed).toBe(false);
  expect(blocked.regressionGate?.regressions).toContainEqual(
    expect.stringMatching(/ C001 › value is two: got 3$/),
  );
});
