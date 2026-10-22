import { describe, expect, it } from "vitest";
import {
  testNamesIn,
  verifyAccounts,
} from "../../../../src/workflow/product/account-verification.js";
import type { ProductExecution } from "../../../../src/workflow/product/model.js";
import { scanTestSources } from "../../../../src/workflow/product/test-sources.js";

const run = (
  output: string,
  baseline?: string,
  fields: Partial<ProductExecution> = {},
): ProductExecution =>
  ({
    id: "e1",
    check: "C001",
    status: "passed",
    output,
    ...(baseline === undefined
      ? {}
      : {
          flip: {
            failsWithoutChange: true,
            revertedFiles: [],
            preservedValidationFiles: [],
            commands: [
              { command: "x", exitCode: 1, passed: false, durationMs: 1, output: baseline },
            ],
          },
        }),
    ...fields,
  }) as ProductExecution;

const account = (note: string | undefined, id = "R001", check = "C001") => ({
  id,
  status: "done",
  check,
  ...(note ? { note } : {}),
});

const UNITTEST_V = [
  "test_bundle_all_or_nothing (test_api.ApiTest) ... ok",
  "test_bundle_validation (test_api.ApiTest) ... ok",
  "test_errors (test_api.ApiTest) ... ok",
  "",
  "Ran 3 tests in 0.1s",
  "",
  "OK",
].join("\n");

describe("testNamesIn", () => {
  it("takes identifier-shaped words and leaves prose and file names", () => {
    expect(testNamesIn("test_bundle_hold test_bundle_release")).toEqual([
      "test_bundle_hold",
      "test_bundle_release",
    ]);
    expect(testNamesIn("[SheetTest, all new classes]; README contract updated")).toEqual([
      "SheetTest",
    ]);
    expect(testNamesIn("test_api.ApiTest.test_get_reservation")).toEqual([
      "test_api.ApiTest.test_get_reservation",
    ]);
    expect(testNamesIn("testBundleHold(), tests/test_api.py::test_x")).toEqual(["testBundleHold"]);
    expect(testNamesIn("test_api.py imports only the standard library and unittest")).toEqual([]);
    expect(testNamesIn("all 50 tests; README contract updated, e.g. docs")).toEqual([]);
    expect(testNamesIn(undefined)).toEqual([]);
  });
});

describe("verifyAccounts", () => {
  it("verifies names a verbose run lists as passed, and says when they failed on the old code", () => {
    const baseline = [
      "test_bundle_all_or_nothing (test_api.ApiTest) ... ERROR",
      "test_bundle_validation (test_api.ApiTest) ... FAIL",
      "test_errors (test_api.ApiTest) ... ok",
    ].join("\n");
    const result = verifyAccounts(
      [
        account("test_bundle_all_or_nothing test_bundle_validation", "R001"),
        account("test_errors", "R002"),
      ],
      [run(UNITTEST_V, baseline)],
    );
    expect(result.get("R001")).toMatchObject({
      status: "verified",
      summary:
        "verified: every named test passed in C001's latest run (and failed on the old code)",
    });
    expect(result.get("R002")).toMatchObject({
      status: "claimed",
      names: [{ name: "test_errors", verdict: "claimed", reason: "passes-before" }],
      summary:
        "not confirmed from the check output: test_errors: also passes on the old code, so it does not show the change",
    });
  });

  it("claims, not verifies, names when the runner printed only dots", () => {
    const dots =
      "..........\n----------------------------------------------------------------------\nRan 10 tests in 1.355s\n\nOK";
    const [only] = [...verifyAccounts([account("test_a test_b")], [run(dots)]).values()];
    expect(only).toMatchObject({
      status: "claimed",
      summary: "not confirmed from the check output: C001's output lists no test names (2 named)",
    });
  });

  it("claims a name the per-test output does not list, or lists without an outcome", () => {
    const output = `${UNITTEST_V}\nnote: test_bundle_hold was skipped by the harness`;
    const result = verifyAccounts(
      [account("test_missing", "R001"), account("test_bundle_hold", "R002")],
      [run(output)],
    );
    expect(result.get("R001")?.summary).toBe(
      "not confirmed from the check output: test_missing: not in C001's output",
    );
    expect(result.get("R002")?.summary).toBe(
      "not confirmed from the check output: test_bundle_hold: C001's output does not say whether it passed",
    );
  });

  it("claims a name the latest run lists as failed", () => {
    const output = "test_a (m.C) ... ok\ntest_b (m.C) ... FAIL\n";
    const result = verifyAccounts([account("test_a test_b")], [run(output)]);
    expect(result.get("R001")?.summary).toBe(
      "not confirmed from the check output: test_b: failed in C001's latest run",
    );
  });

  it("reads pytest, node:test, TAP and go test outputs", () => {
    const outputs = [
      "tests/test_api.py::ApiTest::test_one PASSED [ 50%]\ntests/test_api.py::ApiTest::test_two PASSED [100%]",
      "✔ test_one (1.2ms)\n✔ test_two (0.4ms)\nℹ pass 2",
      "ok 1 - test_one\nok 2 - test_two\n1..2",
      "--- PASS: test_one (0.00s)\n--- PASS: test_two (0.00s)\nPASS",
    ];
    for (const output of outputs) {
      const result = verifyAccounts([account("test_one test_two")], [run(output)]);
      expect(result.get("R001")?.status, output).toBe("verified");
    }
  });

  it("reads the latest passing run of the cited check, not an earlier or another check's", () => {
    const early = run("test_a ... ok", undefined, { id: "e1" });
    const other = run("test_a ... ok", undefined, { id: "e2", check: "C002" });
    const late = run("test_b ... ok", undefined, { id: "e3" });
    const result = verifyAccounts([account("test_a")], [early, late, other]);
    expect(result.get("R001")?.summary).toBe(
      "not confirmed from the check output: test_a: not in C001's output",
    );
  });

  it("says when an account names no test, and skips accounts that are not done or have no passing run", () => {
    const result = verifyAccounts(
      [
        account("all 50 tests", "R001"),
        { id: "R002", status: "not-done" },
        account("test_a", "R003", "C009"),
      ],
      [run(UNITTEST_V)],
    );
    expect(result.get("R001")).toMatchObject({
      status: "no-names",
      summary: "no test named; only that C001 passed",
    });
    expect([...result.keys()]).toEqual(["R001"]);
  });
});

const RESERVATIONS_PY = [
  "import unittest",
  "",
  "class ApiTest(unittest.TestCase):",
  "    def test_bundle_idempotency_key(self):",
  "        pass",
  "",
  "    def test_expired_reservation(self):",
  "        pass",
  "",
  "    def helper(self):",
  "        pass",
].join("\n");

const sources = (files: Record<string, string>) =>
  scanTestSources(Object.entries(files).map(([path, text]) => ({ path, text })));

const DOTS = (count: number, tail = "OK") =>
  `${".".repeat(count)}\n----------------------------------------------------------------------\nRan ${count} tests in 0.4s\n\n${tail}`;

describe("suite-level verification", () => {
  const python = sources({ "tests/test_api.py": RESERVATIONS_PY });

  it("verifies a name a dots-only unittest run does not list when the suite passed and the name is defined", () => {
    const result = verifyAccounts([account("test_bundle_idempotency_key")], [run(DOTS(2))], python);
    expect(result.get("R001")).toMatchObject({
      status: "verified",
      names: [
        {
          name: "test_bundle_idempotency_key",
          verdict: "verified",
          basis: "suite-passed",
          definedIn: ["tests/test_api.py"],
        },
      ],
      summary:
        "verified at suite level: C001 passed (Ran 2 tests, OK) and the named test is defined in tests/test_api.py; its output does not list tests one by one",
    });
  });

  it("verifies test classes and module-qualified names", () => {
    const files = sources({
      "tests/test_sheet.py": "class SheetTest(unittest.TestCase):\n    def test_a(self): pass\n",
      "tests/test_copy.py": "class CopyTest(TestCase):\n    def test_b(self): pass\n",
    });
    const result = verifyAccounts(
      [account("test_sheet.SheetTest", "R001"), account("[CopyTest]", "R002")],
      [run(DOTS(2))],
      files,
    );
    expect(result.get("R001")?.status).toBe("verified");
    expect(result.get("R002")?.status).toBe("verified");
  });

  it("reads the passing summaries of pytest, jest, mocha, TAP and go test", () => {
    const js = sources({
      "tests/a.test.js": "it('test_one', () => {});\ntest('test_two', () => {});",
    });
    const go = sources({
      "pkg/a_test.go": "func Test_one(t *testing.T) {}\nfunc Test_two(t *testing.T) {}",
    });
    const py = sources({ "tests/test_a.py": "def test_one(): pass\ndef test_two(): pass\n" });
    const cases: [string, ReturnType<typeof sources>][] = [
      ["..\n2 passed in 0.12s", py],
      ["==== 2 passed in 0.12s ====", py],
      ["Tests:       2 passed, 2 total\nTest Suites: 1 passed, 1 total", js],
      ["  2 passing (12ms)", js],
      ["ℹ tests 2\nℹ pass 2\nℹ fail 0", js],
      ["# tests 2\n# pass 2\n# fail 0", js],
      ["2/2 passed", js],
      ["ok  \texample.com/pkg\t0.004s", go],
    ];
    for (const [output, files] of cases) {
      const names = files === go ? "Test_one" : "test_one";
      const result = verifyAccounts([account(names)], [run(output)], files);
      expect(result.get("R001")?.status, output).toBe("verified");
    }
  });

  it("never verifies a name that is not defined anywhere", () => {
    const result = verifyAccounts([account("test_not_there")], [run(DOTS(2))], python);
    expect(result.get("R001")).toMatchObject({
      status: "claimed",
      names: [{ name: "test_not_there", verdict: "claimed", reason: "not-defined" }],
    });
    expect(result.get("R001")?.summary).toBe(
      "not confirmed from the check output: test_not_there is not defined in the project's test files",
    );
  });

  it("never verifies from a suite with failures, errors or skips", () => {
    const outputs = [
      DOTS(2, "FAILED (failures=1)"),
      DOTS(2, "FAILED (errors=1)"),
      DOTS(2, "OK (skipped=1)"),
      "F.\n1 failed, 1 passed in 0.2s",
      "1 passed, 1 skipped in 0.2s",
      "Tests:       1 failed, 1 passed, 2 total",
      "ℹ pass 1\nℹ fail 1",
    ];
    for (const output of outputs) {
      const result = verifyAccounts(
        [account("test_bundle_idempotency_key")],
        [run(output)],
        python,
      );
      expect(result.get("R001")?.status, output).toBe("claimed");
    }
  });

  it("never verifies a defined name when the output has no passing summary", () => {
    for (const output of ["..........", "", "ran some tests, looks fine"]) {
      const result = verifyAccounts(
        [account("test_bundle_idempotency_key")],
        [run(output)],
        python,
      );
      expect(result.get("R001"), output).toMatchObject({
        status: "claimed",
        names: [{ verdict: "claimed", reason: "no-test-names" }],
      });
    }
  });

  it("claims the name when the suite ran fewer tests than the test files define", () => {
    const result = verifyAccounts([account("test_bundle_idempotency_key")], [run(DOTS(1))], python);
    expect(result.get("R001")).toMatchObject({
      status: "claimed",
      names: [{ reason: "count-mismatch" }],
    });
    expect(result.get("R001")?.summary).toBe(
      "not confirmed from the check output: C001 ran 1 test but the test files define 2",
    );
  });

  it("claims names when no test sources are available", () => {
    const result = verifyAccounts([account("test_bundle_idempotency_key")], [run(DOTS(2))]);
    expect(result.get("R001")?.status).toBe("claimed");
    expect(result.get("R001")?.summary).toBe(
      "not confirmed from the check output: C001's output lists no test names (1 named)",
    );
  });

  it("does not use the suite for a name a listing runner leaves out", () => {
    const result = verifyAccounts(
      [account("test_bundle_idempotency_key")],
      [run(UNITTEST_V)],
      python,
    );
    expect(result.get("R001")?.names).toMatchObject([{ reason: "not-in-output" }]);
  });

  it("keeps the old-code comparison: a suite that passes on the old code does not show the change", () => {
    const failing = DOTS(2, "FAILED (failures=1)");
    const before = verifyAccounts(
      [account("test_bundle_idempotency_key")],
      [run(DOTS(2), failing)],
      python,
    );
    expect(before.get("R001")?.status).toBe("verified");
    const same = verifyAccounts(
      [account("test_bundle_idempotency_key")],
      [run(DOTS(2), DOTS(2))],
      python,
    );
    expect(same.get("R001")).toMatchObject({
      status: "claimed",
      names: [{ reason: "passes-before" }],
    });
  });
});

describe("custom runner lines", () => {
  it("reads 'ok <title>' lines as passed tests and 'not ok <title>' as failed", () => {
    const output = [
      "Core",
      "ok    gameTest exposes pause/step/resume/launch/restart/snapshot",
      "not ok    gameBrokenTest still fails here",
      "ok    go.example.com/pkg   0.004s",
      "",
      "30/30 passed",
    ].join("\n");
    const result = verifyAccounts(
      [account("gameTest", "R001"), account("gameBrokenTest", "R002")],
      [run(output)],
    );
    expect(result.get("R001")).toMatchObject({ status: "verified" });
    expect(result.get("R002")?.names).toMatchObject([{ reason: "failed" }]);
  });
});

describe("wording", () => {
  it("does not read as doubt about the worker", () => {
    const [only] = [...verifyAccounts([account("test_a test_b")], [run("..........")]).values()];
    expect(only?.summary).toBe(
      "not confirmed from the check output: C001's output lists no test names (2 named)",
    );
  });
});
