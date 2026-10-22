import type { ProductExecution } from "./model.js";

/**
 * The worker's account of a listed requirement names the check that shows it and, usually, the
 * tests ("R002=C001 test_bundle_all_or_nothing"). Whether the check passed is judged elsewhere;
 * this reads the names against what the check printed. A name counts as verified only when the
 * cited check's latest passing run lists it as passed and, when the run on the old code lists it
 * too, when it failed there. Everything else is a claim: VISP says so, and never blocks on it.
 */

export type NameVerdict =
  | { readonly name: string; readonly verdict: "verified"; readonly failsBefore: boolean }
  | {
      readonly name: string;
      readonly verdict: "claimed";
      readonly reason:
        | "no-test-names"
        | "not-in-output"
        | "no-outcome"
        | "failed"
        | "passes-before";
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

const FAILED = /\b(?:FAIL(?:ED|URE)?|ERROR)\b|\bnot ok\b|[✖✕✗×]/;
const PASSED = /\.\.\. ok\b|\bPASS(?:ED)?\b|^\s*ok \d+|[✔✓✅]|\bok\b\s*(?:\(|$)/;
/** Lines that report a test one by one: a runner printing only dots has none. */
const PER_TEST =
  /\.\.\. (?:ok|FAIL|ERROR|skipped)|\b(?:PASSED|FAILED|ERROR)\b|^\s*(?:PASS|FAIL)\s|[✔✓✖✕✅]|^\s*(?:not )?ok \d+|--- (?:PASS|FAIL)/m;

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

function verdictFor(name: string, matches: Matcher, execution: ProductExecution): NameVerdict {
  const now = outcomeIn(execution.output, matches);
  if (now === "absent") return { name, verdict: "claimed", reason: "not-in-output" };
  if (now === "failed") return { name, verdict: "claimed", reason: "failed" };
  if (now === "seen") return { name, verdict: "claimed", reason: "no-outcome" };
  const before = outcomeIn(baselineOutput(execution), matches);
  if (before === "passed") return { name, verdict: "claimed", reason: "passes-before" };
  return { name, verdict: "verified", failsBefore: before === "failed" };
}

/** The tests an account names, each looked up in the run's output. */
function namedTests(note: string | undefined, execution: ProductExecution): NameVerdict[] {
  const identifiers = testNamesIn(note);
  if (!PER_TEST.test(execution.output))
    return identifiers.map((name) => ({ name, verdict: "claimed", reason: "no-test-names" }));
  const verdicts = identifiers.map((name) => verdictFor(name, nameMatcher(name), execution));
  // A title counts only where the output has it: prose that names no test is not a claim about one.
  for (const title of titleSegments(note)) {
    const matches = titleMatcher(title);
    if (outcomeIn(execution.output, matches) !== "absent")
      verdicts.push(verdictFor(title, matches, execution));
  }
  return verdicts;
}

const REASONS: Record<Extract<NameVerdict, { verdict: "claimed" }>["reason"], string> = {
  "no-test-names": "its output lists no test names",
  "not-in-output": "not in its output",
  "no-outcome": "its output does not say whether it passed",
  failed: "failed in its latest run",
  "passes-before": "also passes on the old code, so it does not show the change",
};

function summarize(
  check: string,
  names: readonly NameVerdict[],
): Pick<AccountVerification, "status" | "summary"> {
  if (!names.length)
    return { status: "no-names", summary: `no test named; only that ${check} passed` };
  const claimed = names.flatMap((entry) => (entry.verdict === "claimed" ? [entry] : []));
  if (!claimed.length) {
    const before = names.filter((entry) => entry.verdict === "verified" && entry.failsBefore);
    const old = before.length
      ? ` (${before.length === names.length ? "and failed" : `${before.length} failed`} on the old code)`
      : "";
    return {
      status: "verified",
      summary: `verified: ${names.length === 1 ? "the test" : "every named test"} passed in ${check}'s latest run${old}`,
    };
  }
  const reasons = new Map<string, string[]>();
  for (const entry of claimed) {
    const list = reasons.get(entry.reason) ?? [];
    list.push(entry.name);
    reasons.set(entry.reason, list);
  }
  const text = [...reasons.entries()].map(([reason, listed]) => {
    if (reason === "no-test-names")
      return `${check}'s output lists no test names (${listed.length} named)`;
    const why = REASONS[reason as keyof typeof REASONS].replace("its", `${check}'s`);
    return `${listed.join(", ")}: ${why}`;
  });
  return { status: "claimed", summary: `claimed, not verified: ${text.join("; ")}` };
}

interface AccountInput {
  readonly id: string;
  readonly status: string;
  readonly check?: string;
  readonly note?: string;
}

/**
 * Checks each "done" account's named tests against its check's latest run, when it passed, in
 * `executions` (oldest first). Accounts that are not done, or whose check has no passing run, have
 * no verification: the gaps already say so.
 */
export function verifyAccounts(
  accounts: readonly AccountInput[],
  executions: readonly ProductExecution[],
): Map<string, AccountVerification> {
  const verified = new Map<string, AccountVerification>();
  for (const account of accounts) {
    if (account.status !== "done" || !account.check) continue;
    const check = account.check;
    const run = executions.findLast((entry) => entry.check === check);
    if (run?.status !== "passed") continue;
    const names = namedTests(account.note, run);
    verified.set(account.id, { requirement: account.id, check, names, ...summarize(check, names) });
  }
  return verified;
}
