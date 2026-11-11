/**
 * A runner's own words for a test file it could not import or collect. Each pattern needs the
 * runner to say so; an error text alone (a missing module, a syntax error) can also come from a
 * test body that ran.
 */
const PYTHON_LOAD_FAILURE = [
  /unittest\.loader\._FailedTest|ImportError: Failed to import test module/,
  /ImportError while importing test module|\bERROR collecting\b|\berrors? during collection\b/,
];
const SCRIPT_LOAD_ERROR =
  /ERR_MODULE_NOT_FOUND|\bMODULE_NOT_FOUND\b|does not provide an export named|Cannot find module|Failed to (?:load url|resolve import)/;
/** A file the runner reports as failed before it ran a test in it (node:test, vitest, jest). */
const SCRIPT_FILE_FAILED = [
  /^✖ (?:file:\/\/)?\S+\.[cm]?[jt]sx?\s+\(\d[\d.]*ms\)/m,
  // node:test's TAP output (Node 22 off a terminal): the file itself failed, not a test in it.
  /^not ok \d+ - (?:[^\s.]*\.)+[cm]?[jt]sx?\r?\n(?: {2}(?!failureType:)\S[^\n]*\n)* {2}failureType: 'testCodeFailure'/m,
  /⎯ Failed Suites\b/,
  /^[ \t]*FAIL[ \t]+(\S+)[ \t]+\[[ \t]*\1[ \t]*\]/m,
  /Test suite failed to run/,
];
/** Signs that some test ran, so the failure is not only a load failure. */
const TEST_RAN = [
  /AssertionError|ERR_ASSERTION/,
  /^FAIL: /m,
  /FAILED \([^)]*failures=[1-9]/,
  /\b[1-9]\d* (?:passed|failed)\b/,
  /(?:ℹ|^#) pass [1-9]/m,
  /^ok \d+/m,
  /^[ \t]*[✓✔][ \t]/m,
  /\.\.\. ok$/m,
];

function unittestRanOthers(output: string) {
  const ran = Number(/^Ran (\d+) tests?\b/m.exec(output)?.[1] ?? 0);
  return ran > output.split("unittest.loader._FailedTest").length - 1;
}

function ranATest(output: string) {
  // Summary lines that count files or suites also say "failed"; they say nothing about tests.
  const lines = output
    .split(/\r?\n/)
    .filter((line) => !/^\s*Test (?:Files|Suites)\b/i.test(line))
    .join("\n");
  return TEST_RAN.some((pattern) => pattern.test(lines)) || unittestRanOthers(output);
}

/**
 * Whether a failed run is a failure to import or collect its tests, on a clear runner signal and
 * with no sign that any test ran. Anything less clear returns false, so the result keeps today's
 * wording: a failure of the old behavior.
 */
function couldNotLoad(output: string): boolean {
  const named =
    PYTHON_LOAD_FAILURE.some((pattern) => pattern.test(output)) ||
    (SCRIPT_LOAD_ERROR.test(output) && SCRIPT_FILE_FAILED.some((pattern) => pattern.test(output)));
  return named && !ranATest(output);
}

/** The result field for a failure the attribution found structural, when it was a load failure. */
export function loadFailure(structural: boolean, output: string): { failedToLoad?: true } {
  return structural && couldNotLoad(output) ? { failedToLoad: true } : {};
}

/** How a reply names a comparison whose old code could not load the check. */
export const COULD_NOT_LOAD = "could not load without the change";

/** The reviewer's word for the comparison: a load failure is not a failure of the behavior. */
export function flipOutcome(flip: {
  failsWithoutChange: boolean | "unchecked" | "not-applicable";
  failedToLoad?: boolean;
}): string {
  if (flip.failsWithoutChange === true && flip.failedToLoad)
    return "could not load: the old code failed at import or collection, so no test ran without the change";
  return flip.failsWithoutChange === true
    ? "failed"
    : flip.failsWithoutChange === false
      ? "passed"
      : "unchecked";
}
