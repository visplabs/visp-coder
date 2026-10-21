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
 * The regression gate on a project shaped like Django (ChainSWE dj14954): tests live under
 * tests/<app>_tests/, run through tests/runtests.py with dotted labels, and import the code they
 * test with `from package import module` or call a command by name. Before the fix the gate
 * linked no test to the changed command and filled its slots with js_tests and __init__.py.
 */
const COMMANDS = "pkg/contrib/auth/management/commands";
const PYTHON = process.platform === "win32" ? "python" : "python3";
const RUNTESTS = [
  "import os, sys, unittest",
  "HERE = os.path.dirname(os.path.abspath(__file__))",
  "sys.path[:0] = [HERE, os.path.dirname(HERE)]",
  "labels, args = [], iter(sys.argv[1:])",
  "for arg in args:",
  '    if arg == "--parallel":',
  "        next(args, None)",
  '    elif not arg.startswith("-"):',
  "        labels.append(arg)",
  "result = unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.loadTestsFromNames(labels))",
  "sys.exit(0 if result.wasSuccessful() else 1)",
  "",
].join("\n");
const unrelated = (index: number) => ({
  [`tests/app${index}_tests/__init__.py`]: "",
  [`tests/app${index}_tests/tests.py`]:
    "import unittest\n\n\nclass Tests(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n",
});
const FILES = {
  "pkg/__init__.py": "",
  "pkg/contrib/__init__.py": "",
  "pkg/contrib/auth/__init__.py": "",
  "pkg/contrib/auth/management/__init__.py": "",
  [`${COMMANDS}/__init__.py`]: "",
  [`${COMMANDS}/createsuperuser.py`]: "def handle(username):\n    return username.strip()\n",
  [`${COMMANDS}/changepassword.py`]: "def handle(username):\n    return username\n",
  "pkg/core/__init__.py": "",
  "pkg/core/management.py": [
    "import importlib",
    "",
    "",
    "def call_command(name, *args):",
    '    return importlib.import_module("pkg.contrib.auth.management.commands." + name).handle(*args)',
    "",
  ].join("\n"),
  "tests/runtests.py": RUNTESTS,
  "tests/auth_tests/__init__.py": "",
  "tests/auth_tests/templates/login.html": "<p>{{ form }}</p>\n",
  "tests/auth_tests/test_management.py": [
    "import unittest",
    "from pkg.contrib.auth.management.commands import changepassword, createsuperuser",
    "",
    "",
    "class ChangepasswordTests(unittest.TestCase):",
    "    def test_keeps_name(self):",
    '        self.assertEqual(changepassword.handle("a"), "a")',
    "",
    "",
    "class CreatesuperuserTests(unittest.TestCase):",
    "    def test_strips(self):",
    '        self.assertEqual(createsuperuser.handle(" admin "), "admin")',
    "",
  ].join("\n"),
  "tests/user_commands/__init__.py": "",
  "tests/user_commands/tests.py": [
    "import unittest",
    "from pkg.core.management import call_command",
    "",
    "",
    "class CommandTests(unittest.TestCase):",
    "    def test_createsuperuser_by_name(self):",
    '        self.assertEqual(call_command("createsuperuser", " root "), "root")',
    "",
  ].join("\n"),
  "tests/other_tests/__init__.py": "",
  "tests/other_tests/tests.py":
    "import unittest\n\n\nclass Other(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n",
  "js_tests/admin/core.test.js": "QUnit.test('core', (assert) => assert.ok(true));\n",
  ...unrelated(1),
  ...unrelated(2),
  ...unrelated(3),
  ...unrelated(4),
  ...unrelated(5),
};

let workspace: TestWorkspace | undefined;
afterEach(async () => {
  await workspace?.destroy();
  workspace = undefined;
});

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

async function project(
  label = "other_tests.tests",
  files: Record<string, string> = FILES,
  changed = `${COMMANDS}/createsuperuser.py`,
): Promise<{ target: TestWorkspace; feature: string }> {
  const { workspace: created } = await TestWorkspace.cached(
    `regression-django:${Object.keys(files).join()}`,
    async () => {
      const built = await TestWorkspace.create(files);
      const config = parse(await readFile(join(built.root, "visp.yml"), "utf8"));
      // `visp init` configures pytest over the whole suite here; the gate is what is under test.
      config.workflow = { ...config.workflow, regressionGate: "gate", validationCommands: [] };
      await built.write("visp.yml", stringify(config));
      await built.installFoundation();
      built.commit("install foundation");
      return { workspace: built, value: undefined };
    },
  );
  workspace = created;
  const started = value(
    await createProductFeature(await created.state(), { goal: "Keep superuser names as typed" }),
  );
  value(
    await updateProductBrief(await created.state(), {
      brief: {
        ...started.brief,
        outcomes: [
          {
            id: "O001",
            kind: "functional",
            statement: "The other app keeps working",
            priority: "must",
            provenance: "user-stated",
          },
        ],
        checks: [
          {
            id: "C001",
            command: [PYTHON, "tests/runtests.py", "--parallel", "1", label],
            outcomes: ["O001"],
            files: [changed],
            environment: "other",
          },
        ],
        slices: [
          {
            id: "T001",
            goal: "Change the command",
            outcomes: ["O001"],
            scope: { allowed: [changed], expected: [changed], forbidden: [] },
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

describe.skipIf(process.platform === "win32")("a Django-shaped project", () => {
  it("runs the tests that import or name the changed command, through the project's runner", async () => {
    const { target, feature } = await project();
    await target.write(
      `${COMMANDS}/createsuperuser.py`,
      "def handle(username):\n    return username\n",
    );
    const blocked = value(await runProductDone(await target.state()));
    expect(blocked.closed).toBe(false);
    expect(blocked.regressionGate).toMatchObject({
      status: "regression",
      ran: ["tests/auth_tests/test_management.py", "tests/user_commands/tests.py"],
      selected: { linked: 2, earlierWork: 0, unlinked: 0 },
    });
    expect(blocked.regressionGate?.regressions).toEqual([
      expect.stringMatching(/^tests\/auth_tests\/test_management\.py › .*test_strips/),
      expect.stringMatching(/^tests\/user_commands\/tests\.py › .*test_createsuperuser_by_name/),
    ]);
    const report = await readRegressionGate(await target.state(), feature);
    // Only the class that uses the changed command runs, by its dotted label.
    expect(report?.results.map((result) => result.command)).toEqual([
      `${PYTHON} tests/runtests.py --parallel 1 auth_tests.test_management.CreatesuperuserTests`,
      `${PYTHON} tests/runtests.py --parallel 1 user_commands.tests`,
    ]);
    // Tests that reach no changed code are not filler: not run, and counted once.
    expect(blocked.regressionGate?.leftOut).toContainEqual(
      "5 test files reach no changed code and were not run: tests/app1_tests/tests.py, tests/app2_tests/tests.py, tests/app3_tests/tests.py, …",
    );
    expect(JSON.stringify(blocked.regressionGate)).not.toMatch(/js_tests|__init__\.py|\.html/);
  });

  it("counts a test the call's own check ran as reaching the change, and does not run it again", async () => {
    const { target } = await project("auth_tests.test_management.ChangepasswordTests");
    await target.write(
      `${COMMANDS}/createsuperuser.py`,
      "def handle(username):\n    return username.strip().lower()\n",
    );
    const closed = value(await runProductDone(await target.state()));
    expect(closed.regressionGate).toMatchObject({
      status: "clear",
      ran: ["tests/user_commands/tests.py"],
      selected: { linked: 1, earlierWork: 0, unlinked: 0 },
    });
    expect(closed.regressionGate?.leftOut).toContain(
      "already run by this call's checks: tests/auth_tests/test_management.py",
    );
    expect(closed.regressionGate?.leftOut?.join("\n")).not.toContain("no existing test reaches");
  });

  it("runs the only test of a command-line project, which drives it as a subprocess", async () => {
    const { target } = await project(
      "version_tests.test_version",
      {
        "sheet/__init__.py": "",
        "sheet/__main__.py": "from sheet.engine import evaluate\nprint(evaluate('1+1'))\n",
        "sheet/engine.py":
          "def evaluate(text):\n    left, right = text.split('+')\n    return int(left) + int(right)\n",
        "tests/runtests.py": RUNTESTS,
        "tests/version_tests/__init__.py": "",
        "tests/version_tests/test_version.py":
          "import unittest\n\n\nclass Version(unittest.TestCase):\n    def test_version(self):\n        self.assertTrue(True)\n",
        "tests/test_cli.py": [
          "import subprocess, sys, unittest",
          "",
          "",
          "class Cli(unittest.TestCase):",
          "    def test_adds(self):",
          '        out = subprocess.run([sys.executable, "-m", "sheet"], capture_output=True, text=True).stdout',
          '        self.assertEqual(out.strip(), "2")',
          "",
        ].join("\n"),
      },
      "sheet/engine.py",
    );
    await target.write("sheet/engine.py", "def evaluate(text):\n    return text\n");
    const blocked = value(await runProductDone(await target.state()));
    expect(blocked.regressionGate).toMatchObject({
      status: "regression",
      ran: ["tests/test_cli.py"],
      selected: { linked: 0, earlierWork: 0, unlinked: 1 },
    });
  });
});
