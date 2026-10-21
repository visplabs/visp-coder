import { describe, expect, it } from "vitest";
import {
  classifyRegression,
  failureIdentities,
  type RegressionRun,
} from "../../../../src/workflow/product/regression/regression-failures.js";

const ROOT = "/work/project";

describe("failureIdentities", () => {
  it("names unittest failures and errors by test and class, with the error line", () => {
    const output = [
      "FE.",
      "======================================================================",
      "ERROR: test_err (tests.test_x.T)",
      "----------------------------------------------------------------------",
      "Traceback (most recent call last):",
      `  File "${ROOT}/tests/test_x.py", line 5, in test_err`,
      '    def test_err(self): raise ValueError("boom 0x7ffe at 12.5ms")',
      "ValueError: boom 0x7ffe at 12.5ms",
      "",
      "======================================================================",
      "FAIL: test_bad (tests.test_x.T.test_bad)",
      "----------------------------------------------------------------------",
      "Traceback (most recent call last):",
      `  File "${ROOT}/tests/test_x.py", line 4, in test_bad`,
      "AssertionError: Lists differ: [1] != [2]",
      "",
      "First differing element 0:",
      "----------------------------------------------------------------------",
      "Ran 3 tests in 0.001s",
      "",
      "FAILED (failures=1, errors=1)",
    ].join("\n");
    expect(failureIdentities(output, [ROOT])).toEqual([
      { name: "tests.test_x.T.test_bad", message: "AssertionError: Lists differ: [1] != [2]" },
      { name: "tests.test_x.T.test_err", message: "ValueError: boom <hex> at <time>" },
    ]);
  });

  it("names pytest's short summary lines", () => {
    const output = [
      "=========================== short test summary info ============================",
      "FAILED tests/test_x.py::T::test_bad - AssertionError: Lists differ: [1] != [2]",
      "ERROR tests/test_y.py::test_setup - fixture 'db' not found",
      "2 failed, 1 passed in 0.02s",
    ].join("\n");
    expect(failureIdentities(output, [ROOT])).toEqual([
      { name: "tests/test_x.py::T::test_bad", message: "AssertionError: Lists differ: [1] != [2]" },
      { name: "tests/test_y.py::test_setup", message: "fixture 'db' not found" },
    ]);
  });

  it("names node:test spec failures from the failing-tests section only, not their suites", () => {
    const output = [
      "✔ adds (0.82ms)",
      "▶ group",
      "  ✖ subtracts (1.03ms)",
      "✖ group (1.35ms)",
      "ℹ tests 2",
      "",
      "✖ failing tests:",
      "",
      "test at test/a.test.mjs:3:27",
      "✖ subtracts (1.03ms)",
      "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
      "  ",
      "  2 !== 3",
      "  ",
      `      at TestContext.<anonymous> (file://${ROOT}/test/a.test.mjs:3:58)`,
    ].join("\n");
    expect(failureIdentities(output, [ROOT])).toEqual([
      {
        name: "subtracts",
        message: "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 2 !== 3",
      },
    ]);
  });

  it("names node:test TAP leaf failures and skips failed suites", () => {
    const output = [
      "TAP version 13",
      "# Subtest: group",
      "    # Subtest: subtracts",
      "    not ok 1 - subtracts",
      "      ---",
      "      duration_ms: 1.04",
      "      failureType: 'testCodeFailure'",
      "      error: |-",
      "        Expected values to be strictly equal:",
      "        ",
      "        'two' !== 'one'",
      "        ",
      "      code: 'ERR_ASSERTION'",
      "      ...",
      "    1..1",
      "not ok 2 - group",
      "  ---",
      "  failureType: 'subtestsFailed'",
      "  error: '1 subtest failed'",
      "  ...",
    ].join("\n");
    expect(failureIdentities(output, [ROOT])).toEqual([
      { name: "subtracts", message: "Expected values to be strictly equal: 'two' !== 'one'" },
    ]);
  });

  it("reads VISP's pinned FAIL lines, vitest, jest and go failures", () => {
    expect(
      failureIdentities("FAIL: value is two: expected 2, got 1\nFAIL: label: missing", [ROOT]),
    ).toEqual([
      { name: "label", message: "missing" },
      { name: "value is two", message: "expected 2, got 1" },
    ]);
    expect(
      failureIdentities(
        " FAIL  test/a.test.ts > group > subtracts\nAssertionError: expected 2 to be 3",
        [ROOT],
      ),
    ).toEqual([{ name: "test/a.test.ts > group > subtracts", message: "" }]);
    expect(failureIdentities("  ● group › subtracts\n\n    expect(received)", [ROOT])).toEqual([
      { name: "group › subtracts", message: "" },
    ]);
    expect(failureIdentities("--- FAIL: TestAdd (0.00s)", [ROOT])).toEqual([
      { name: "TestAdd", message: "" },
    ]);
  });

  it("gives an unnamed failure one identity from its last error line, with roots replaced", () => {
    expect(
      failureIdentities(`boom\nError: cannot open ${ROOT}/data/x.json after 31ms\n`, [ROOT]),
    ).toEqual([{ name: "", message: "Error: cannot open <root>/data/x.json after <time>" }]);
    expect(failureIdentities("", [ROOT])).toEqual([{ name: "", message: "" }]);
  });
});

const passed: RegressionRun = { kind: "passed" };
const failing = (...names: string[]): RegressionRun => ({
  kind: "failed",
  failures: names.map((name) => ({ name, message: `${name} broke` })),
});

describe("classifyRegression", () => {
  it("passes a command that passes on the new code", () => {
    expect(classifyRegression({ now: passed })).toEqual({ status: "passed", tests: [] });
  });

  it("calls a failure that passed on the old code a regression", () => {
    expect(classifyRegression({ now: failing("a"), rerun: failing("a"), before: passed })).toEqual({
      status: "regression",
      tests: [{ name: "a", status: "regression", message: "a broke" }],
    });
  });

  it("calls a failure the old code had too pre-existing, by name and message", () => {
    expect(
      classifyRegression({
        now: failing("a", "b"),
        rerun: failing("a", "b"),
        before: failing("a"),
      }),
    ).toEqual({
      status: "regression",
      tests: [
        { name: "a", status: "pre-existing", message: "a broke" },
        { name: "b", status: "regression", message: "b broke" },
      ],
    });
    const changed = classifyRegression({
      now: failing("a"),
      rerun: failing("a"),
      before: { kind: "failed", failures: [{ name: "a", message: "other" }] },
    });
    expect(changed.tests).toEqual([
      { name: "a", status: "pre-existing", message: "a broke", before: "other" },
    ]);
    expect(changed.status).toBe("pre-existing");
  });

  it("never passes a flaky failure: a rerun that differs leaves it unchecked", () => {
    expect(classifyRegression({ now: failing("a"), rerun: passed })).toEqual({
      status: "unchecked",
      tests: [
        { name: "a", status: "unchecked", message: "a broke", reason: "flaky: passed on a rerun" },
      ],
    });
    const partly = classifyRegression({
      now: failing("a", "b"),
      rerun: failing("a"),
      before: passed,
    });
    expect(partly.status).toBe("regression");
    expect(partly.tests).toContainEqual({
      name: "b",
      status: "unchecked",
      message: "b broke",
      reason: "flaky: passed on a rerun",
    });
  });

  it("leaves failures unchecked when the new or old run could not run", () => {
    expect(classifyRegression({ now: { kind: "environment", reason: "timed out" } })).toEqual({
      status: "unchecked",
      tests: [],
      reason: "timed out",
    });
    expect(
      classifyRegression({
        now: failing("a"),
        rerun: failing("a"),
        before: { kind: "environment", reason: "fixture missing" },
      }),
    ).toEqual({
      status: "unchecked",
      tests: [
        { name: "a", status: "unchecked", message: "a broke", reason: "old code: fixture missing" },
      ],
    });
  });

  it("leaves failures unchecked when no comparison was allowed", () => {
    expect(classifyRegression({ now: failing("a"), skipped: "workflow.flipCheck is off" })).toEqual(
      {
        status: "unchecked",
        tests: [
          {
            name: "a",
            status: "unchecked",
            message: "a broke",
            reason: "workflow.flipCheck is off",
          },
        ],
      },
    );
  });

  it("compares an unnamed failure as a whole", () => {
    const unnamed = (message: string): RegressionRun => ({
      kind: "failed",
      failures: [{ name: "", message }],
    });
    expect(
      classifyRegression({ now: unnamed("Error: x"), rerun: unnamed("Error: x"), before: passed })
        .status,
    ).toBe("regression");
    expect(
      classifyRegression({
        now: unnamed("Error: x"),
        rerun: unnamed("Error: x"),
        before: unnamed("Error: x"),
      }).status,
    ).toBe("pre-existing");
    expect(
      classifyRegression({
        now: unnamed("Error: x"),
        rerun: unnamed("Error: x"),
        before: unnamed("Error: y"),
      }).tests,
    ).toEqual([
      {
        name: "",
        status: "unchecked",
        message: "Error: x",
        reason: "the old code failed differently and names no test",
      },
    ]);
  });

  it("does not call a named failure a regression when the old run named none", () => {
    expect(
      classifyRegression({
        now: failing("a"),
        rerun: failing("a"),
        before: { kind: "failed", failures: [{ name: "", message: "Error: crashed" }] },
      }).tests,
    ).toEqual([
      {
        name: "a",
        status: "unchecked",
        message: "a broke",
        reason: "the old code failed without naming its failing tests",
      },
    ]);
  });
});
