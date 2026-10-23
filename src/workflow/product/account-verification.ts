import type { WorkspaceState } from "../state.js";
import type { ProductExecution } from "./model.js";
import { testFilesRun } from "./test-run-files.js";
import { loadTestSources, type TestRunnerKind, type TestSources } from "./test-sources.js";

/**
 * The worker's account of a listed requirement names the check that shows it and, usually, the
 * tests ("R002=C001 test_bundle_all_or_nothing"). Whether the check passed is judged elsewhere;
 * this reads the names against what the check printed. A name counts as verified when every line
 * of the cited check's latest passing run that names it reports a pass (none skipped, todo or
 * expected to fail) and, when the run on the old code lists it too, when it failed there. A runner
 * that prints only dots and a passing summary lists no names: then a name counts as verified at
 * suite level when the summary is a clean pass whose count equals the tests the test files it
 * covered define, and those files define the name. Everything else is not confirmed: VISP says
 * so, and never blocks on it.
 */

export type NameVerdict =
  | {
      readonly name: string;
      readonly verdict: "verified";
      readonly failsBefore: boolean;
      /** "listed": the output lists the test as passed. "suite-passed": the suite passed and the name is defined. */
      readonly basis: "listed" | "suite-passed";
      /** The test files that define the name; set for "suite-passed". */
      readonly definedIn?: readonly string[];
    }
  | {
      readonly name: string;
      readonly verdict: "claimed";
      readonly reason:
        | "no-test-names"
        | "not-defined"
        | "not-covered"
        | "uncountable"
        | "count-mismatch"
        | "not-in-output"
        | "no-outcome"
        | "skipped"
        | "failed"
        | "passes-before";
      /** For "count-mismatch": how many tests the run reports and how many the test files define. */
      readonly counts?: { readonly ran: number; readonly defined: number };
    };

export interface AccountVerification {
  readonly requirement: string;
  readonly check: string;
  /** "no-names": the account names no test VISP can look for, so only the check's own result stands. */
  readonly status: "verified" | "claimed" | "no-names";
  readonly names: readonly NameVerdict[];
  /** One sentence for the reply and the evidence record. */
  readonly summary: string;
}

/** What the reply and the evidence record say before the reason a name is not confirmed. */
export const NOT_CONFIRMED = "not confirmed from the check output: ";

const SOURCE_FILE =
  /\.(?:py|js|mjs|cjs|ts|tsx|jsx|rb|go|rs|java|kt|c|cc|cpp|h|cs|php|sh|md|json|ya?ml)$/i;
/** What one part of a test name looks like: `test_x`, `testX`, `TestX`, `XTest`, `snake_case` or `CamelCase`. */
const NAME_PART =
  /^(?:test_\w+|[Tt]est[A-Z]\w*|\w+Test|[A-Za-z]\w*_\w+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+)$/;

/** The test names in an account's note: identifier-shaped words, not file names or prose. */
export function testNamesIn(note: string | undefined): string[] {
  if (!note) return [];
  const names = new Set<string>();
  for (const word of note.split(/[\s,;]+/)) {
    const token = word.replace(/\(\)[\])"'`.:]*$/, "").replace(/^[[("'`]+|[\])"'`.:]+$/g, "");
    if (token.length < 4 || SOURCE_FILE.test(token) || token.includes("/")) continue;
    if (token.split(/::|\./).some((part) => NAME_PART.test(part))) names.add(token);
  }
  return [...names];
}

/** Titles of a few words, one per `;` or line: node:test and jest name a test by its title. */
function titleSegments(note: string | undefined): string[] {
  return (note ?? "")
    .split(/[;\n]/)
    .map((segment) => segment.trim().replace(/^[[("'`]+|[\])"'`.:]+$/g, ""))
    .filter((segment) => segment.length >= 12 && segment.split(/\s+/).length >= 3);
}

/** go test's package line (`ok  \tpkg\t0.004s`): it names no test and gives no count. */
const GO_PACKAGE = String.raw`\S+\s+(?:[\d.]+s|\(cached\))\s*$`;

const FAILED = /\b(?:FAIL(?:ED|URE)?|ERROR)\b|\bnot ok\b|[✖✕✗×]/;
const PASSED = /\.\.\. ok\b|\bPASS(?:ED)?\b|^\s*ok\s+\S|[✔✓✅]|\bok\b\s*(?:\(|$)/;
/**
 * A test that did not run as a plain pass: unittest's `skipped` and `expected failure`, pytest's
 * SKIPPED, XFAIL and XPASS, TAP's `# SKIP` and `# TODO`, go's `--- SKIP`, jest's `○` and `✎`.
 */
const NOT_RUN =
  /\.\.\. (?:skipped|expected failure|unexpected success)\b|\b(?:SKIPPED|XFAIL|XPASS)\b|--- SKIP\b|^\s*[○✎﹣]\s/;
const TAP_DIRECTIVE = /#\s*(?:skip|todo)\b/i;
const notRun = (line: string) => NOT_RUN.test(line) || TAP_DIRECTIVE.test(line);
/** Lines that report a test one by one: a runner printing only dots has none. */
const PER_TEST = new RegExp(
  String.raw`\.\.\. (?:ok|FAIL|ERROR|skipped)|\b(?:PASSED|FAILED|ERROR)\b|^\s*(?:PASS|FAIL)\s|[✔✓✖✕✅]|^\s*(?:not )?ok\s+(?!${GO_PACKAGE})\S|--- (?:PASS|FAIL)`,
  "m",
);

type Matcher = (line: string) => boolean;
type Outcome = "passed" | "failed" | "skipped" | "seen" | "absent";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const mention = (name: string) => new RegExp(`(?<![\\w])${escapeRegExp(name)}(?![\\w])`);

/**
 * The module and class a line gives for the test `leaf`, in unittest's form
 * (`test_x (pkg.test_api.ApiTest.test_x)`, or `(pkg.test_api.ApiTest)` before Python 3.11) or
 * pytest's (`tests/test_api.py::ApiTest::test_x`). Undefined when the line gives neither.
 */
function lineQualifiers(line: string, leaf: string): string[] | undefined {
  const name = escapeRegExp(leaf);
  const unittest = new RegExp(`(?<![\\w.])${name} \\(([\\w.]+)\\)`).exec(line)?.[1];
  if (unittest) {
    const parts = unittest.split(".");
    return parts.at(-1) === leaf ? parts.slice(0, -1) : parts;
  }
  const pytest = new RegExp(`([\\w./-]+)\\.py((?:::\\w+)*)::${name}(?![\\w])`).exec(line);
  return pytest
    ? [...(pytest[1] ?? "").split("/"), ...(pytest[2] ?? "").split("::").filter(Boolean)]
    : undefined;
}

/** `wanted` appear in `given` in the same order, other parts allowed between them. */
function inOrder(wanted: readonly string[], given: readonly string[]): boolean {
  let at = 0;
  for (const part of given) if (part === wanted[at]) at++;
  return at === wanted.length;
}

/**
 * A name stands alone in a line: not part of a longer identifier. A qualified name
 * (`test_api.ApiTest.test_x`) matches a line that contains it whole, or that gives the same
 * module and class for the test in unittest's or pytest's form; never another class's test.
 */
function nameMatcher(name: string): Matcher {
  const whole = mention(name);
  const parts = name.split(/::|\./);
  const leaf = parts.at(-1) ?? name;
  const qualifiers = parts.slice(0, -1);
  if (!qualifiers.length) return (line) => whole.test(line);
  const bare = mention(leaf);
  return (line) => {
    if (whole.test(line)) return true;
    const given = bare.test(line) ? lineQualifiers(line, leaf) : undefined;
    return given !== undefined && inOrder(qualifiers, given);
  };
}

const squash = (text: string) =>
  text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.:;,]+$/, "");

function titleMatcher(title: string): Matcher {
  const wanted = squash(title);
  return (line) => squash(line).includes(wanted);
}

/**
 * What a run's output says about one test, from every line that names it: failed if one fails,
 * else skipped if one is skipped, todo or expected to fail, else passed if one passes.
 */
function outcomeIn(output: string, matches: Matcher): Outcome {
  const lines = output.split("\n").filter(matches);
  if (!lines.length) return "absent";
  if (lines.some((line) => !notRun(line) && FAILED.test(line))) return "failed";
  if (lines.some(notRun)) return "skipped";
  return lines.some((line) => PASSED.test(line)) ? "passed" : "seen";
}

/** The old-code runs' output of an execution, joined; empty when no comparison ran. */
function baselineOutput(execution: ProductExecution): string {
  return (execution.flip?.commands ?? []).map((command) => command.output ?? "").join("\n");
}

/** A clean passing summary of a whole suite: what it says, how many tests it ran, and whose rules count them. */
interface SuitePass {
  readonly text: string;
  readonly ran: number;
  readonly runner: TestRunnerKind;
}

const SUITE_FAILURE = /^(?:FAILED|FAIL|not ok)\b|--- FAIL|^(?:ℹ|#) fail\s+[1-9]/m;
const UNITTEST_RAN = /^Ran (\d+) tests? in /m;
const UNITTEST_OK = /^OK$/m;
const PYTEST_SUMMARY = /^[= ]*((?:\d+ [a-z]+(?:, )?)+) in [\d.]+s\b/m;
const JEST_SUMMARY = /^Tests:\s+(\d+) passed, (\d+) total\b/m;
const MOCHA_PASSING = /^\s*(\d+) passing\b/m;
const MOCHA_NOT_PASSING = /^\s*\d+ (?:failing|pending)\b/m;
const NODE_PASS = /^(?:ℹ|#) pass\s+(\d+)\s*$/m;
const NODE_NOT_PASS = /^(?:ℹ|#) (?:fail\s+[1-9]|(?:skipped?|cancelled|todo)\s+[1-9])/m;
const ALL_PASSED = /\b(\d+)\/(\d+) (?:tests? )?passed\b|^all (\d+) tests? passed\b/im;

function pytestPass(output: string): SuitePass | undefined {
  const parts = PYTEST_SUMMARY.exec(output)?.[1]?.split(", ") ?? [];
  const passed = parts.map((part) => /^(\d+) passed$/.exec(part)?.[1]).find(Boolean);
  const rest = parts.filter((part) => !/^\d+ (?:passed|warnings?)$/.test(part));
  return passed && !rest.length
    ? { text: `${passed} passed`, ran: Number(passed), runner: "pytest" }
    : undefined;
}

function equalCounts(match: RegExpExecArray | null, runner: TestRunnerKind): SuitePass | undefined {
  const [, first, second, all] = match ?? [];
  const ran = Number(all ?? first);
  const total = Number(all ?? second);
  return match && ran === total && ran > 0 ? { text: `${ran} passed`, ran, runner } : undefined;
}

/**
 * The summary line of a run in which every test passed and none was skipped, for the runners VISP
 * knows that print a count: unittest, pytest, jest, mocha, node:test and TAP, and "N/N passed"
 * printers. Anything else, and any failure, skip or todo, is not a clean pass. go test's `ok pkg`
 * is not one: it gives no count, and a skipped test leaves it unchanged.
 */
function suitePass(output: string): SuitePass | undefined {
  if (SUITE_FAILURE.test(output)) return undefined;
  const ran = UNITTEST_RAN.exec(output)?.[1];
  if (ran)
    return UNITTEST_OK.test(output)
      ? { text: `Ran ${ran} tests, OK`, ran: Number(ran), runner: "unittest" }
      : undefined;
  const pytest = pytestPass(output);
  if (pytest) return pytest;
  const jest = JEST_SUMMARY.exec(output);
  if (jest) return equalCounts(jest, "js");
  const mocha = MOCHA_PASSING.exec(output)?.[1];
  if (mocha)
    return MOCHA_NOT_PASSING.test(output)
      ? undefined
      : { text: `${mocha} passing`, ran: Number(mocha), runner: "js" };
  const node = NODE_PASS.exec(output)?.[1];
  if (node)
    return NODE_NOT_PASS.test(output)
      ? undefined
      : { text: `${node} passed`, ran: Number(node), runner: "js" };
  return equalCounts(ALL_PASSED.exec(output), "any");
}

function verdictFor(name: string, matches: Matcher, execution: ProductExecution): NameVerdict {
  const now = outcomeIn(execution.output, matches);
  if (now === "absent") return { name, verdict: "claimed", reason: "not-in-output" };
  if (now === "failed") return { name, verdict: "claimed", reason: "failed" };
  if (now === "skipped") return { name, verdict: "claimed", reason: "skipped" };
  if (now === "seen") return { name, verdict: "claimed", reason: "no-outcome" };
  const before = outcomeIn(baselineOutput(execution), matches);
  if (before === "passed") return { name, verdict: "claimed", reason: "passes-before" };
  return { name, verdict: "verified", failsBefore: before === "failed", basis: "listed" };
}

/**
 * A name a dots-only run does not list: verified when the suite passed, the test files the run
 * covered define it, and the run's count is exactly the tests those files define, so every one
 * of them ran. A count from parametrized or generated tests cannot be checked, so it never verifies.
 */
function suiteVerdict(
  name: string,
  pass: SuitePass,
  execution: ProductExecution,
  sources: TestSources,
): NameVerdict {
  const covers = testFilesRun(execution.command, execution.output, sources.paths, pass.runner);
  const run = covers ? sources.within(covers) : sources;
  const definedIn = run.definedIn(name, pass.runner);
  if (!definedIn.length)
    return {
      name,
      verdict: "claimed",
      reason: sources.definedIn(name, pass.runner).length ? "not-covered" : "not-defined",
    };
  const defined = run.testCount(pass.runner);
  if (defined === undefined) return { name, verdict: "claimed", reason: "uncountable" };
  if (pass.ran !== defined)
    return {
      name,
      verdict: "claimed",
      reason: "count-mismatch",
      counts: { ran: pass.ran, defined },
    };
  // The old code ran the same suite: if it passed there too, the named test shows nothing new.
  if (suitePass(baselineOutput(execution)))
    return { name, verdict: "claimed", reason: "passes-before" };
  return { name, verdict: "verified", failsBefore: false, basis: "suite-passed", definedIn };
}

/** The tests an account names, each looked up in the run's output. */
function namedTests(
  note: string | undefined,
  execution: ProductExecution,
  sources: TestSources | undefined,
): NameVerdict[] {
  const identifiers = testNamesIn(note);
  if (!PER_TEST.test(execution.output)) {
    const pass = sources ? suitePass(execution.output) : undefined;
    return identifiers.map((name) =>
      sources && pass
        ? suiteVerdict(name, pass, execution, sources)
        : { name, verdict: "claimed", reason: "no-test-names" },
    );
  }
  const verdicts = identifiers.map((name) => verdictFor(name, nameMatcher(name), execution));
  // A title counts only where the output has it: prose that names no test is not a claim about one.
  for (const title of titleSegments(note)) {
    const matches = titleMatcher(title);
    if (outcomeIn(execution.output, matches) !== "absent")
      verdicts.push(verdictFor(title, matches, execution));
  }
  return verdicts;
}

type Claimed = Extract<NameVerdict, { verdict: "claimed" }>;

const REASONS: Record<
  Exclude<
    Claimed["reason"],
    "no-test-names" | "not-defined" | "not-covered" | "uncountable" | "count-mismatch"
  >,
  string
> = {
  "not-in-output": "not in its output",
  "no-outcome": "its output does not say whether it passed",
  skipped: "skipped, todo or expected to fail in its latest run",
  failed: "failed in its latest run",
  "passes-before": "also passes on the old code, so it does not show the change",
};

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function verifiedSummary(
  check: string,
  names: readonly NameVerdict[],
  run: SuitePass | undefined,
): string {
  const suite = names.flatMap((entry) =>
    entry.verdict === "verified" && entry.basis === "suite-passed" ? [entry] : [],
  );
  if (suite.length) {
    const files = [...new Set(suite.flatMap((entry) => entry.definedIn ?? []))];
    const ran = run ? ` (${run.text})` : "";
    return `verified at suite level: ${check} passed${ran} and ${suite.length === 1 ? "the named test is" : "the named tests are"} defined in ${files.join(", ")}; its output does not list tests one by one`;
  }
  const before = names.filter((entry) => entry.verdict === "verified" && entry.failsBefore);
  const old = before.length
    ? ` (${before.length === names.length ? "and failed" : `${before.length} failed`} on the old code)`
    : "";
  return `verified: ${names.length === 1 ? "the test" : "every named test"} passed in ${check}'s latest run${old}`;
}

function summarize(
  check: string,
  names: readonly NameVerdict[],
  run: SuitePass | undefined,
): Pick<AccountVerification, "status" | "summary"> {
  if (!names.length)
    return { status: "no-names", summary: `no test named; only that ${check} passed` };
  const claimed = names.flatMap((entry) => (entry.verdict === "claimed" ? [entry] : []));
  if (!claimed.length) {
    return { status: "verified", summary: verifiedSummary(check, names, run) };
  }
  const reasons = new Map<Claimed["reason"], Claimed[]>();
  for (const entry of claimed)
    reasons.set(entry.reason, [...(reasons.get(entry.reason) ?? []), entry]);
  const text = [...reasons.entries()].map(([reason, listed]) => claimText(check, reason, listed));
  return { status: "claimed", summary: `${NOT_CONFIRMED}${text.join("; ")}` };
}

/** Why the names `listed`, which share `reason`, are not confirmed: one clause of the summary. */
function claimText(check: string, reason: Claimed["reason"], listed: readonly Claimed[]): string {
  const names = listed.map((entry) => entry.name).join(", ");
  const verb = listed.length === 1 ? "is" : "are";
  const counts = listed[0]?.counts ?? { ran: 0, defined: 0 };
  switch (reason) {
    case "no-test-names":
      return `${check}'s output lists no test names (${listed.length} named)`;
    case "not-defined":
      return `${names} ${verb} not defined in the project's test files`;
    case "not-covered":
      return `${names} ${verb} defined only in test files ${check} did not run`;
    case "uncountable":
      return `${check}'s test files define parametrized or generated tests, which VISP cannot count`;
    case "count-mismatch":
      return `${check} ran ${plural(counts.ran, "test")} but the test files define ${counts.defined}`;
    default:
      return `${names}: ${REASONS[reason].replace("its", `${check}'s`)}`;
  }
}

interface AccountInput {
  readonly id: string;
  readonly status: string;
  readonly check?: string;
  readonly note?: string;
}

/**
 * Checks each "done" account's named tests against its check's latest run, when it passed, in
 * `executions` (oldest first). `sources` are the project's test files: with them, a name a
 * dots-only run does not list can still be verified at suite level. Accounts that are not done, or
 * whose check has no passing run, have no verification: the gaps already say so.
 */
export function verifyAccounts(
  accounts: readonly AccountInput[],
  executions: readonly ProductExecution[],
  sources?: TestSources,
): Map<string, AccountVerification> {
  const verified = new Map<string, AccountVerification>();
  for (const account of accounts) {
    if (account.status !== "done" || !account.check) continue;
    const check = account.check;
    const run = executions.findLast((entry) => entry.check === check);
    if (run?.status !== "passed") continue;
    const names = namedTests(account.note, run, sources);
    const suite = names.some(
      (entry) => entry.verdict === "verified" && entry.basis === "suite-passed",
    );
    verified.set(account.id, {
      requirement: account.id,
      check,
      names,
      ...summarize(check, names, suite ? suitePass(run.output) : undefined),
    });
  }
  return verified;
}

/** The project's test files, read only when a done account names a test to look up. */
export async function testSourcesFor(
  workspace: WorkspaceState,
  accounts: readonly AccountInput[],
): Promise<TestSources | undefined> {
  const named = accounts.some((entry) => entry.status === "done" && testNamesIn(entry.note).length);
  return named ? loadTestSources(workspace) : undefined;
}
