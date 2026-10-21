import { expect, it } from "vitest";
import { earlierAssertionResults } from "../../../../src/workflow/product/review/review-check-output.js";

it("retains named unittest, TAP and pinned results before verbose log tails", () => {
  const text = [
    "test_retired (tests.Api) ... ok",
    "test_invalid (tests.Api) ... FAIL",
    "# Subtest: a value",
    "ok 1 - a value",
    "PASS: docs updated",
    "noise\n".repeat(3000),
  ].join("\n");
  const result = earlierAssertionResults(text, 3000);
  for (const name of ["test_retired", "test_invalid", "ok 1 - a value", "PASS: docs updated"])
    expect(result).toContain(name);
  expect(result).toContain("output shortened");
  expect(result.length).toBeLessThanOrEqual(2000);
});
it("discloses omitted names without manufacturing results for silent checks", () => {
  const result = earlierAssertionResults(
    `${Array.from({ length: 100 }, (_, i) => `PASS: assertion ${i}`).join("\n")}\n${"noise\n".repeat(3000)}`,
    2000,
    700,
  );
  expect(result).toContain("omitted");
  expect(result.length).toBeLessThanOrEqual(700);
  expect(earlierAssertionResults("no named assertions\n".repeat(1000), 3000)).toBe("");
});

it("prioritizes unobserved coverage gaps over passing names in bounded output", () => {
  const text = [
    ...Array.from({ length: 100 }, (_, i) => `PASS: assertion ${i}`),
    "  NOT OBSERVED: low-power contact: 0 qualifying events",
    "FAIL: damage: wrong amount",
    "noise\n".repeat(3000),
  ].join("\r\n");
  const result = earlierAssertionResults(text, 2000, 700, true);
  expect(result).toContain("NOT OBSERVED: low-power contact: 0 qualifying events");
  expect(result).toContain("coverage gap");
  expect(result).toContain("PASS: assertion 0");
  expect(result).not.toContain("FAIL: damage");
  expect(result.length).toBeLessThanOrEqual(700);
});

it("keeps a real failure ahead of coverage gaps and passes when no separate failure block exists", () => {
  const text = [
    ...Array.from({ length: 30 }, (_, i) => `PASS: assertion ${i}`),
    "FAIL: real assertion: wrong value",
    ...Array.from(
      { length: 40 },
      (_, i) => `NOT OBSERVED: conditional interaction ${i}: 0 qualifying events`,
    ),
    "x".repeat(5300),
  ].join("\n");
  const result = earlierAssertionResults(text, 2000);
  expect(result).toContain("FAIL: real assertion: wrong value");
  expect(result.indexOf("FAIL: real assertion")).toBeLessThan(result.indexOf("NOT OBSERVED:"));
  expect(result.length).toBeLessThanOrEqual(2000);
});
