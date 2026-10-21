import { describe, expect, it } from "vitest";
import {
  type TestRunnerFacts,
  testFileCommand,
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
