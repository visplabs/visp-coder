import type { WorkspaceState } from "../state.js";
import type { ProductExecution } from "./model.js";
import { loadTestSources, type TestSources } from "./test-sources.js";

/**
 * The worker's account of a listed requirement names the check that shows it and, usually, the
 * tests ("R002=C001 test_bundle_all_or_nothing"). Whether the check passed is judged elsewhere;
 * this reads the names against what the check printed. A name counts as verified when the cited
 * check's latest passing run lists it as passed and, when the run on the old code lists it too,
 * when it failed there. A runner that prints only dots and a passing summary lists no names: then
 * a name counts as verified at suite level, when the summary is a clean pass that covers at least
 * the tests the project's test files define and those files define the name. Everything else is
 * not confirmed: VISP says so, and never blocks on it.
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
        | "count-mismatch"
        | "not-in-output"
        | "no-outcome"
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

/** go test's package line (`ok  \tpkg\t0.004s`): it names no test. */
const GO_PACKAGE = String.raw`\S+\s+(?:[\d.]+s|\(cached\))\s*$`;
const GO_PACKAGE_LINE = new RegExp(`^ok\\s+${GO_PACKAGE}`, "m");

const FAILED = /\b(?:FAIL(?:ED|URE)?|ERROR)\b|\bnot ok\b|[✖✕✗×]/;
const PASSED = /\.\.\. ok\b|\bPASS(?:ED)?\b|^\s*ok\s+\S|[✔✓✅]|\bok\b\s*(?:\(|$)/;
/** Lines that report a test one by one: a runner printing only dots has none. */
const PER_TEST = new RegExp(
  String.raw`\.\.\. (?:ok|FAIL|ERROR|skipped)|\b(?:PASSED|FAILED|ERROR)\b|^\s*(?:PASS|FAIL)\s|[✔✓✖✕✅]|^\s*(?:not )?ok\s+(?!${GO_PACKAGE})\S|--- (?:PASS|FAIL)`,
  "m",
);

type Matcher = (line: string) => boolean;
type Outcome = "passed" | "failed" | "seen" | "absent";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A name stands alone in a line: not part of a longer identifier. */
function nameMatcher(name: string): Matcher {
  const mention = new RegExp(`(?<![\\w])${escapeRegExp(name)}(?![\\w])`);
  return (line) => mention.test(line);
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

/** What a run's output says about one test: the lines that mention it, passed or failed. */
function outcomeIn(output: string, matches: Matcher): Outcome {
  const lines = output.split("\n").filter(matches);
  if (!lines.length) return "absent";
  if (lines.some((line) => FAILED.test(line))) return "failed";
  return lines.some((line) => PASSED.test(line)) ? "passed" : "seen";
}

/** The old-code runs' output of an execution, joined; empty when no comparison ran. */
function baselineOutput(execution: ProductExecution): string {
  return (execution.flip?.commands ?? []).map((command) => command.output ?? "").join("\n");
}

/** A clean passing summary of a whole suite: what it says, and how many tests it ran when it says. */
interface SuitePass {
  readonly text: string;
  readonly ran?: number;
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
  return passed && !rest.length ? { text: `${passed} passed`, ran: Number(passed) } : undefined;
}

function equalCounts(match: RegExpExecArray | null): SuitePass | undefined {
  const [, first, second, all] = match ?? [];
  const ran = Number(all ?? first);
  const total = Number(all ?? second);
  return match && ran === total && ran > 0 ? { text: `${ran} passed`, ran } : undefined;
}

/**
 * The summary line of a run in which every test passed and none was skipped, for the runners VISP
 * knows: unittest, pytest, jest, mocha, node:test and TAP, go test, and "N/N passed" printers.
 * Anything else, and any failure, skip or todo, is not a clean pass.
 */
function suitePass(output: string): SuitePass | undefined {
  if (SUITE_FAILURE.test(output)) return undefined;
  const ran = UNITTEST_RAN.exec(output)?.[1];
  if (ran)
    return UNITTEST_OK.test(output)
      ? { text: `Ran ${ran} tests, OK`, ran: Number(ran) }
      : undefined;
  const pytest = pytestPass(output);
  if (pytest) return pytest;
  const jest = JEST_SUMMARY.exec(output);
  if (jest) return equalCounts(jest);
  const mocha = MOCHA_PASSING.exec(output)?.[1];
  if (mocha)
    return MOCHA_NOT_PASSING.test(output)
      ? undefined
      : { text: `${mocha} passing`, ran: Number(mocha) };
  const node = NODE_PASS.exec(output)?.[1];
  if (node)
    return NODE_NOT_PASS.test(output) ? undefined : { text: `${node} passed`, ran: Number(node) };
  const all = equalCounts(ALL_PASSED.exec(output));
  if (all) return all;
  return GO_PACKAGE_LINE.test(output) ? { text: "go test ok" } : undefined;
}

function verdictFor(name: string, matches: Matcher, execution: ProductExecution): NameVerdict {
  const now = outcomeIn(execution.output, matches);
  if (now === "absent") return { name, verdict: "claimed", reason: "not-in-output" };
  if (now === "failed") return { name, verdict: "claimed", reason: "failed" };
  if (now === "seen") return { name, verdict: "claimed", reason: "no-outcome" };
  const before = outcomeIn(baselineOutput(execution), matches);
  if (before === "passed") return { name, verdict: "claimed", reason: "passes-before" };
  return { name, verdict: "verified", failsBefore: before === "failed", basis: "listed" };
}

/** A name a dots-only run does not list: verified when the suite passed and the test files define it. */
function suiteVerdict(
  name: string,
  pass: SuitePass,
  execution: ProductExecution,
  sources: TestSources,
): NameVerdict {
  const definedIn = sources.definedIn(name);
  if (!definedIn.length) return { name, verdict: "claimed", reason: "not-defined" };
  const defined = sources.definitionCount;
  if (pass.ran !== undefined && pass.ran < defined)
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

const REASONS: Record<
  Exclude<
    Extract<NameVerdict, { verdict: "claimed" }>["reason"],
    "no-test-names" | "not-defined" | "count-mismatch"
  >,
  string
> = {
  "not-in-output": "not in its output",
  "no-outcome": "its output does not say whether it passed",
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
  const reasons = new Map<string, NameVerdict[]>();
  for (const entry of claimed) {
    const list = reasons.get(entry.reason) ?? [];
    list.push(entry);
    reasons.set(entry.reason, list);
  }
  const text = [...reasons.entries()].map(([reason, listed]) => {
    const first = listed[0];
    const nameList = listed.map((entry) => entry.name).join(", ");
    if (reason === "no-test-names")
      return `${check}'s output lists no test names (${listed.length} named)`;
    if (reason === "not-defined")
      return `${nameList} ${listed.length === 1 ? "is" : "are"} not defined in the project's test files`;
    if (reason === "count-mismatch" && first?.verdict === "claimed" && first.counts)
      return `${check} ran ${plural(first.counts.ran, "test")} but the test files define ${first.counts.defined}`;
    const why = REASONS[reason as keyof typeof REASONS].replace("its", `${check}'s`);
    return `${nameList}: ${why}`;
  });
  return { status: "claimed", summary: `${NOT_CONFIRMED}${text.join("; ")}` };
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
