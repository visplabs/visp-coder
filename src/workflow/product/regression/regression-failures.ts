import { stripVTControlCharacters } from "node:util";

/** One failing test as a runner reported it: an empty name stands for an unnamed failure. */
export interface FailureIdentity {
  readonly name: string;
  readonly message: string;
}

/** What one run of a selected command showed. */
export type RegressionRun =
  | { readonly kind: "passed" }
  | { readonly kind: "failed"; readonly failures: readonly FailureIdentity[] }
  /** It could not run as a test: no interpreter, a timeout, a setup or fixture failure. */
  | { readonly kind: "environment"; readonly reason: string };

export type RegressionStatus = "passed" | "regression" | "pre-existing" | "unchecked";

export interface RegressionTestVerdict {
  readonly name: string;
  readonly status: Exclude<RegressionStatus, "passed">;
  readonly message: string;
  /** The old code's message for the same test, when it differs. */
  readonly before?: string;
  readonly reason?: string;
}

export interface RegressionVerdict {
  readonly status: RegressionStatus;
  readonly tests: readonly RegressionTestVerdict[];
  /** Why the command itself could not be judged. */
  readonly reason?: string;
}

const MESSAGE_CHARS = 200;

/**
 * The failing tests in a runner's output, by name and normalized message: unittest, pytest,
 * node:test (spec and TAP), vitest, jest, go and VISP's pinned `FAIL: <name>: <reason>` lines.
 * Output with no named failure is one unnamed identity from its last error line.
 */
export function failureIdentities(output: string, roots: readonly string[]): FailureIdentity[] {
  const text = stripVTControlCharacters(output);
  const lines = text.split(/\r?\n/);
  const found = new Map<string, string>();
  for (const parse of PARSERS)
    for (const { name, message } of parse(lines))
      if (!found.has(name)) found.set(name, normalizeMessage(message, roots));
  if (found.size)
    return [...found]
      .map(([name, message]) => ({ name, message }))
      .sort((a, b) => a.name.localeCompare(b.name));
  return [{ name: "", message: normalizeMessage(unnamedMessage(lines), roots) }];
}

/**
 * The usage error a runner printed when it rejected its command line (argparse: unittest;
 * pytest), else undefined. Such a run executed no test, so it says nothing about the code.
 */
export function rejectedCommandLine(output: string): string | undefined {
  const text = stripVTControlCharacters(output);
  if (!/^(?:ERROR: )?usage: /m.test(text)) return undefined;
  return /^.+: error: .+$/m.exec(text)?.[0].trim();
}

type Parser = (lines: readonly string[]) => FailureIdentity[];

const PARSERS: readonly Parser[] = [unittest, pytest, nodeSpec, nodeTap, pinned, vitest, jest, go];

function unittest(lines: readonly string[]): FailureIdentity[] {
  const found: FailureIdentity[] = [];
  for (const [index, line] of lines.entries()) {
    const match = /^(?:FAIL|ERROR): (\S+) \(([\w.]+)\)\s*$/.exec(line);
    if (!match) continue;
    const [, test = "", owner = ""] = match;
    const name = owner.endsWith(`.${test}`) ? owner : `${owner}.${test}`;
    found.push({ name, message: unittestMessage(lines, index + 1) });
  }
  return found;
}

/** The exception line that ends the traceback: the first unindented line after it starts. */
function unittestMessage(lines: readonly string[], from: number): string {
  let traceback = false;
  for (const line of lines.slice(from)) {
    if (/^={10,}/.test(line)) break;
    if (line.startsWith("Traceback")) traceback = true;
    else if (traceback && line && !/^\s/.test(line)) return line;
  }
  return "";
}

function pytest(lines: readonly string[]): FailureIdentity[] {
  return lines.flatMap((line) => {
    const match = /^(?:FAILED|ERROR) (\S+::\S+)(?: - (.*))?$/.exec(line);
    return match ? [{ name: match[1] ?? "", message: match[2] ?? "" }] : [];
  });
}

/** node:test's spec reporter repeats each failing test, not its suites, under "failing tests". */
function nodeSpec(lines: readonly string[]): FailureIdentity[] {
  const start = lines.findIndex((line) => /^✖ failing tests:\s*$/.test(line));
  if (start < 0) return [];
  const found: FailureIdentity[] = [];
  for (let index = start + 1; index < lines.length; index++) {
    const match = /^✖ (.+?) \([\d.]+m?s\)\s*$/.exec(lines[index] ?? "");
    if (!match) continue;
    const error = lines.slice(index + 1);
    const end = error.findIndex((line) => /^\s*at |^✖ |^test at /.test(line));
    found.push({ name: match[1] ?? "", message: joined(end < 0 ? error : error.slice(0, end)) });
  }
  return found;
}

/** TAP `not ok` entries, except suites that failed only because a subtest did. */
function nodeTap(lines: readonly string[]): FailureIdentity[] {
  if (!lines.some((line) => /^TAP version \d+/.test(line))) return [];
  const found: FailureIdentity[] = [];
  for (const [index, line] of lines.entries()) {
    const match = /^(\s*)not ok \d+ - (.+?)(?:\s+#.*)?$/.exec(line);
    if (!match) continue;
    const block = tapBlock(lines, index + 1, (match[1] ?? "").length);
    if (block.some((entry) => /failureType: '?subtestsFailed/.test(entry))) continue;
    found.push({ name: match[2] ?? "", message: tapError(block) });
  }
  return found;
}

function tapBlock(lines: readonly string[], from: number, indent: number): string[] {
  if (!/^\s*---\s*$/.test(lines[from] ?? "")) return [];
  const block: string[] = [];
  for (const line of lines.slice(from + 1)) {
    if (/^\s*\.\.\.\s*$/.test(line) && line.search(/\S/) <= indent + 2) break;
    block.push(line);
  }
  return block;
}

function tapError(block: readonly string[]): string {
  const index = block.findIndex((line) => /^\s*error:/.test(line));
  if (index < 0) return "";
  const line = block[index] ?? "";
  const value = line.replace(/^\s*error:\s*/, "");
  if (value && !value.startsWith("|")) return value.replace(/^['"]|['"]$/g, "");
  // A block scalar: the lines indented deeper than its key.
  const indent = line.search(/\S/);
  const rest = block.slice(index + 1);
  const end = rest.findIndex((entry) => entry.trim() !== "" && entry.search(/\S/) <= indent);
  return joined(end < 0 ? rest : rest.slice(0, end));
}

/** The first lines of an error message, on one line: "Expected …: 'two' !== 'one'". */
function joined(lines: readonly string[]): string {
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" ");
}

function pinned(lines: readonly string[]): FailureIdentity[] {
  return lines.flatMap((line) => {
    const match = /^FAIL: (.+?): (.*)$/.exec(line);
    return match ? [{ name: match[1] ?? "", message: match[2] ?? "" }] : [];
  });
}

function vitest(lines: readonly string[]): FailureIdentity[] {
  return lines.flatMap((line) => {
    const match = /^\s*FAIL\s+(\S+ > .+?)\s*$/.exec(line);
    return match ? [{ name: match[1] ?? "", message: "" }] : [];
  });
}

function jest(lines: readonly string[]): FailureIdentity[] {
  return lines.flatMap((line) => {
    const match = /^\s+● (.+?)\s*$/.exec(line);
    return match && match[1] !== "Test suite failed to run"
      ? [{ name: match[1] ?? "", message: "" }]
      : [];
  });
}

function go(lines: readonly string[]): FailureIdentity[] {
  return lines.flatMap((line) => {
    const match = /^\s*--- FAIL: (\S+)/.exec(line);
    return match ? [{ name: match[1] ?? "", message: "" }] : [];
  });
}

function unnamedMessage(lines: readonly string[]): string {
  const meaningful = lines.map((line) => line.trim()).filter(Boolean);
  return (
    meaningful.findLast((line) => /error|exception|fail|cannot|not found|denied/i.test(line)) ??
    meaningful.at(-1) ??
    ""
  );
}

/** Text that differs between runs of the same failure: roots, addresses and timings. */
function normalizeMessage(message: string, roots: readonly string[]): string {
  let text = message;
  for (const root of [...roots].sort((a, b) => b.length - a.length))
    if (root) text = text.replaceAll(root, "<root>");
  return text
    .replace(/0x[0-9a-f]+/gi, "<hex>")
    .replace(/\b\d+(?:\.\d+)?\s?m?s\b/g, "<time>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MESSAGE_CHARS);
}

/**
 * How one selected command's failures compare: on a rerun of the new code (a difference is
 * flaky) and on the old code. A failure is a regression only when the old code ran and did
 * not fail that way; anything that could not be compared is unchecked, never passed.
 */
export function classifyRegression(runs: {
  readonly now: RegressionRun;
  readonly rerun?: RegressionRun;
  readonly before?: RegressionRun;
  /** Why no rerun or comparison ran (flip check off, no baseline, budget spent). */
  readonly skipped?: string;
}): RegressionVerdict {
  const { now, rerun, before, skipped } = runs;
  if (now.kind === "passed") return { status: "passed", tests: [] };
  if (now.kind === "environment") return { status: "unchecked", tests: [], reason: now.reason };
  const unchecked = (failure: FailureIdentity, reason: string): RegressionTestVerdict => ({
    name: failure.name,
    status: "unchecked",
    message: failure.message,
    reason,
  });
  const tests = now.failures.map((failure) => {
    if (skipped || !rerun) return unchecked(failure, skipped ?? "not compared");
    const flaky = flakyReason(failure, rerun);
    if (flaky) return unchecked(failure, flaky);
    if (!before) return unchecked(failure, "not compared");
    return compared(failure, before, unchecked);
  });
  return { status: overall(tests), tests };
}

function flakyReason(failure: FailureIdentity, rerun: RegressionRun): string | undefined {
  if (rerun.kind === "passed") return "flaky: passed on a rerun";
  if (rerun.kind === "environment") return `flaky: the rerun could not run (${rerun.reason})`;
  return rerun.failures.some(
    (entry) => entry.name === failure.name && entry.message === failure.message,
  )
    ? undefined
    : failure.name && rerun.failures.some((entry) => entry.name === failure.name)
      ? "flaky: failed differently on a rerun"
      : "flaky: passed on a rerun";
}

function compared(
  failure: FailureIdentity,
  before: RegressionRun,
  unchecked: (failure: FailureIdentity, reason: string) => RegressionTestVerdict,
): RegressionTestVerdict {
  if (before.kind === "passed")
    return { name: failure.name, status: "regression", message: failure.message };
  if (before.kind === "environment") return unchecked(failure, `old code: ${before.reason}`);
  const named = before.failures.some((entry) => entry.name !== "");
  if (!failure.name) {
    const same = before.failures.some((entry) => !entry.name && entry.message === failure.message);
    return same
      ? { name: "", status: "pre-existing", message: failure.message }
      : unchecked(failure, "the old code failed differently and names no test");
  }
  const earlier = before.failures.find((entry) => entry.name === failure.name);
  if (earlier)
    return {
      name: failure.name,
      status: "pre-existing",
      message: failure.message,
      ...(earlier.message === failure.message ? {} : { before: earlier.message }),
    };
  return named
    ? { name: failure.name, status: "regression", message: failure.message }
    : unchecked(failure, "the old code failed without naming its failing tests");
}

function overall(tests: readonly RegressionTestVerdict[]): RegressionStatus {
  for (const status of ["regression", "unchecked", "pre-existing"] as const)
    if (tests.some((test) => test.status === status)) return status;
  return "passed";
}
