import { describe, expect, it } from "vitest";
import {
  testNamesIn,
  verifyAccounts,
} from "../../../../src/workflow/product/account-verification.js";
import type { ProductExecution } from "../../../../src/workflow/product/model.js";

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
        "claimed, not verified: test_errors: also passes on the old code, so it does not show the change",
    });
  });

  it("claims, not verifies, names when the runner printed only dots", () => {
    const dots =
      "..........\n----------------------------------------------------------------------\nRan 10 tests in 1.355s\n\nOK";
    const [only] = [...verifyAccounts([account("test_a test_b")], [run(dots)]).values()];
    expect(only).toMatchObject({
      status: "claimed",
      summary: "claimed, not verified: C001's output lists no test names (2 named)",
    });
  });

  it("claims a name the per-test output does not list, or lists without an outcome", () => {
    const output = `${UNITTEST_V}\nnote: test_bundle_hold was skipped by the harness`;
    const result = verifyAccounts(
      [account("test_missing", "R001"), account("test_bundle_hold", "R002")],
      [run(output)],
    );
    expect(result.get("R001")?.summary).toBe(
      "claimed, not verified: test_missing: not in C001's output",
    );
    expect(result.get("R002")?.summary).toBe(
      "claimed, not verified: test_bundle_hold: C001's output does not say whether it passed",
    );
  });

  it("claims a name the latest run lists as failed", () => {
    const output = "test_a (m.C) ... ok\ntest_b (m.C) ... FAIL\n";
    const result = verifyAccounts([account("test_a test_b")], [run(output)]);
    expect(result.get("R001")?.summary).toBe(
      "claimed, not verified: test_b: failed in C001's latest run",
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
    expect(result.get("R001")?.summary).toBe("claimed, not verified: test_a: not in C001's output");
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
