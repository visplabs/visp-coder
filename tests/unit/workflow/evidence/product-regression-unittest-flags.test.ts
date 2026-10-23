import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import type { Result } from "../../../../src/core/result.js";
import {
  createProductFeature,
  runProductDone,
  runProductWork,
  updateProductBrief,
} from "../../../../src/workflow/product/index.js";
import { readRegressionGate } from "../../../../src/workflow/product/regression/regression-report.js";
import { TestWorkspace } from "../../support/workspace.js";

/**
 * The regression gate on a project whose declared check discovers its tests with unittest and
 * passes `-v` before `-s`. The narrowed command used to be `python3 -m unittest -v -s
 * tests.test_app`, which unittest rejects with exit 2 on the new and the old code alike. That
 * read as a failure the old code had too, so a change that broke `tests/test_app.py` came out
 * clear.
 */
const PYTHON = process.platform === "win32" ? "python" : "python3";
const FILES = {
  "app.py": "def double(value):\n    return value * 2\n",
  "tests/test_app.py": [
    "import unittest",
    "from app import double",
    "",
    "",
    "class DoubleTests(unittest.TestCase):",
    "    def test_double(self):",
    "        self.assertEqual(double(2), 4)",
    "",
  ].join("\n"),
  // The declared check runs only this file, so it passes whatever happens to `double`.
  "tests/test_new.py": [
    "import unittest",
    "from app import double",
    "",
    "",
    "class NewTests(unittest.TestCase):",
    "    def test_callable(self):",
    "        self.assertTrue(callable(double))",
    "",
  ].join("\n"),
};
const BROKEN = "def double(value):\n    return value * 3\n";

let workspace: TestWorkspace | undefined;
afterEach(async () => {
  await workspace?.destroy();
  workspace = undefined;
});

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

async function project(check: string[]): Promise<{ target: TestWorkspace; feature: string }> {
  const { workspace: created } = await TestWorkspace.cached(
    "regression-unittest-flags",
    async () => {
      const built = await TestWorkspace.create(FILES);
      const config = parse(await readFile(join(built.root, "visp.yml"), "utf8"));
      config.workflow = { ...config.workflow, regressionGate: "gate", validationCommands: [] };
      await built.write("visp.yml", stringify(config));
      await built.installFoundation();
      built.commit("install foundation");
      return { workspace: built, value: undefined };
    },
  );
  workspace = created;
  const started = value(
    await createProductFeature(await created.state(), { goal: "Keep doubling numbers" }),
  );
  value(
    await updateProductBrief(await created.state(), {
      brief: {
        ...started.brief,
        outcomes: [
          {
            id: "O001",
            kind: "functional",
            statement: "The new tests pass",
            priority: "must",
            provenance: "user-stated",
          },
        ],
        checks: [
          {
            id: "C001",
            command: check,
            outcomes: ["O001"],
            files: ["app.py"],
            environment: "other",
          },
        ],
        slices: [
          {
            id: "T001",
            goal: "Change the module",
            outcomes: ["O001"],
            scope: { allowed: ["app.py"], expected: ["app.py"], forbidden: [] },
            checks: ["C001"],
          },
        ],
      },
      reason: "Define the first usable behavior",
    }),
  );
  value(await runProductWork(await created.state(), { task: "T001" }));
  return { target: created, feature: started.brief.feature };
}

describe.skipIf(process.platform === "win32")(
  "a declared unittest discover check with flags",
  () => {
    it("runs the existing test, so a change that breaks it is a regression, not clear", async () => {
      const { target, feature } = await project([
        PYTHON,
        "-m",
        "unittest",
        "discover",
        "-v",
        "-s",
        "tests",
        "-p",
        "test_new.py",
      ]);
      await target.write("app.py", BROKEN);
      const blocked = value(await runProductDone(await target.state()));
      expect(blocked.closed).toBe(false);
      expect(blocked.regressionGate).toMatchObject({ status: "regression" });
      expect(blocked.regressionGate?.regressions).toEqual([
        expect.stringMatching(/^tests\/test_app\.py › .*test_double/),
      ]);
      const report = await readRegressionGate(await target.state(), feature);
      expect(report?.results.map((result) => result.command)).toEqual([
        `${PYTHON} -m unittest -v tests.test_app`,
        `${PYTHON} -m unittest -v tests.test_new`,
      ]);
    });

    it("leaves a command its runner rejects unchecked, never clear", async () => {
      // `-vs tests` is `-v -s tests` to unittest; the narrowed command keeps `-vs` as typed, and
      // unittest rejects it with a usage error on the new and the old code alike.
      const { target } = await project([
        PYTHON,
        "-m",
        "unittest",
        "discover",
        "-vs",
        "tests",
        "-p",
        "test_new.py",
      ]);
      await target.write("app.py", BROKEN);
      const closed = value(await runProductDone(await target.state()));
      expect(closed.closed).toBe(true);
      expect(closed.regressionGate?.status).toBe("unchecked");
      expect(closed.regressionGate?.unchecked).toEqual([
        expect.stringMatching(
          /^tests\/test_app\.py: the runner rejected the command: python3 -m unittest: error/,
        ),
        expect.stringMatching(
          /^tests\/test_new\.py: the runner rejected the command: python3 -m unittest: error/,
        ),
      ]);
    });
  },
);
