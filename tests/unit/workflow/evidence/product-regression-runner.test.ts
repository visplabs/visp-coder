import { describe, expect, it } from "vitest";
import {
  declaredRunner,
  isRunnableTestFile,
  pythonTestClasses,
  type TestRunnerFacts,
  testFileCommand,
  testLanguage,
} from "../../../../src/workflow/product/regression/regression-runner.js";

const PYTHON = process.platform === "win32" ? "python" : "python3";
const none: TestRunnerFacts = { binaries: new Set(), pytestConfig: false };

describe("testFileCommand", () => {
  it("runs a unittest module with unittest and a pytest module with pytest", () => {
    expect(
      testFileCommand(
        "tests/test_sheet.py",
        "import unittest\nclass T(unittest.TestCase): ...",
        none,
      ),
    ).toEqual([PYTHON, "-m", "unittest", "tests/test_sheet.py"]);
    expect(testFileCommand("tests/test_api.py", "import pytest\ndef test_x(): ...", none)).toEqual([
      PYTHON,
      "-m",
      "pytest",
      "-q",
      "-rfE",
      "tests/test_api.py",
    ]);
    expect(testFileCommand("tests/test_bare.py", "def test_x():\n    assert 1\n", none)).toEqual([
      PYTHON,
      "-m",
      "pytest",
      "-q",
      "-rfE",
      "tests/test_bare.py",
    ]);
  });

  it("prefers pytest for a unittest module when the project configures pytest", () => {
    expect(
      testFileCommand("tests/test_sheet.py", "import unittest", { ...none, pytestConfig: true }),
    ).toEqual([PYTHON, "-m", "pytest", "-q", "-rfE", "tests/test_sheet.py"]);
  });

  it("runs a script-style Python test with the interpreter", () => {
    expect(testFileCommand("tests/check_value_test.py", "assert 1 == 1\n", none)).toEqual([
      PYTHON,
      "tests/check_value_test.py",
    ]);
  });

  it("uses the project's installed JavaScript runner, else node's own", () => {
    const vitest = { ...none, binaries: new Set(["vitest", "jest"]) };
    expect(testFileCommand("test/a.test.ts", "import { it } from 'vitest'", vitest)).toEqual([
      "node_modules/.bin/vitest",
      "run",
      "test/a.test.ts",
    ]);
    expect(testFileCommand("test/a.test.js", "", { ...none, binaries: new Set(["jest"]) })).toEqual(
      ["node_modules/.bin/jest", "--ci", "test/a.test.js"],
    );
    expect(testFileCommand("test/a.test.mjs", "import { test } from 'node:test';", none)).toEqual([
      "node",
      "--test",
      "--test-reporter=tap",
      "test/a.test.mjs",
    ]);
    expect(testFileCommand("test/a.test.mjs", "import assert from 'node:assert';", none)).toEqual([
      "node",
      "test/a.test.mjs",
    ]);
  });

  it("has no command for a TypeScript test without an installed runner, or another language", () => {
    expect(
      testFileCommand("test/a.test.ts", "import { test } from 'node:test';", none),
    ).toBeUndefined();
    expect(testFileCommand("src/a_test.go", "package a", none)).toBeUndefined();
  });
});

const MANAGEMENT = [
  "from django.contrib.auth.management.commands import createsuperuser",
  "from django.test import TestCase",
  "",
  "",
  "class GetDefaultUsernameTestCase(TestCase):",
  "    def test_simple(self):",
  "        self.assertEqual(1, 1)",
  "",
  "",
  "class CreatesuperuserManagementCommandTestCase(TestCase):",
  "    def test_no_email(self):",
  "        call_command('createsuperuser', interactive=False)",
  "",
  "",
  "@override_settings(AUTH_USER_MODEL='auth_tests.CustomUser')",
  "class MultiDBCreatesuperuserTestCase(TestCase):",
  "    def test_createsuperuser_command_with_database_option(self):",
  "        createsuperuser.Command()",
  "",
].join("\n");

describe("isRunnableTestFile", () => {
  it("counts a file named and written as a test, and nothing else under a tests directory", () => {
    expect(isRunnableTestFile("tests/auth_tests/test_management.py", MANAGEMENT)).toBe(true);
    expect(isRunnableTestFile("tests/app/tests.py", "def test_a():\n    assert 1\n")).toBe(true);
    expect(isRunnableTestFile("tests/app/__init__.py", "")).toBe(false);
    expect(isRunnableTestFile("tests/app/models.py", "class Thing(Model):\n    pass\n")).toBe(
      false,
    );
    expect(isRunnableTestFile("tests/app/test_empty.py", "# nothing yet\n")).toBe(false);
    expect(isRunnableTestFile("tests/app/templates/test_page.html", "<p>test()</p>")).toBe(false);
    expect(isRunnableTestFile("js_tests/admin/core.test.js", "QUnit.test('x', (a) => {});")).toBe(
      true,
    );
    expect(isRunnableTestFile("test/helpers.mjs", "export const it = 1;")).toBe(false);
    expect(isRunnableTestFile("src/__tests__/a.ts", "it('works', () => {});")).toBe(true);
  });

  it("names a test file's language", () => {
    expect(testLanguage("tests/test_a.py")).toBe("python");
    expect(testLanguage("js_tests/a.test.js")).toBe("javascript");
    expect(testLanguage("src/a.test.tsx")).toBe("javascript");
    expect(testLanguage("tests/a.html")).toBeUndefined();
  });
});

describe("declaredRunner", () => {
  const exists = (path: string) =>
    ["tests/auth_tests", "tests/migrations", "tests/test_a.py", "test/a.test.mjs"].includes(path);

  it("takes Django's runner and its options from a declared check, without its test labels", () => {
    expect(
      declaredRunner(
        [
          "./swe-test",
          "./tests/runtests.py",
          "--parallel",
          "1",
          "auth_tests.test_management",
          "migrations",
        ],
        exists,
      ),
    ).toEqual({
      style: "django",
      prefix: ["./swe-test", "./tests/runtests.py", "--parallel", "1"],
      labelRoot: "tests",
    });
  });

  it("takes pytest, unittest and node:test runners", () => {
    expect(declaredRunner(["python3", "-m", "pytest", "-x", "tests/test_a.py::A"], exists)).toEqual(
      {
        style: "pytest",
        prefix: ["python3", "-m", "pytest", "-x"],
      },
    );
    expect(declaredRunner(["pytest", "-q", "tests/test_a.py"], exists)).toEqual({
      style: "pytest",
      prefix: ["pytest", "-q"],
    });
    expect(declaredRunner(["python3", "-m", "unittest", "tests/test_a.py"], exists)).toEqual({
      style: "unittest",
      prefix: ["python3", "-m", "unittest"],
    });
    expect(declaredRunner(["node", "--test", "test/a.test.mjs"], exists)).toEqual({
      style: "node",
      prefix: ["node", "--test"],
    });
  });

  it("has no runner for a command that runs no test framework", () => {
    expect(declaredRunner(["node", "checks/value.check.mjs"], exists)).toBeUndefined();
    expect(declaredRunner(["./run.sh"], exists)).toBeUndefined();
  });
});

describe("a declared unittest discover check", () => {
  const exists = (path: string) => path === "tests";
  const source =
    "import unittest\nclass ApiTests(unittest.TestCase):\n    def test_x(self): pass\n";
  const narrowed = (declared: string[], classes: string[] = []) => {
    const runner = declaredRunner(declared, exists);
    return testFileCommand("tests/test_api.py", source, none, {
      runners: runner ? [runner] : [],
      classes,
    });
  };

  it("names the module, not a start directory, whatever options the check declares", () => {
    expect(narrowed(["python3", "-m", "unittest", "discover", "-s", "tests"])).toEqual([
      "python3",
      "-m",
      "unittest",
      "tests.test_api",
    ]);
    expect(
      narrowed(["python3", "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"]),
    ).toEqual(["python3", "-m", "unittest", "tests.test_api"]);
    expect(narrowed(["python", "-m", "unittest", "discover"])).toEqual([
      "python",
      "-m",
      "unittest",
      "tests.test_api",
    ]);
    expect(narrowed(["python3", "-m", "unittest", "discover", "tests"])).toEqual([
      "python3",
      "-m",
      "unittest",
      "tests.test_api",
    ]);
    expect(
      narrowed(["python3", "-m", "unittest", "discover", "-s", "tests", "-t", ".", "-v"]),
    ).toEqual(["python3", "-m", "unittest", "-v", "tests.test_api"]);
  });

  it("keeps the interpreter, its flags and the options that are not discovery's", () => {
    expect(narrowed(["python3", "-B", "-m", "unittest", "discover", "-s", "tests", "-v"])).toEqual([
      "python3",
      "-B",
      "-m",
      "unittest",
      "-v",
      "tests.test_api",
    ]);
    // Isolated mode leaves the working directory off the import path, which a module name needs.
    expect(
      narrowed(["python3", "-I", "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"]),
    ).toEqual(["python3", "-E", "-s", "-m", "unittest", "tests.test_api"]);
  });

  it("keeps the flag that stands before the start directory, and the option after it", () => {
    const kept = ["python3", "-m", "unittest", "-v", "tests.test_api"];
    expect(narrowed(["python3", "-m", "unittest", "discover", "-v", "-s", "tests"])).toEqual(kept);
    expect(
      narrowed(["python3", "-m", "unittest", "discover", "-s", "tests", "-v", "-p", "test_*.py"]),
    ).toEqual(kept);
    expect(
      narrowed(["python3", "-m", "unittest", "discover", "-v", "-t", ".", "-p", "test_*.py"]),
    ).toEqual(kept);
  });

  it("keeps unittest's flags in whatever order, none of them taking the next argument", () => {
    for (const declared of [
      ["discover", "-c", "-b", "-s", "tests"],
      ["discover", "-b", "-c", "-s", "tests"],
      ["discover", "-c", "-s", "tests", "-b"],
      ["discover", "-s", "tests", "-c", "-b"],
    ])
      expect(narrowed(["python3", "-m", "unittest", ...declared])).toEqual([
        "python3",
        "-m",
        "unittest",
        ...declared.filter((arg) => arg === "-c" || arg === "-b"),
        "tests.test_api",
      ]);
    for (const flag of [
      "-v",
      "-q",
      "-f",
      "-c",
      "-b",
      "--verbose",
      "--quiet",
      "--failfast",
      "--catch",
      "--buffer",
      "--locals",
    ])
      expect(narrowed(["python3", "-m", "unittest", "discover", flag, "-s", "tests"])).toEqual([
        "python3",
        "-m",
        "unittest",
        flag,
        "tests.test_api",
      ]);
  });

  it("keeps the value of the options that take one and drops where discovery looks", () => {
    expect(
      narrowed(["python3", "-m", "unittest", "discover", "-k", "double", "-v", "-s", "tests"]),
    ).toEqual(["python3", "-m", "unittest", "-k", "double", "-v", "tests.test_api"]);
    expect(
      narrowed(["python3", "-m", "unittest", "discover", "--durations", "3", "-s", "tests"]),
    ).toEqual(["python3", "-m", "unittest", "--durations", "3", "tests.test_api"]);
    expect(
      narrowed([
        "python3",
        "-m",
        "unittest",
        "discover",
        "-v",
        "--start-directory",
        "tests",
        "--pattern",
        "test_*.py",
        "--top-level-directory",
        ".",
      ]),
    ).toEqual(["python3", "-m", "unittest", "-v", "tests.test_api"]);
  });

  it("narrows to classes by dotted name", () => {
    expect(
      narrowed(["python3", "-m", "unittest", "discover", "-s", "tests"], ["ApiTests"]),
    ).toEqual(["python3", "-m", "unittest", "tests.test_api.ApiTests"]);
  });

  it("still runs a file path after a check that names no discovery", () => {
    expect(narrowed(["python3", "-m", "unittest", "-v"])).toEqual([
      "python3",
      "-m",
      "unittest",
      "-v",
      "tests/test_api.py",
    ]);
  });
});

describe("pythonTestClasses", () => {
  it("names the classes whose bodies mention the changed module", () => {
    expect(pythonTestClasses(MANAGEMENT, ["createsuperuser"])).toEqual([
      "CreatesuperuserManagementCommandTestCase",
      "MultiDBCreatesuperuserTestCase",
    ]);
  });

  it("runs the whole module when every class or none mentions it", () => {
    expect(pythonTestClasses(MANAGEMENT, ["TestCase"])).toBeUndefined();
    expect(pythonTestClasses(MANAGEMENT, ["changepassword"])).toBeUndefined();
  });
});

describe("testFileCommand with the project's runner", () => {
  const django = declaredRunner(
    ["./swe-test", "./tests/runtests.py", "--parallel", "1", "auth_tests.test_management"],
    () => true,
  );

  it("runs the selected classes through a declared Django runner", () => {
    expect(
      testFileCommand("tests/auth_tests/test_management.py", MANAGEMENT, none, {
        runners: django ? [django] : [],
        classes: ["CreatesuperuserManagementCommandTestCase"],
      }),
    ).toEqual([
      "./swe-test",
      "./tests/runtests.py",
      "--parallel",
      "1",
      "auth_tests.test_management.CreatesuperuserManagementCommandTestCase",
    ]);
  });

  it("uses Django's tests/runtests.py when no check declares a runner", () => {
    expect(
      testFileCommand(
        "tests/auth_tests/test_management.py",
        MANAGEMENT,
        { ...none, djangoRunner: "tests/runtests.py" },
        {},
      ),
    ).toEqual([PYTHON, "tests/runtests.py", "auth_tests.test_management"]);
  });

  it("addresses pytest classes by node id and unittest classes by dotted name", () => {
    const pytest = { style: "pytest" as const, prefix: ["python3", "-m", "pytest", "-q"] };
    expect(
      testFileCommand(
        "tests/test_a.py",
        "import pytest\nclass TestA:\n    def test_x(self): pass\n",
        none,
        {
          runners: [pytest],
          classes: ["TestA"],
        },
      ),
    ).toEqual(["python3", "-m", "pytest", "-q", "tests/test_a.py::TestA"]);
    expect(
      testFileCommand("tests/test_a.py", "import unittest\n", none, { classes: ["A", "B"] }),
    ).toEqual([PYTHON, "-m", "unittest", "tests.test_a.A", "tests.test_a.B"]);
  });

  it("keeps a Python runner for Python tests and a JavaScript runner for JavaScript tests", () => {
    const node = { style: "node" as const, prefix: ["node", "--test"] };
    expect(
      testFileCommand("tests/test_a.py", "import unittest\n", none, { runners: [node] }),
    ).toEqual([PYTHON, "-m", "unittest", "tests/test_a.py"]);
  });
});
