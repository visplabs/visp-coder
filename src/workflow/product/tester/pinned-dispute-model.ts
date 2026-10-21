import { existsSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";
import { z } from "zod";
import { launchesReviewer } from "../../../config/critic.js";
import { hashValue } from "../../../core/hash.js";
import type { WorkspaceState } from "../../state.js";
import { productFailureSignature } from "../failures.js";
import type { ProductExecution } from "../model.js";

/**
 * Disputes of pinned acceptance tests. The worker cannot edit the pinned suite, and a suite
 * can itself be wrong (an assertion about incidental key order, a case the request defines
 * differently). A worker may dispute a failing test with a reason quoting the request; the
 * independent reviewer rules. An upheld test is waived: VISP tells the suite to skip it
 * through `VISP_WAIVED_TESTS`, and a suite that cannot skip it is treated as passing when
 * every failing test it names is waived. This leaf module holds the record shape and the pure
 * helpers that the check runner, the tester and the reviewer share.
 */

/** The tester's record in a feature's directory; disputes live beside the pinned suite. */
export const TESTS_RECORD = "acceptance-tests.json";
/** JSON array of waived test names, given to every run of the pinned suite. */
export const WAIVED_TESTS_ENV = "VISP_WAIVED_TESTS";
/**
 * Most disputes that may await a ruling at once, and most tests one call may dispute. It matches
 * the tester's 30-test guidance, so one defect that turns a whole suite red (a broken helper) can
 * be disputed in one call and ruled on in one review: the reviewer launches only when every
 * failing test is disputed, and a lower cap left such suites with no review at all.
 */
export const MAX_OPEN_DISPUTES = 30;
export const MIN_REASON_LENGTH = 20;
/** A dispute is filed at most this often per test, and reviewed at most this often per filing. */
export const MAX_FILINGS_PER_TEST = 2;
export const MAX_REVIEWS_PER_FILING = 2;

const rulingRecord = z
  .object({
    ruling: z.enum(["upheld", "rejected"]),
    reasoning: z.string(),
    at: z.string(),
    /** Product source digest the reviewer ruled on. */
    subject: z.string(),
    model: z.string().optional(),
    /** The critic attempt that returned it; an upheld ruling is verified against it. */
    attempt: z.string(),
    /** The critic selection's task, which locates that attempt's state file. */
    task: z.string().optional(),
    evidence: z.string(),
  })
  .strict();
export type DisputeRulingRecord = z.infer<typeof rulingRecord>;

export const disputeSchema = z
  .object({
    /** The tester's name for the test, as declared in the record's `tests`. */
    test: z.string(),
    check: z.string(),
    reason: z.string(),
    filedAt: z.string(),
    /** Product source digest of the failing run described by `failure`. */
    subject: z.string(),
    /** Tail of that failing run. */
    failure: z.string(),
    status: z.enum(["open", "upheld", "rejected", "expired"]),
    /** Times the worker filed this test; a re-roll is capped. */
    filings: z.number().int().default(1),
    /** Independent reviews of this filing that left it without a ruling. */
    reviews: z.number().int().default(0),
    ruling: rulingRecord.optional(),
    /** Rulings of earlier filings, shown to the reviewer of a later one. */
    history: z.array(rulingRecord).default([]),
  })
  .strict();
export type PinnedDispute = z.infer<typeof disputeSchema>;

/** Lines that show an uncaught error or a stack trace rather than a reported test failure. */
const UNCAUGHT =
  /^\s*(?:Traceback \(most recent call last\)|Uncaught\b|Unhandled\b|[\w.$]*(?:Error|Exception)(?:\s*\[[^\]]*\])?:|at\s+\S|File\s+"[^"]+", line \d+)/;
/** Column-0 error headers always start an independent crash, never a FAIL continuation. */
const ERROR_HEADER =
  /^(?:Traceback \(most recent call last\):|Uncaught\b|Unhandled\b|[\w.$]*(?:Error|Exception)(?:\s*\[[^\]]*\])?:)/;
const RESULT_LINE = /^\s*(?:PASS:|FAIL:|NOT OBSERVED:|ENVIRONMENT ERROR:)/i;
/** Node ends every default uncaught-exception report with its version, even for `throw new Error()`. */
const NODE_CRASH_TRAILER = /^Node\.js v\d+\.\d+\.\d+\s*$/;
const FAILURE_DETAIL = /^\s+\S/;

/** Windows suites end lines with CRLF; a stray `\r` must not hide a `FAIL:` line. */
const OUTPUT_LINES = /\r?\n/;

/** unittest's default runner names methods, not declared tests: `FAIL: test_x (Mod.Cls.test_x)`. */
const RUNNER_LINE = /^\w+ \([\w.]+\)$/;

const squash = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The declared tests a run reports as failing: lines that start `FAIL:` followed by the exact
 * declared name. A `FAIL:` line naming anything else, or an uncaught error or traceback
 * outside a named failure record, counts as unattributed. Only indented details attach;
 * blank lines and plain diagnostic text preserve the record. Result lines and column-0
 * error headers end it, so independent crashes cannot be explained by a preceding FAIL.
 * A name that only appears in passing or verbose lines is not failing.
 */
export function failingTests(
  output: string,
  declared: readonly string[],
): { names: string[]; unattributed: number } {
  const names = new Set<string>();
  let unattributed = 0;
  let attached = false;
  for (const line of output.split(OUTPUT_LINES)) {
    const match = /^\s*FAIL:\s*(.*)$/i.exec(line);
    if (match) {
      const found = declaredName(match[1] ?? "", declared);
      attached = found !== undefined;
      if (found) names.add(found);
      else unattributed += 1;
      continue;
    }
    if (RESULT_LINE.test(line)) {
      attached = false;
      continue;
    }
    if (ERROR_HEADER.test(line) || NODE_CRASH_TRAILER.test(line)) attached = false;
    if (attached && FAILURE_DETAIL.test(line)) continue;
    // A crash outside a named failure record has no test to explain it.
    if (UNCAUGHT.test(line) || NODE_CRASH_TRAILER.test(line)) unattributed += 1;
  }
  return { names: [...names], unattributed };
}

/** The longest declared name a `FAIL:` line's text starts with (`name`, `name:` or `name `). */
function declaredName(text: string, declared: readonly string[]): string | undefined {
  const rest = squash(text);
  return declared
    .filter((name) => {
      const key = squash(name);
      return rest === key || rest.startsWith(`${key}:`) || rest.startsWith(`${key} `);
    })
    .sort((a, b) => b.length - a.length)[0];
}

/**
 * How a baseline's `FAIL:` lines relate to the declared tests: the declared names it reports
 * as failing, and the text of every `FAIL:` line that names none of them. Same line rules as
 * `failingTests`, without counting uncaught errors: a crash before any test ran has none.
 * A line in unittest's own runner format is neither: it names no declared test, and the
 * suite still owes a `FAIL:` line with a declared name.
 */
export function failLineStats(
  output: string,
  declared: readonly string[],
): { named: string[]; undeclared: string[] } {
  const named = new Set<string>();
  const undeclared: string[] = [];
  for (const line of output.split(OUTPUT_LINES)) {
    const match = /^\s*FAIL:\s*(.*)$/i.exec(line);
    if (!match) continue;
    const found = declaredName(match[1] ?? "", declared);
    const text = (match[1] ?? "").trim();
    if (found) named.add(found);
    else if (!RUNNER_LINE.test(text)) undeclared.push(text);
  }
  return { named: [...named], undeclared };
}

/**
 * A suite reports that its environment, not the product, stopped it (a browser that cannot
 * start) with a line `ENVIRONMENT ERROR: <message>` and no `FAIL:` line for it. Returns the
 * message of the first such line, uncut: redact it before showing or cutting it.
 */
export function environmentErrorLine(output: string): string | undefined {
  for (const line of output.split(OUTPUT_LINES)) {
    const match = /^\s*ENVIRONMENT ERROR:\s*(.*)$/.exec(line);
    if (match) return (match[1] ?? "").trim() || "no message";
  }
  return undefined;
}

/**
 * The output says the environment stopped the suite and nothing else: an `ENVIRONMENT ERROR:`
 * line, no failing test, no `FAIL:` line of any kind and no uncaught error or trace. A
 * product can print that line too, so on its own this proves nothing (see check-execution).
 */
export function environmentOnly(output: string, declared: readonly string[]): boolean {
  if (environmentErrorLine(output) === undefined) return false;
  const failing = failingTests(output, declared);
  return failing.names.length === 0 && failing.unattributed === 0;
}

/** A pinned run as the persistence rule reads it. */
export interface PinnedRun {
  readonly check: string;
  readonly status: ProductExecution["status"];
  readonly exitCode: number;
  readonly output: string;
  readonly subjectDigest: string;
}

/**
 * The suite failed and reported no declared test as failing: it crashed (an import error, a
 * missing script, a refused connection outside any test) rather than found a product fault.
 * Only a suite with declared tests can be judged so: a project-pinned suite has no declared
 * names, its failures cannot be told from a crash, and none of them is ever called one.
 */
export function suiteCrashed(
  run: Pick<PinnedRun, "status" | "output"> & {
    readonly pinnedFailures?: ProductExecution["pinnedFailures"];
  },
  declared: readonly string[],
): boolean {
  return (
    declared.length > 0 &&
    run.status === "failed" &&
    (run.pinnedFailures ?? failingTests(run.output, declared)).names.length === 0
  );
}

const ERROR_LINE = /^[\w.$]*(?:Error|Exception)(?:\s*\[[^\]]*\])?:/;
const CRASH_FRAME =
  /File "([^"]+)", line (\d+)|\(([^()\s]+):(\d+):\d+\)|\bat\s+([^()\s]+):(\d+):\d+\s*$/;

/** What a crashed run says went wrong: its last error or FAIL line, else its last line. */
export function crashLine(output: string): string | undefined {
  const lines = output
    .split(OUTPUT_LINES)
    .map((line) => line.trim())
    .filter(Boolean);
  const line = lines.findLast((entry) => ERROR_LINE.test(entry) || /^FAIL:/i.test(entry));
  const text = (line ?? lines.at(-1) ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 200) : undefined;
}

/** Where a crash happened: the last `File "x", line N` or `(path:N:M)` frame, as `file:line`. */
function crashFrame(output: string): string | undefined {
  let frame: string | undefined;
  for (const line of output.split(OUTPUT_LINES)) {
    const match = CRASH_FRAME.exec(line);
    if (match)
      frame = `${(match[1] ?? match[3] ?? match[5] ?? "").split(/[\\/]/).pop()}:${match[2] ?? match[4] ?? match[6]}`;
  }
  return frame;
}

/** The same crash again: its error line without numbers, and the frame it came from. */
export function crashSignature(run: PinnedRun): string {
  const line = crashLine(run.output);
  return line
    ? hashValue({ line: line.replace(/\d+/g, "#"), frame: crashFrame(run.output) })
    : productFailureSignature(run);
}

type PersistentKind = "crash" | "environment-failed" | "timed-out";

/** The run printed a `FAIL:` line or names a declared failing test: a failure, not a stop. */
function namesFailure(run: PinnedRun, declared: readonly string[]): boolean {
  return /^\s*FAIL:/im.test(run.output) || failingTests(run.output, declared).names.length > 0;
}

const MISSING_ERROR =
  /ERR_MODULE_NOT_FOUND|Cannot find module|\bENOENT\b|No such file or directory|FileNotFoundError/;

const NO_MODULE = /ModuleNotFoundError: No module named '([^']+)'/;
const NO_NAME = /ImportError: cannot import name '[^']+' from '([^']+)'/;

/** The Python module is a file or package of the project, at its root or under `src/`. */
function projectModule(root: string, module: string): boolean {
  const name = module.split(".")[0] ?? "";
  return (
    /^\w+$/.test(name) &&
    [`${name}.py`, name, join("src", `${name}.py`), join("src", name)].some((path) =>
      existsSync(join(root, path)),
    )
  );
}

/**
 * The crash's error asks the product for something it does not provide: a file missing inside
 * the project and outside `acceptance/` (`Cannot find module '/p/src/server.mjs'`,
 * `spawn ./start.sh ENOENT`), a Python module that cannot be imported at all (`No module named
 * 'app'`: the product should provide it), or a name missing from a module of the project
 * (`cannot import name 'x' from 'app'`, where app.py or app/ exists). That is the product's job,
 * not a fault of the suite. Bare names, dependencies, paths outside the project and a name
 * missing from a standard or installed module are not.
 */
export function crashNamesProductPath(output: string, root: string): boolean {
  for (const line of output.split(OUTPUT_LINES)) {
    if (NO_MODULE.test(line)) return true;
    const imported = NO_NAME.exec(line)?.[1];
    if (imported !== undefined && projectModule(root, imported)) return true;
    if (!MISSING_ERROR.test(line)) continue;
    const named = [...line.matchAll(/'([^']+)'|"([^"]+)"|\bspawn\s+(\S*[\\/]\S*)/g)]
      .map((match) => match[1] ?? match[2] ?? match[3] ?? "")
      .filter((path) => /[\\/]|\.[A-Za-z0-9]+$/.test(path));
    const project = named.find((path) => {
      const inside = isAbsolute(path) ? relative(root, path) : normalize(path);
      return (
        inside !== "" &&
        !inside.startsWith("..") &&
        !isAbsolute(inside) &&
        !inside.split(/[\\/]/).includes("node_modules") &&
        inside.split(/[\\/]/)[0] !== "acceptance"
      );
    });
    if (project) return true;
  }
  return false;
}

function persistentKind(
  run: PinnedRun,
  declared: readonly string[],
  root: string | undefined,
): PersistentKind | undefined {
  if (run.status === "environment-failed" || run.status === "timed-out")
    return namesFailure(run, declared) ? undefined : run.status;
  if (!suiteCrashed(run, declared)) return undefined;
  return root !== undefined && crashNamesProductPath(run.output, root) ? undefined : "crash";
}

/**
 * A pinned suite that keeps failing the same unattributed way while the product changes. `runs`
 * are the executions of ONE check, oldest first. Only crashes, environment failures and timeouts
 * qualify, and a crash only when it does not ask the product for a missing file (`root` set);
 * a run that names a failing test or prints a `FAIL:` line, and a pass, break the streak. It takes three
 * identical runs across at least two source states, so a worker that changes nothing never
 * gets here, and a real product fault (a different error once the product changes) resets it.
 */
export function persistentPinnedFailure(
  runs: readonly PinnedRun[],
  declared: readonly string[],
  root?: string,
): { count: number; status: string; line?: string } | undefined {
  const last = runs.at(-1);
  const kind = last && persistentKind(last, declared, root);
  if (!last || !kind) return undefined;
  const signature = (run: PinnedRun) =>
    kind === "crash" ? crashSignature(run) : productFailureSignature(run);
  const wanted = signature(last);
  const streak: PinnedRun[] = [];
  for (const run of runs.toReversed()) {
    if (persistentKind(run, declared, root) !== kind || signature(run) !== wanted) break;
    streak.push(run);
  }
  if (streak.length < 3 || new Set(streak.map((run) => run.subjectDigest)).size < 2)
    return undefined;
  const line = crashLine(last.output);
  return { count: streak.length, status: kind, ...(line ? { line } : {}) };
}

/** Missing results restrict waivers only when the suite reports a declared PASS. */
export function unreportedTests(
  output: string,
  declared: readonly string[],
  skipped: readonly string[] = [],
): string[] {
  const reported = new Set<string>();
  let hasPass = false;
  for (const line of output.split(OUTPUT_LINES)) {
    const match = /^\s*(PASS|FAIL|NOT OBSERVED):\s*(.*)$/i.exec(line);
    if (!match) continue;
    const name = declaredName(match[2] ?? "", declared);
    if (!name) continue;
    reported.add(name);
    if (match[1]?.toUpperCase() === "PASS") hasPass = true;
  }
  return hasPass ? declared.filter((name) => !reported.has(name) && !skipped.includes(name)) : [];
}

/** New receipts retain full-output completion; old receipts can only prove what they show. */
export function unreportedPinnedTests(
  output: string,
  declared: readonly string[],
  summary?: ProductExecution["pinnedFailures"],
): string[] {
  return summary?.unreported ?? unreportedTests(output, declared);
}

export function incompleteSuiteNote(names: readonly string[]): string {
  return `The pinned suite stopped before reporting these declared tests: ${names.map((name) => JSON.stringify(name)).join(", ")}. Look for the crash; an upheld dispute cannot waive it.`;
}

/** Every failing test of the run is attributed and in `covered`. */
export function allFailuresIn(
  output: string,
  declared: readonly string[],
  covered: readonly string[],
  summary?: ProductExecution["pinnedFailures"],
): boolean {
  // Older receipts lack complete attribution; a disclosed cutoff cannot prove full coverage.
  if (
    summary?.unreported === undefined &&
    /VISP: (?:\d+ more FAIL lines? (?:is|are) left out|earlier output omitted|output shortened)/.test(
      output,
    )
  )
    return false;
  const failing = summary ?? failingTests(output, declared);
  return (
    unreportedPinnedTests(output, declared, summary).length === 0 &&
    failing.unattributed === 0 &&
    failing.names.length > 0 &&
    failing.names.every((name) => covered.includes(name))
  );
}

const recordView = z
  .object({
    file: z.string().optional(),
    tests: z.array(z.object({ name: z.string() }).passthrough()).optional(),
    disputes: z.array(disputeSchema).optional(),
  })
  .passthrough();
const attemptView = z
  .object({
    attempts: z.array(
      z
        .object({
          id: z.string(),
          status: z.string(),
          evidenceDigest: z.string().optional(),
          execution: z.object({ provenance: z.string() }).passthrough().optional(),
          disputes: z.array(z.string()).optional(),
          disputeRulings: z
            .array(z.object({ test: z.string(), ruling: z.string() }).passthrough())
            .optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

/** Where a critic selection keeps its state; mirrors `criticSelection`. */
function criticStatePath(workspace: WorkspaceState, feature: string, task?: string): string {
  return join(
    workspace.paths.featureDir(feature),
    `critic/${hashValue({ root: workspace.paths.root, task }).slice(0, 24)}.json`,
  );
}

/**
 * An upheld ruling counts only when the critic state holds the review attempt it names: an
 * accepted review VISP itself launched (adapter-observed), that carried this dispute and
 * ruled it upheld on the same evidence. Editing the acceptance record alone waives nothing.
 */
async function verifiedUpheld(
  workspace: WorkspaceState,
  feature: string,
  dispute: PinnedDispute,
): Promise<boolean> {
  const ruling = dispute.ruling;
  if (dispute.status !== "upheld" || ruling?.ruling !== "upheld") return false;
  const text = await workspace.files.readTextIfExists(
    criticStatePath(workspace, feature, ruling.task),
  );
  if (!text.ok || !text.value) return false;
  try {
    const state = attemptView.parse(JSON.parse(text.value));
    const attempt = state.attempts.find((entry) => entry.id === ruling.attempt);
    return (
      attempt?.status === "reviewed" &&
      attempt.execution?.provenance === "adapter-observed" &&
      attempt.evidenceDigest === ruling.evidence &&
      attempt.disputes?.includes(dispute.test) === true &&
      attempt.disputeRulings?.some(
        (entry) => entry.test === dispute.test && entry.ruling === "upheld",
      ) === true
    );
  } catch {
    return false;
  }
}

export interface Waivers {
  /** Waived declared tests whose rulings verify against the critic state. */
  readonly names: string[];
  readonly declared: string[];
  /** Whether the suite reads `VISP_WAIVED_TESTS`, so it can skip a test itself. */
  readonly suiteSkips: boolean;
}

export async function pinnedWaivers(workspace: WorkspaceState, feature: string): Promise<Waivers> {
  const none: Waivers = { names: [], declared: [], suiteSkips: false };
  const text = await workspace.files.readTextIfExists(
    workspace.paths.featureFile(feature, TESTS_RECORD),
  );
  if (!text.ok || !text.value) return none;
  try {
    const record = recordView.parse(JSON.parse(text.value));
    const upheld = (record.disputes ?? []).filter((entry) => entry.status === "upheld");
    const names: string[] = [];
    for (const entry of upheld)
      if (await verifiedUpheld(workspace, feature, entry)) names.push(entry.test);
    const source = record.file
      ? await workspace.files.readTextIfExists(join(workspace.paths.root, record.file))
      : undefined;
    return {
      names,
      declared: (record.tests ?? []).map((entry) => entry.name),
      suiteSkips: source?.ok === true && (source.value ?? "").includes(WAIVED_TESTS_ENV),
    };
  } catch {
    return none;
  }
}

/** Environment for a run of the pinned suite: the waived tests it must skip. */
export async function waivedTestsEnv(
  workspace: WorkspaceState,
  feature: string,
): Promise<Record<string, string>> {
  const { names } = await pinnedWaivers(workspace, feature);
  return names.length ? { [WAIVED_TESTS_ENV]: JSON.stringify(names) } : {};
}

/**
 * A suite that cannot skip tests still fails on a waived one. When every failing test it
 * names is waived, the failure is the waived tests' and the check counts as passed.
 */
export function waivedFailure(output: string, waivers: Waivers): boolean {
  return (
    !waivers.suiteSkips &&
    waivers.names.length > 0 &&
    allFailuresIn(output, waivers.declared, waivers.names)
  );
}

/** Whether a VISP-launched reviewer exists to rule; only then can a dispute be decided. */
export function reviewerRules(workspace: WorkspaceState): boolean {
  return launchesReviewer(workspace.config.critic);
}

/**
 * One line for a reply that reports a failing pinned test as a blocking check. `reviewerCanRule`
 * is false once VISP's reviewer is out of budget or unavailable: nothing can be waived then.
 */
export function disputeHint(
  workspace: WorkspaceState,
  command: "done" | "accept",
  reviewerCanRule = true,
): string {
  if (reviewerRules(workspace) && !reviewerCanRule)
    return "A failing pinned test that contradicts the request: VISP's reviewer cannot rule on a dispute now (its review budget is spent or it is unavailable), so nothing can be waived. Keep the product as the request says, report the request sentence and the test that disagree in your final message, and run visp pr.";
  return reviewerRules(workspace)
    ? `A failing pinned test that contradicts the request: do not edit it or bend the product. Run visp ${command} --dispute "<test name>" --reason "<request sentence + why>". VISP itself launches the reviewer during that command (about 1-2 minutes), so you delegate nothing. Then run visp next until it rules; upheld tests are waived.`
    : "No independent reviewer runs here, so a pinned test cannot be waived. Satisfy it; if it contradicts the request, keep the product as the request says and tell the user which request sentence and test disagree.";
}
