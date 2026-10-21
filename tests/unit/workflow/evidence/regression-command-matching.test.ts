import { describe, expect, it } from "vitest";
import { namesExistingTest } from "../../../../src/workflow/product/regression-command-matching.js";

const root = "/project";
const cases = [
  ["mocha --file=test/value.test.mjs", "test/value.test.mjs"],
  ["env PYTHONPATH=src python3 -m unittest tests.test_value", "src/tests/test_value.py"],
  ["cd packages/pkg && node --test test/value.test.mjs", "packages/pkg/test/value.test.mjs"],
  ["python3 tests/runtests.py utils_tests.test_text", "tests/utils_tests/test_text.py"],
  ["python3 -B tests/runtests.py utils_tests.test_text", "tests/utils_tests/test_text.py"],
  [
    "./swe-test ./tests/runtests.py --parallel 1 auth_tests.test_management",
    "tests/auth_tests/test_management.py",
  ],
  ["env --cd packages/pkg node --test ./test/value.test.mjs", "packages/pkg/test/value.test.mjs"],
  [
    "env --cd=packages/pkg PYTHONPATH=src python -m unittest tests.test_value.TestValue",
    "packages/pkg/src/tests/test_value.py",
  ],
  ["pnpm --cd packages/pkg test test/value.test.mjs", "packages/pkg/test/value.test.mjs"],
  ["cd packages && cd pkg && node --test test/value.test.mjs", "packages/pkg/test/value.test.mjs"],
  ["env PYTHONPATH=lib:src python -m unittest tests.test_value", "lib/tests/test_value.py"],
  ["python -m unittest tests.test_value", "tests/test_value.py"],
  ["python -m unittest tests.test_value", "src/tests/test_value.py"],
  [
    "bash -c 'cd packages/pkg && node --test test/value.test.mjs'",
    "packages/pkg/test/value.test.mjs",
  ],
  ["env PYTHONPATH='/project/lib' python -m unittest tests.test_value", "lib/tests/test_value.py"],
];

describe("complete test arguments in command context", () => {
  it.each(cases)("resolves %s to %s", (command, path) => {
    expect(namesExistingTest(command, path, root)).toBe(true);
  });
  it.each([
    ["node --test value.test.mjs", "test/value.test.mjs"],
    ["node --test value.test.mjs", "value.test.mjs"],
    ["python -m unittest test_value", "tests/test_value.py"],
    ["python -m unittest other.tests.test_value", "tests/test_value.py"],
    ["python -m unittest tests.test_value_extra", "tests/test_value.py"],
    ["node --test other/test/value.test.mjs", "test/value.test.mjs"],
    ["node --test test/value.test.mjs.bak", "test/value.test.mjs"],
    ["cd other && node --test test/value.test.mjs", "test/value.test.mjs"],
    ["env PYTHONPATH=other python -m unittest tests.test_value", "lib/tests/test_value.py"],
    ["python other/runtests.py utils_tests.test_text", "tests/utils_tests/test_text.py"],
    [
      "python -m unittest tests/runtests.py utils_tests.test_text",
      "tests/utils_tests/test_text.py",
    ],
    ["echo unrelated && cd packages/pkg", "packages/pkg/test/value.test.mjs"],
  ])("keeps token and root boundaries for %s", (command, path) => {
    expect(namesExistingTest(command, path, root)).toBe(false);
  });
});
