import { expect, it } from "vitest";
import { ok } from "../../../../src/core/result.js";
import { classifyFlip } from "../../../../src/workflow/product/flip/flip-check.js";
import type { ProductCheck } from "../../../../src/workflow/product/model.js";
import { reviewCheckResult } from "../../../../src/workflow/product/review/review-check-context.js";
import { compactProductReply } from "../../../../src/workflow/product-compact-text.js";

const unittestCheck: ProductCheck = {
  id: "C001",
  command: ["python3", "-m", "unittest"],
  files: [],
  outcomes: ["O001"],
  environment: "other" as const,
};

function classify(stdout: string, reverted: string[], check: ProductCheck = unittestCheck) {
  return classifyFlip(
    ok({ command: "x", exitCode: 1, stdout, stderr: "", durationMs: 1, timedOut: false }),
    check,
    reverted,
    [],
    "/tmp/tree",
    (text) => text,
  );
}

const UNITTEST_IMPORT = `E
======================================================================
ERROR: test_calc (unittest.loader._FailedTest.test_calc)
----------------------------------------------------------------------
ImportError: Failed to import test module: test_calc
Traceback (most recent call last):
  File "/usr/lib/python3.10/unittest/loader.py", line 154, in loadTestsFromName
    module = __import__(module_name)
  File "/tmp/tree/test_calc.py", line 1, in <module>
    from calc import add, mul
ImportError: cannot import name 'mul' from 'calc' (/tmp/tree/calc.py)

----------------------------------------------------------------------
Ran 1 test in 0.000s

FAILED (errors=1)
`;
const UNITTEST_IMPORT_AND_FAILURE = `${UNITTEST_IMPORT.replace("Ran 1 test", "Ran 3 tests")}FAIL: test_add (test_other.T.test_add)\n`;
const UNITTEST_IMPORT_OTHERS_RAN = UNITTEST_IMPORT.replace("Ran 1 test", "Ran 4 tests");
const PYTEST_COLLECT =
  "___________________ ERROR collecting test_calc.py ____________________\nImportError while importing test module '/tmp/tree/test_calc.py'.\nE   ImportError: cannot import name 'mul' from 'calc' (/tmp/tree/calc.py)\n!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!\n1 error in 0.12s\n";
const NODE_MISSING_MODULE =
  "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/tree/src/calc.mjs' imported from /tmp/tree/test/calc.test.mjs\n    at finalizeResolution (node:internal/modules/esm/resolve:272:11)\n✖ test/calc.test.mjs (31.2ms)\nℹ tests 1\nℹ pass 0\nℹ fail 1\n";
// Node 22 prints TAP when stdout is not a terminal; Node 24 and later print the `✖ file` line.
const NODE_MISSING_MODULE_TAP =
  "TAP version 13\n# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/tree/src/calc.mjs' imported from /tmp/tree/test/calc.test.mjs\n#     at finalizeResolution (node:internal/modules/esm/resolve:275:11)\n# Node.js v22.16.0\n# Subtest: test/calc.test.mjs\nnot ok 1 - test/calc.test.mjs\n  ---\n  duration_ms: 44.2\n  type: 'test'\n  failureType: 'testCodeFailure'\n  exitCode: 1\n  error: 'test failed'\n  code: 'ERR_TEST_FAILURE'\n  ...\n1..1\n# tests 1\n# pass 0\n# fail 1\n";
const NODE_TAP_SUBTEST_FAILED =
  "TAP version 13\n# Subtest: test/calc.test.mjs\n    # Subtest: loads lazily\n    not ok 1 - loads lazily\n      ---\n      failureType: 'testCodeFailure'\n      error: \"Cannot find module '/tmp/tree/src/calc.mjs'\"\n      code: 'ERR_MODULE_NOT_FOUND'\n      ...\n    1..1\nnot ok 1 - test/calc.test.mjs\n  ---\n  type: 'test'\n  failureType: 'subtestsFailed'\n  ...\n1..1\n# tests 1\n# pass 0\n# fail 1\n";
const NODE_TAP_OTHERS_PASSED = NODE_MISSING_MODULE_TAP.replace("# pass 0", "# pass 2");
const VITEST_COLLECT =
  " RUN  v3.2.7 /tmp/tree\n\n⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯\n\n FAIL  tests/calc.test.ts [ tests/calc.test.ts ]\nError: Cannot find module '../src/calc.js' imported from '/tmp/tree/tests/calc.test.ts'\n\n Test Files  1 failed (1)\n      Tests  no tests\n";
const VITEST_COLLECT_AND_FAILURE = `${VITEST_COLLECT.replace("Tests  no tests", "Tests  2 failed | 3 passed (5)")}`;

it.each([
  ["a unittest import error", UNITTEST_IMPORT, ["calc.py"]],
  ["a pytest collection error", PYTEST_COLLECT, ["calc.py"]],
  ["a node missing module", NODE_MISSING_MODULE, ["src/calc.mjs"]],
  ["a node missing module in TAP output", NODE_MISSING_MODULE_TAP, ["src/calc.mjs"]],
  ["a vitest suite that cannot load", VITEST_COLLECT, ["src/calc.ts"]],
])("marks %s as a check that could not load without the change", (_name, stdout, reverted) => {
  expect(classify(stdout, reverted)).toMatchObject({
    failsWithoutChange: true,
    signal: "structural",
    failedToLoad: true,
  });
});

it.each([
  ["a test that failed beside the import error", UNITTEST_IMPORT_AND_FAILURE, ["calc.py"]],
  ["other unittest tests that ran", UNITTEST_IMPORT_OTHERS_RAN, ["calc.py"]],
  ["a vitest run with failing tests as well", VITEST_COLLECT_AND_FAILURE, ["src/calc.ts"]],
  ["a TAP file whose own test failed", NODE_TAP_SUBTEST_FAILED, ["src/calc.mjs"]],
  ["a TAP run in which other tests passed", NODE_TAP_OTHERS_PASSED, ["src/calc.mjs"]],
  ["an assertion", "AssertionError: expected 1 to be 2\nFAILED (failures=1)\n", ["calc.py"]],
  [
    "a syntax error with no runner signal",
    "/tmp/tree/src/value.mjs:1\nSyntaxError: invalid syntax\nFAILED (errors=1)",
    ["src/value.mjs"],
  ],
])("does not call %s a load failure", (_name, stdout, reverted) => {
  expect(classify(stdout, reverted)).not.toHaveProperty("failedToLoad");
});

const flipped = (extra: Record<string, unknown>) =>
  ({
    id: "E1",
    check: "C001",
    status: "passed",
    exitCode: 0,
    command: "python3 -m unittest",
    provenance: "supervisor-executed",
    assertions: "agent-reported",
    output: "ok",
    flip: {
      failsWithoutChange: true,
      signal: "structural",
      reason: "ImportError: cannot import name 'mul'",
      revertedFiles: ["calc.py"],
      preservedValidationFiles: [],
      commands: [],
      ...extra,
    },
  }) as unknown as Parameters<typeof reviewCheckResult>[0];

it("tells the reviewer that a check could not load, not that it failed", () => {
  const loading = reviewCheckResult(flipped({ failedToLoad: true }), undefined, { timing: false });
  expect(loading).toContain(
    "tests kept): could not load: the old code failed at import or collection",
  );
  expect(loading).not.toContain("tests kept): failed");
  expect(loading).toContain("ImportError: cannot import name 'mul'");
  expect(reviewCheckResult(flipped({}), undefined, { timing: false })).toContain(
    "tests kept): failed (ImportError",
  );
});

function replyChecks(extra: Record<string, unknown>) {
  const execution = flipped(extra) as unknown as Record<string, unknown>;
  const text = compactProductReply("done", { feature: "001-calc", executions: [execution] }, "cli");
  return JSON.parse((text ?? "").split("\n")[0]?.replace("done: ", "") ?? "{}").checks;
}

it("words the reply so a load failure does not read as a failing behavior", () => {
  const [loading] = replyChecks({ failedToLoad: true });
  expect(loading.failsWithoutChange).toBe("could not load without the change");
  expect(loading.flipReason).toContain("ImportError");
  const [ran] = replyChecks({});
  expect(ran.failsWithoutChange).toBe(true);
});
