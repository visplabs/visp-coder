import { describe, expect, it } from "vitest";
import { verifyAccounts } from "../../../../src/workflow/product/account-verification.js";
import type { ProductExecution } from "../../../../src/workflow/product/model.js";
import { scanTestSources } from "../../../../src/workflow/product/test-sources.js";

/**
 * Real output of vitest 3.2 and jest 30 on three small files: tests/cart.test.js (two tests),
 * tests/total.test.js (one) and tests/bad.test.js (one that fails). Only the RUN banner, the
 * blank lines and the timestamps are trimmed.
 */

const VITEST_DEFAULT = [
  " ✓ tests/total.test.js (1 test) 3ms",
  " ✓ tests/cart.test.js (2 tests) 3ms",
  "",
  " Test Files  2 passed (2)",
  "      Tests  3 passed (3)",
  "   Start at  03:29:55",
  "   Duration  523ms (transform 34ms, setup 0ms, collect 24ms, tests 5ms, environment 1ms, prepare 322ms)",
].join("\n");

const VITEST_ONE_FILE = [
  " ✓ tests/cart.test.js (2 tests) 3ms",
  "",
  " Test Files  1 passed (1)",
  "      Tests  2 passed (2)",
].join("\n");

const VITEST_VERBOSE = [
  " ✓ tests/total.test.js > total_includes_tax 2ms",
  " ✓ tests/cart.test.js > adds an item to the cart 1ms",
  " ✓ tests/cart.test.js > removes an item from the cart 0ms",
  "",
  " Test Files  2 passed (2)",
  "      Tests  3 passed (3)",
].join("\n");

const VITEST_FAILED_FILE = [
  " ✓ tests/cart.test.js (2 tests) 3ms",
  " ❯ tests/bad.test.js (1 test | 1 failed) 11ms",
  "   × bad_one 9ms",
  "     → expected 1 to be 2 // Object.is equality",
  "",
  "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
  "",
  " FAIL  tests/bad.test.js > bad_one",
  "AssertionError: expected 1 to be 2 // Object.is equality",
  "",
  " Test Files  1 failed | 1 passed (2)",
  "      Tests  1 failed | 2 passed (3)",
].join("\n");

/** Another file fails to load, so the test count stays clean while a file failed. */
const VITEST_LOAD_ERROR = [
  " ✓ tests/cart.test.js (2 tests) 3ms",
  "",
  "⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯",
  "",
  " FAIL  tests/bad.test.js [ tests/bad.test.js ]",
  "ReferenceError: test is not defined",
  "",
  " Test Files  1 failed | 1 passed (2)",
  "      Tests  2 passed (2)",
].join("\n");

const VITEST_LOAD_ERROR_SUMMARY = " Test Files  1 failed | 1 passed (2)\n      Tests  2 passed (2)";
const VITEST_DOTS = " Test Files  2 passed (2)\n      Tests  3 passed (3)\n   Duration  523ms";

const JEST_ONE_FILE = [
  "PASS tests/cart.test.js",
  "  ✓ adds an item to the cart (2 ms)",
  "  ✓ removes an item from the cart",
  "",
  "Test Suites: 1 passed, 1 total",
  "Tests:       2 passed, 2 total",
  "Snapshots:   0 total",
  "Time:        0.308 s, estimated 1 s",
  "Ran all test suites matching tests/cart.test.js.",
].join("\n");

const JEST_TWO_FILES = [
  "PASS tests/total.test.js",
  "PASS tests/cart.test.js",
  "",
  "Test Suites: 2 passed, 2 total",
  "Tests:       3 passed, 3 total",
  "Snapshots:   0 total",
  "Time:        0.383 s, estimated 1 s",
  "Ran all test suites matching tests/cart.test.js|tests/total.test.js.",
].join("\n");

const JEST_VERBOSE = [
  "PASS tests/total.test.js",
  "  ✓ total_includes_tax (3 ms)",
  "PASS tests/cart.test.js",
  "  ✓ adds an item to the cart (1 ms)",
  "  ✓ removes an item from the cart",
  "",
  "Test Suites: 2 passed, 2 total",
  "Tests:       3 passed, 3 total",
].join("\n");

const JEST_FAILED_FILE = [
  "FAIL tests/bad.test.js",
  "  ● bad_one",
  "",
  "    expect(received).toBe(expected) // Object.is equality",
  "",
  "    Expected: 2",
  "    Received: 1",
  "",
  "PASS tests/cart.test.js",
  "",
  "Test Suites: 1 failed, 1 passed, 2 total",
  "Tests:       1 failed, 2 passed, 3 total",
].join("\n");

/** A suite that cannot run is reported on its own line, and Tests counts only what ran. */
const JEST_SUITE_ERROR = [
  "PASS tests/cart.test.js",
  "",
  "Test Suites: 1 failed, 1 passed, 2 total",
  "Tests:       2 passed, 2 total",
].join("\n");

const FILES = {
  "tests/cart.test.js":
    "test('adds an item to the cart', () => {});\ntest('removes an item from the cart', () => {});\n",
  "tests/total.test.js": "test('total_includes_tax', () => {});\n",
  "tests/bad.test.js": "test('bad_one', () => {});\n",
};

const sources = (files: Record<string, string> = FILES) =>
  scanTestSources(Object.entries(files).map(([path, text]) => ({ path, text })));

const check = (output: string, command = "pnpm test"): ProductExecution =>
  ({ id: "e1", check: "C001", command, status: "passed", output }) as ProductExecution;

const verify = (note: string, output: string, files?: Record<string, string>, command?: string) =>
  verifyAccounts(
    [{ id: "R001", status: "done", check: "C001", note }],
    [check(output, command)],
    sources(files),
  ).get("R001");

const ONLY_TOTAL = { "tests/total.test.js": FILES["tests/total.test.js"] };

describe("named tests under the default reporters of vitest and jest", () => {
  it("verifies at suite level when vitest lists files only", () => {
    expect(verify("total_includes_tax", VITEST_DEFAULT)).toMatchObject({
      status: "verified",
      names: [
        {
          name: "total_includes_tax",
          verdict: "verified",
          basis: "suite-passed",
          definedIn: ["tests/total.test.js"],
        },
      ],
      summary:
        "verified at suite level: C001 passed (3 passed) and the named test is defined in tests/total.test.js; its output does not list tests one by one",
    });
  });

  it("verifies a test named by its title under vitest's file lines", () => {
    expect(verify("adds an item to the cart", VITEST_DEFAULT)).toMatchObject({
      status: "verified",
      names: [{ name: "adds an item to the cart", basis: "suite-passed" }],
    });
  });

  it("verifies at suite level when jest lists files only (two or more files)", () => {
    expect(verify("total_includes_tax", JEST_TWO_FILES)).toMatchObject({
      status: "verified",
      names: [{ verdict: "verified", basis: "suite-passed", definedIn: ["tests/total.test.js"] }],
    });
  });

  it("keeps listing: jest with one file prints its tests, and a name it lacks is not confirmed", () => {
    expect(verify("adds an item to the cart", JEST_ONE_FILE)).toMatchObject({
      status: "verified",
      names: [{ verdict: "verified", basis: "listed" }],
    });
    expect(verify("total_includes_tax", JEST_ONE_FILE)).toMatchObject({
      status: "claimed",
      names: [{ reason: "not-in-output" }],
    });
  });

  it("looks the name up by title under vitest --reporter=verbose and jest --verbose", () => {
    for (const output of [VITEST_VERBOSE, JEST_VERBOSE]) {
      expect(verify("total_includes_tax", output)).toMatchObject({
        status: "verified",
        names: [{ verdict: "verified", basis: "listed" }],
      });
      expect(verify("test_not_listed", output)).toMatchObject({
        status: "claimed",
        names: [{ reason: "not-in-output" }],
      });
    }
  });

  it("does not confirm a title the verbose output lacks", () => {
    for (const output of [VITEST_VERBOSE, JEST_VERBOSE]) {
      expect(verify("total_includes_vat", output)).toMatchObject({
        status: "claimed",
        names: [{ reason: "not-in-output" }],
      });
    }
  });

  it("does not confirm when the test's own file failed", () => {
    expect(verify("bad_one", VITEST_FAILED_FILE)).toMatchObject({
      status: "claimed",
      names: [{ reason: "failed" }],
    });
    expect(verify("bad_one", JEST_FAILED_FILE)?.status).toBe("claimed");
  });

  it("does not confirm a name in a passing file when another file failed", () => {
    for (const output of [VITEST_FAILED_FILE, JEST_FAILED_FILE, VITEST_LOAD_ERROR]) {
      expect(verify("adds an item to the cart", output)?.status, output).not.toBe("verified");
      expect(verify("total_includes_tax", output)?.status, output).toBe("claimed");
    }
  });

  it("does not confirm from a clean test count while a file or suite failed to run", () => {
    expect(verify("total_includes_tax", VITEST_LOAD_ERROR)?.status).toBe("claimed");
    // The same summaries without the FAIL lines, as a dot reporter prints them.
    for (const output of [VITEST_LOAD_ERROR_SUMMARY, JEST_SUITE_ERROR]) {
      expect(verify("total_includes_tax", output)).toMatchObject({
        status: "claimed",
        names: [{ reason: "no-test-names" }],
      });
    }
  });

  it("verifies at suite level from the vitest summary a dot reporter prints", () => {
    const { "tests/bad.test.js": _failing, ...passing } = FILES;
    expect(verify("total_includes_tax", VITEST_DOTS, passing)).toMatchObject({
      status: "verified",
      names: [{ basis: "suite-passed" }],
    });
  });

  it("does not confirm when vitest skipped a test or file", () => {
    const skipped = " Test Files  2 passed (2)\n      Tests  2 passed | 1 skipped (3)";
    expect(verify("total_includes_tax", skipped)?.status).toBe("claimed");
  });

  it("does not confirm a name the covered files do not define", () => {
    expect(verify("test_never_written", VITEST_DEFAULT)).toMatchObject({
      status: "claimed",
      names: [{ reason: "not-defined" }],
    });
  });

  it("does not confirm a name defined only in a file the output does not show", () => {
    expect(verify("total_includes_tax", VITEST_ONE_FILE)).toMatchObject({
      status: "claimed",
      names: [{ reason: "not-covered" }],
    });
  });

  it("does not confirm when the run counts more tests than the covered files define", () => {
    expect(verify("total_includes_tax", VITEST_DEFAULT, ONLY_TOTAL)).toMatchObject({
      status: "claimed",
      names: [{ reason: "count-mismatch", counts: { ran: 3, defined: 1 } }],
    });
  });

  it("does not confirm when the test also passed on the old code", () => {
    const result = verifyAccounts(
      [{ id: "R001", status: "done", check: "C001", note: "total_includes_tax" }],
      [
        {
          ...check(VITEST_DEFAULT),
          flip: {
            failsWithoutChange: false,
            revertedFiles: [],
            preservedValidationFiles: [],
            commands: [
              { command: "x", exitCode: 0, passed: true, durationMs: 1, output: VITEST_DEFAULT },
            ],
          },
        } as ProductExecution,
      ],
      sources(),
    );
    expect(result.get("R001")).toMatchObject({
      status: "claimed",
      names: [{ reason: "passes-before" }],
    });
  });
});
