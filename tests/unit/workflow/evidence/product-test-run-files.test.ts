import { describe, expect, it } from "vitest";
import { testFilesRun } from "../../../../src/workflow/product/test-run-files.js";
import type { TestRunnerKind } from "../../../../src/workflow/product/test-sources.js";

const PATHS = [
  "tests/test_api.py",
  "tests/api_check.py",
  "tests/unit/test_store.py",
  "legacy/test_old.py",
  "app/tests/test_app.py",
  "test/value.test.mjs",
  "test/other.test.mjs",
];

const covered = (command: string, runner: TestRunnerKind, output = "") => {
  const covers = testFilesRun(command, output, PATHS, runner);
  return covers ? PATHS.filter(covers) : undefined;
};

describe("testFilesRun", () => {
  it("reads unittest discovery's start directory and pattern, and a leading cd", () => {
    expect(covered("python3 -B -m unittest discover -s tests", "unittest")).toEqual([
      "tests/test_api.py",
      "tests/unit/test_store.py",
    ]);
    expect(covered("python -m unittest discover tests '*_check.py'", "unittest")).toEqual([
      "tests/api_check.py",
    ]);
    expect(
      covered("python -m unittest discover --start-directory=legacy -t .", "unittest"),
    ).toEqual(["legacy/test_old.py"]);
    expect(covered("cd app && python -m unittest discover -s tests -v", "unittest")).toEqual([
      "app/tests/test_app.py",
    ]);
    expect(covered("python -m unittest", "unittest")).toEqual([
      "tests/test_api.py",
      "tests/unit/test_store.py",
      "legacy/test_old.py",
      "app/tests/test_app.py",
    ]);
  });

  it("reads the modules and files given to unittest", () => {
    expect(covered("python -m unittest tests.test_api.ApiTest.test_x", "unittest")).toEqual([
      "tests/test_api.py",
    ]);
    expect(covered("python -m unittest -v tests/unit/test_store.py", "unittest")).toEqual([
      "tests/unit/test_store.py",
    ]);
  });

  it("reads pytest's progress lines first, then the paths it is given, then its file pattern", () => {
    const output = "tests/test_api.py ....                [ 80%]\nlegacy/test_old.py .  [100%]\n";
    expect(covered("pytest", "pytest", output)).toEqual([
      "tests/test_api.py",
      "legacy/test_old.py",
    ]);
    expect(covered("python -m pytest -q tests/unit -k store", "pytest")).toEqual([
      "tests/unit/test_store.py",
    ]);
    expect(covered("pytest -q tests/test_api.py::test_x", "pytest")).toEqual(["tests/test_api.py"]);
    expect(covered(".venv/bin/pytest -q", "pytest")).toEqual([
      "tests/test_api.py",
      "tests/unit/test_store.py",
      "legacy/test_old.py",
      "app/tests/test_app.py",
    ]);
  });

  it("reads the files `node --test`, jest and mocha are given", () => {
    expect(covered("node --test test/value.test.mjs", "js")).toEqual(["test/value.test.mjs"]);
    expect(covered("npx mocha test/", "js")).toEqual([
      "test/value.test.mjs",
      "test/other.test.mjs",
    ]);
  });

  it("cannot tell for a script, a package script or a custom runner", () => {
    expect(covered("node test/value.test.mjs", "js")).toBeUndefined();
    expect(covered("npm test", "js")).toBeUndefined();
    expect(covered("./run-tests", "unittest")).toBeUndefined();
    expect(covered("python tests/run.py", "any")).toBeUndefined();
  });
});
