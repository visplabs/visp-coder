import { join } from "node:path";
import { vispError } from "../../../core/errors.js";
import { err, ok, type Result } from "../../../core/result.js";
import { cliCommand } from "../../next-action.js";
import type { WorkspaceState } from "../../state.js";
import type { ReviewerCapacity } from "../critic/critic-capacity.js";
import type { ProductExecution } from "../model.js";
import type { DisputeRuling } from "../review/independent-review.js";
import { readProductRecord } from "../store.js";
import type { IndependentTestsRecord } from "./independent-tests-model.js";
import { readTestsRecord, saveTestsRecord } from "./independent-tests-record.js";
import {
  allFailuresIn,
  crashLine,
  type DisputeRulingRecord,
  disputeHint,
  failingTests,
  incompleteSuiteNote,
  MAX_FILINGS_PER_TEST,
  MAX_OPEN_DISPUTES,
  MAX_REVIEWS_PER_FILING,
  MIN_REASON_LENGTH,
  type PinnedDispute,
  type PinnedRun,
  persistentPinnedFailure,
  pinnedWaivers,
  reviewerRules,
  suiteCrashed,
  unreportedPinnedTests,
  WAIVED_TESTS_ENV,
} from "./pinned-dispute-model.js";

/** A failing run of the pinned suite as a blocking check, as `done` or `accept` observed it. */
export interface FailingPinned {
  readonly check: string;
  readonly output: string;
  readonly pinnedFailures?: ProductExecution["pinnedFailures"];
}
export interface DisputeInput {
  readonly tests: readonly string[];
  readonly reason: string;
}
export interface DisputeOutcome {
  readonly test: string;
  readonly status: "filed" | "refused";
  readonly detail: string;
}
/** What a reply tells the worker about pinned tests and their disputes. */
export interface PinnedTestsReport {
  readonly filed?: readonly DisputeOutcome[];
  readonly disputes?: readonly { test: string; status: string; note: string }[];
  readonly hint?: string;
}
/** What the reviewer receives for one open dispute. */
export interface PacketDispute {
  readonly test: string;
  readonly requestQuote: string;
  readonly workerReason: string;
  readonly failureOutput: string;
  readonly suiteFile: string;
  readonly testSource: string;
  /** Earlier rulings on this test, so a re-filed dispute is judged with them in view. */
  readonly priorRulings?: readonly { ruling: string; reasoning: string; subject: string }[];
}

const FAILURE_BOUND = 1200;
const SOURCE_BEFORE = 500;
const SOURCE_AFTER = 1300;

/** `--dispute` needs a reason; validated before any check runs. */
export function disputeInput(options: {
  readonly dispute?: readonly string[];
  readonly disputeReason?: string;
}): Result<DisputeInput | undefined> {
  const tests = (options.dispute ?? []).map((name) => name.trim()).filter(Boolean);
  const reason = options.disputeReason?.trim() ?? "";
  if (!tests.length)
    return reason
      ? err(vispError("ARTIFACT_INVALID", "--reason belongs to --dispute; name the failing test"))
      : ok(undefined);
  if (reason.length < MIN_REASON_LENGTH)
    return err(
      vispError(
        "ARTIFACT_INVALID",
        `A dispute needs a reason of at least ${MIN_REASON_LENGTH} characters: quote the request sentence the test contradicts and say why`,
        { recovery: 'visp done --dispute "<test name>" --reason "<request quote + why>"' },
      ),
    );
  return ok({ tests, reason });
}

/** The pinned runs that failed as blocking checks in this call. */
export function failingPinned(
  executions: readonly {
    check: string;
    status: string;
    output: string;
    pinnedFailures?: ProductExecution["pinnedFailures"];
  }[],
): FailingPinned[] {
  return executions
    .filter((entry) => entry.check.startsWith("PINNED_") && entry.status === "failed")
    .map(({ check, output, pinnedFailures }) => ({ check, output, pinnedFailures }));
}

/** Whether the call ran the pinned suite as a blocking check, passing or not. */
export function ranPinned(executions: readonly { check: string }[]): boolean {
  return executions.some((entry) => entry.check.startsWith("PINNED_"));
}

export interface DisputeState {
  readonly declared: string[];
  readonly all: PinnedDispute[];
  /** Open and still reviewable: these do not stop the reviewer from launching. */
  readonly pending: PinnedDispute[];
  /** Open after the reviewer failed to rule twice: handed to the human reviewer. */
  readonly handedOff: PinnedDispute[];
}

export async function disputeState(
  workspace: WorkspaceState,
  feature: string,
): Promise<DisputeState> {
  const loaded = await readTestsRecord(workspace, feature);
  const record = loaded.ok ? loaded.value : undefined;
  const all = record?.disputes ?? [];
  const open = all.filter((entry) => entry.status === "open");
  return {
    declared: (record?.tests ?? []).map((entry) => entry.name),
    all,
    pending: open.filter((entry) => entry.reviews < MAX_REVIEWS_PER_FILING),
    handedOff: open.filter((entry) => entry.reviews >= MAX_REVIEWS_PER_FILING),
  };
}

/**
 * A failed pinned execution does not stop the reviewer only when every test it reports as
 * failing has a dispute awaiting a ruling; any other failing test still blocks.
 */
export function disputedFailure(
  execution: {
    check: string;
    status: string;
    output: string;
    pinnedFailures?: ProductExecution["pinnedFailures"];
  },
  state: Pick<DisputeState, "declared" | "pending">,
): boolean {
  return (
    execution.check.startsWith("PINNED_") &&
    execution.status === "failed" &&
    allFailuresIn(
      execution.output,
      state.declared,
      state.pending.map((entry) => entry.test),
      execution.pinnedFailures,
    )
  );
}

/** True when the reviewer already ruled on this exact source and nothing awaits a ruling. */
export async function rulingCurrent(
  workspace: WorkspaceState,
  feature: string,
  subject: string,
): Promise<boolean> {
  const { all } = await disputeState(workspace, feature);
  return (
    all.some((entry) => entry.ruling?.subject === subject) &&
    !all.some((entry) => entry.status === "open")
  );
}

/**
 * Records disputes of tests that failed in this very blocking run. Each is refused unless a
 * reviewer can rule, the test is a declared one on a `FAIL:` line of the run, the reason is
 * given, and the test was neither rejected on this exact source nor disputed twice already.
 * The reviewer, never the worker, rules.
 */
export async function fileDisputes(
  workspace: WorkspaceState,
  feature: string,
  input: DisputeInput,
  failing: readonly FailingPinned[],
  subject: string,
  capacity: ReviewerCapacity = { available: true },
): Promise<Result<DisputeOutcome[]>> {
  const loaded = await readTestsRecord(workspace, feature);
  if (!loaded.ok) return loaded;
  const record = loaded.value;
  if (record?.status !== "pinned" || !record.tests?.length)
    return err(
      vispError("STAGE_BLOCKED", "This feature has no pinned acceptance tests to dispute"),
    );
  const available = await reviewerAvailable(workspace, feature, capacity);
  if (available) return err(vispError("STAGE_BLOCKED", available));
  const declared = record.tests.map((entry) => entry.name);
  const verified = (await pinnedWaivers(workspace, feature)).names;
  const outcomes: DisputeOutcome[] = [];
  let disputes = [...(record.disputes ?? [])];
  for (const requested of input.tests) {
    const verdict = disputable(record, disputes, verified, requested, failing, declared, subject);
    if ("refusal" in verdict) {
      outcomes.push({ test: requested, status: "refused", detail: verdict.refusal });
      continue;
    }
    const prior = disputes.find((entry) => entry.test === verdict.name);
    disputes = [
      ...disputes.filter((entry) => entry.test !== verdict.name),
      filedDispute(prior, verdict, input.reason, failing, subject),
    ];
    outcomes.push({
      test: verdict.name,
      status: "filed",
      detail: "Dispute filed; the pinned test stays required until the independent reviewer rules.",
    });
  }
  if (outcomes.some((entry) => entry.status === "filed")) {
    const saved = await saveTestsRecord(workspace, feature, { ...record, disputes }, record);
    if (!saved.ok) return saved;
  }
  return ok(outcomes);
}

/** Nothing can be waived unless VISP itself launches an independent reviewer for this feature. */
async function reviewerAvailable(
  workspace: WorkspaceState,
  feature: string,
  capacity: ReviewerCapacity,
): Promise<string | undefined> {
  const product = await readProductRecord(workspace, { feature });
  if (!reviewerRules(workspace) || !product.ok || product.value.state.criticEnabled === false)
    return "No independent reviewer runs for this feature, so a dispute cannot be ruled and nothing can be waived. Satisfy the test, or tell the user which request sentence and test disagree";
  if (!capacity.available)
    return "No independent reviewer can rule on it: the review budget is spent or the reviewer is unavailable, so nothing can be waived. Satisfy the test, or tell the user which request sentence and test disagree";
  return undefined;
}

function filedDispute(
  prior: PinnedDispute | undefined,
  verdict: { name: string; check: string },
  reason: string,
  failing: readonly FailingPinned[],
  subject: string,
): PinnedDispute {
  const refile = prior !== undefined && prior.status !== "open";
  return {
    test: verdict.name,
    check: verdict.check,
    reason: reason.slice(0, 1500),
    filedAt: new Date().toISOString(),
    subject,
    failure: boundedFailure(failing, verdict.check),
    status: "open",
    filings: (prior?.filings ?? 0) + (prior && !refile ? 0 : 1),
    reviews: prior?.status === "open" ? prior.reviews : 0,
    ...(prior?.status === "open" && prior.ruling ? { ruling: prior.ruling } : {}),
    history: [
      ...(prior?.history ?? []),
      ...(prior?.status === "rejected" && prior.ruling ? [prior.ruling] : []),
    ],
  };
}

/** A declared test on a `FAIL:` line of a failing run and not already ruled on: else the refusal. */
function disputable(
  record: IndependentTestsRecord,
  disputes: readonly PinnedDispute[],
  verified: readonly string[],
  requested: string,
  failing: readonly FailingPinned[],
  declared: readonly string[],
  subject: string,
): { name: string; check: string } | { refusal: string } {
  const name = declaredName(declared, requested);
  if (name === undefined) return { refusal: unknownTest(record, requested) };
  const check = failing.find((entry) => failureNames(entry, declared).includes(name))?.check;
  if (check === undefined) return { refusal: notFailing(requested, name, failing, declared) };
  const refusal = priorDispute(disputes, verified, name, subject);
  return refusal ? { refusal } : { name, check };
}

/** Complete saved attribution takes precedence over the diagnostic output excerpt. */
function failureNames(run: FailingPinned, declared: readonly string[]): readonly string[] {
  return (run.pinnedFailures ?? failingTests(run.output, declared)).names;
}

function declaredName(declared: readonly string[], requested: string): string | undefined {
  const squash = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
  const exact = declared.find((name) => squash(name) === squash(requested));
  if (exact) return exact;
  const partial = declared.filter((name) => squash(name).includes(squash(requested)));
  return partial.length === 1 ? partial[0] : undefined;
}

function boundedFailure(failing: readonly FailingPinned[], check: string): string {
  return (failing.find((entry) => entry.check === check)?.output ?? "").slice(-FAILURE_BOUND);
}

function unknownTest(record: IndependentTestsRecord, requested: string): string {
  const names = (record.tests ?? []).map((entry) => JSON.stringify(entry.name)).slice(0, 12);
  return `${JSON.stringify(requested)} matches no declared test. Use the exact name; declared: ${names.join(", ")}`;
}

function notFailing(
  requested: string,
  name: string,
  failing: readonly FailingPinned[],
  declared: readonly string[],
): string {
  if (
    failing.length &&
    failing.every((entry) => suiteCrashed({ ...entry, status: "failed" }, declared))
  )
    return "The pinned suite crashed before reporting any test, so no test can be disputed";
  return failing.length
    ? `${JSON.stringify(name)} is not on a "FAIL: <test name>" line of the failing run, so only failing tests can be disputed (asked: ${JSON.stringify(requested)})`
    : "The pinned suite did not fail as a blocking check in this run (it passed, or only runs for information until the last slice); only failing tests can be disputed";
}

/** Upheld tests stay waived; a rejected one needs a product change and is filed at most twice. */
function priorDispute(
  disputes: readonly PinnedDispute[],
  verified: readonly string[],
  name: string,
  subject: string,
): string | undefined {
  const prior = disputes.find((entry) => entry.test === name);
  const open = disputes.filter((entry) => entry.status === "open" && entry.test !== name);
  // An "upheld" that does not verify against the critic state waives nothing: file it again.
  const unverified = prior?.status === "upheld" && !verified.includes(name);
  if (prior?.status === "upheld" && !unverified)
    return "Already upheld and waived; nothing to dispute";
  if (open.length >= MAX_OPEN_DISPUTES)
    return `At most ${MAX_OPEN_DISPUTES} disputes can await a ruling at once. Keep the product as the request says, report the request sentence and the tests that disagree in your final message, and run visp pr`;
  if (prior?.status === "rejected" && prior.ruling?.subject === subject)
    return `The reviewer rejected this dispute on this exact source (${prior.ruling.reasoning.slice(0, 300)}). Change the product before disputing it again`;
  if (prior && !unverified && prior.status !== "open" && prior.filings >= MAX_FILINGS_PER_TEST)
    return `This test was disputed ${prior.filings} times already; the reviewer's ruling stands. Satisfy the test`;
  return undefined;
}

/**
 * Open disputes describe one failing run. When the source has changed, each is either
 * refreshed from the run just observed (same test still failing) or expired (it no longer
 * fails), so the reviewer never rules on stale output. Only a run of the pinned suite as a
 * blocking check can tell.
 */
export async function refreshDisputes(
  workspace: WorkspaceState,
  feature: string,
  failing: readonly FailingPinned[],
  subject: string,
): Promise<Result<void>> {
  const loaded = await readTestsRecord(workspace, feature);
  const record = loaded.ok ? loaded.value : undefined;
  if (!loaded.ok) return loaded;
  const stale = (record?.disputes ?? []).filter(
    (entry) => entry.status === "open" && entry.subject !== subject,
  );
  if (!record || !stale.length) return ok(undefined);
  const declared = (record.tests ?? []).map((entry) => entry.name);
  const disputes = (record.disputes ?? []).map((entry): PinnedDispute => {
    if (!stale.includes(entry)) return entry;
    const run = failing.find((item) => failureNames(item, declared).includes(entry.test));
    return run
      ? { ...entry, subject, failure: boundedFailure(failing, run.check), reviews: 0 }
      : { ...entry, status: "expired" };
  });
  const saved = await saveTestsRecord(workspace, feature, { ...record, disputes }, record);
  return saved.ok ? ok(undefined) : saved;
}

export interface ReviewedDisputes {
  readonly attempt: string;
  readonly task?: string;
  readonly subject: string;
  readonly evidence: string;
  readonly model?: string;
  /** The disputes the reviewer was asked about, recorded at reservation. */
  readonly asked: readonly string[];
  /** Rulings from an independent, VISP-launched review; empty when the review was not one. */
  readonly rulings: readonly DisputeRuling[];
}

/**
 * Applies a returned review's rulings to the disputes it was asked about. A dispute the
 * review did not rule on has used one of its reviews. Retries a conflicting write.
 */
export async function applyDisputeRulings(
  workspace: WorkspaceState,
  feature: string,
  review: ReviewedDisputes,
): Promise<Result<void>> {
  let last: Result<void> = ok(undefined);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    last = await applyOnce(workspace, feature, review);
    if (last.ok || last.error.code !== "STATE_BUSY") return last;
  }
  return last;
}

async function applyOnce(
  workspace: WorkspaceState,
  feature: string,
  review: ReviewedDisputes,
): Promise<Result<void>> {
  if (!review.asked.length) return ok(undefined);
  const loaded = await readTestsRecord(workspace, feature);
  if (!loaded.ok) return loaded;
  const record = loaded.value;
  if (!record?.disputes?.length) return ok(undefined);
  const at = new Date().toISOString();
  const disputes = record.disputes.map((entry): PinnedDispute => {
    if (entry.status !== "open" || !review.asked.includes(entry.test)) return entry;
    const ruling = review.rulings.find((candidate) => candidate.test === entry.test);
    if (!ruling) return { ...entry, reviews: entry.reviews + 1 };
    return {
      ...entry,
      status: ruling.ruling,
      ruling: rulingRecord(ruling, review, at),
    };
  });
  const saved = await saveTestsRecord(workspace, feature, { ...record, disputes }, record);
  return saved.ok ? ok(undefined) : saved;
}

function rulingRecord(
  ruling: DisputeRuling,
  review: ReviewedDisputes,
  at: string,
): DisputeRulingRecord {
  return {
    ruling: ruling.ruling,
    reasoning: ruling.reasoning.slice(0, 1500),
    at,
    subject: review.subject,
    ...(review.model ? { model: review.model } : {}),
    attempt: review.attempt,
    ...(review.task ? { task: review.task } : {}),
    evidence: review.evidence,
  };
}

/** Disputes awaiting a ruling with what the reviewer needs to judge each one. */
export async function disputePacketEntries(
  workspace: WorkspaceState,
  feature: string,
): Promise<PacketDispute[]> {
  const loaded = await readTestsRecord(workspace, feature);
  const record = loaded.ok ? loaded.value : undefined;
  const state = await disputeState(workspace, feature);
  if (!record || !state.pending.length) return [];
  const source = record.file
    ? await workspace.files.readTextIfExists(join(workspace.paths.root, record.file))
    : undefined;
  const content = source?.ok ? (source.value ?? "") : "";
  // One defect often fails many tests with one reason and one run: show each text once.
  const sameAs = (text: string, index: number, field: "reason" | "failure") => {
    const first = state.pending.findIndex((entry) => entry[field] === text);
    return first < index ? `Same as for ${JSON.stringify(state.pending[first]?.test)}.` : text;
  };
  return state.pending.map((entry, index) => ({
    test: entry.test,
    requestQuote: record.tests?.find((test) => test.name === entry.test)?.quote ?? "",
    workerReason: sameAs(entry.reason, index, "reason"),
    failureOutput: sameAs(entry.failure, index, "failure"),
    suiteFile: record.file ?? "",
    testSource: sourceExcerpt(content, entry.test),
    ...(entry.history.length
      ? {
          priorRulings: entry.history.map(({ ruling, reasoning, subject }) => ({
            ruling,
            reasoning,
            subject,
          })),
        }
      : {}),
  }));
}

/** The lines around the test's name, or the head of the file when the name is not in it. */
export function sourceExcerpt(content: string, test: string): string {
  const at = content.toLowerCase().indexOf(test.toLowerCase());
  if (at < 0) return content.slice(0, SOURCE_BEFORE + SOURCE_AFTER);
  const start = Math.max(0, content.lastIndexOf("\n", Math.max(0, at - SOURCE_BEFORE)) + 1);
  const end = Math.min(content.length, at + SOURCE_AFTER);
  return content.slice(start, end);
}

/**
 * A hash input for the review-uniqueness rule: a review of other disputes, or a further review
 * of one the reviewer left unruled, is a new review, not a duplicate.
 */
export function disputeSetKey(pending: readonly PinnedDispute[]): string | undefined {
  return pending.length
    ? pending
        .map((entry) => `${entry.test}\n${entry.reason}\n${entry.reviews}`)
        .sort()
        .join("\n--\n")
    : undefined;
}

/**
 * The worker's view of pinned tests: what this call filed, where each dispute stands, and,
 * when the pinned suite failed as a blocking check, how to dispute a test. Undefined when
 * there is nothing to say.
 */
export async function pinnedTestsReport(
  workspace: WorkspaceState,
  feature: string,
  context: {
    readonly filed?: readonly DisputeOutcome[];
    /** The pinned suite failed as a blocking check in this call. */
    readonly failing: boolean;
    readonly command: "done" | "accept";
    /** Those failing runs, so a suite that crashed gets the crash hint, not the dispute one. */
    readonly failures?: readonly FailingPinned[];
    /** Whether VISP's reviewer can still rule; an open dispute without one goes to the human. */
    readonly capacity?: ReviewerCapacity;
  },
): Promise<PinnedTestsReport | undefined> {
  const state = await disputeState(workspace, feature);
  const waivers = await pinnedWaivers(workspace, feature);
  const disputes = state.all
    .filter((entry) => entry.status !== "expired")
    .map((entry) => ({
      test: entry.test,
      status: entry.status,
      note: disputeNote(
        entry,
        context.command,
        waivers.names.includes(entry.test),
        waivers.suiteSkips,
        context.capacity?.available !== false,
      ),
    }));
  const report: PinnedTestsReport = {
    ...(context.filed?.length ? { filed: context.filed } : {}),
    ...(disputes.length ? { disputes } : {}),
    ...(context.failing ? { hint: failureHint(workspace, context, state.declared) } : {}),
  };
  return Object.keys(report).length ? report : undefined;
}

/** The hint under a failing pinned suite: a crash has no test to dispute. */
function failureHint(
  workspace: WorkspaceState,
  context: {
    readonly command: "done" | "accept";
    readonly failures?: readonly FailingPinned[];
    readonly capacity?: ReviewerCapacity;
  },
  declared: readonly string[],
): string {
  const failures = context.failures ?? [];
  const unreported = missingResults(failures, declared);
  if (unreported.length) return incompleteSuiteNote(unreported);
  const crashed =
    failures.length > 0 &&
    failures.every((entry) => suiteCrashed({ ...entry, status: "failed" }, declared));
  if (!crashed)
    return disputeHint(workspace, context.command, context.capacity?.available !== false);
  const line = crashLine(failures[0]?.output ?? "");
  return `The pinned suite crashed before it reported any declared test as failing${line ? ` (${line})` : ""}, so there is nothing to dispute. If that error names something your product must provide (a file, module, server or output), provide it. Never edit or debug the suite under acceptance/.`;
}

function disputeNote(
  entry: PinnedDispute,
  command: string,
  verified: boolean,
  suiteSkips: boolean,
  reviewerCanRule: boolean,
): string {
  const reasoning = entry.ruling?.reasoning.slice(0, 400) ?? "";
  if (entry.status === "open" && entry.reviews >= MAX_REVIEWS_PER_FILING)
    return "the independent reviewer left this unruled twice; it is handed to the human reviewer: run visp pr";
  if (entry.status === "open" && !reviewerCanRule)
    return "the independent reviewer cannot rule on this (its review budget is spent or it is unavailable); hand it to the human reviewer: run visp pr, which lists it";
  if (entry.status === "open")
    return `awaiting the independent reviewer; run visp ${command}, which launches it when the blocking checks pass or their failures are fully disputed`;
  if (entry.status === "rejected")
    return `${reasoning} The product must satisfy this test; change the product${entry.filings < MAX_FILINGS_PER_TEST ? ", then dispute again only with a new reason" : " (it cannot be disputed again)"}.`;
  if (!verified)
    return `${reasoning} The ruling does not match the review record, so it is not applied.`;
  return suiteSkips
    ? `${reasoning} Waived: the suite skips it on the next run of visp ${command}.`
    : `${reasoning} Waived: this suite does not read ${WAIVED_TESTS_ENV}, so VISP counts the check as passing when every failing test it names is waived.`;
}

export interface PinnedRoute {
  readonly evidence: string[];
  /** What to do about a pinned crash that is not yet handed off; replaces the generic fix text. */
  readonly objective?: string;
  /** Replaces the fix routing when the pinned failure is settled or must be handed off. */
  readonly override?: {
    readonly action: "implement" | "accept" | "fix";
    readonly objective: string;
    readonly command: string;
    readonly completion?: "handoff";
  };
}

/** How `next` treats failing pinned checks: the hint and dispute states, or a different step. */
export async function pinnedRoute(
  workspace: WorkspaceState,
  feature: string,
  task: string | undefined,
  failures: readonly {
    check: string;
    status: string;
    output: string;
    pinnedFailures?: ProductExecution["pinnedFailures"];
  }[],
  command: "done" | "accept",
  history: readonly PinnedHistoryRun[],
  capacity: ReviewerCapacity,
): Promise<PinnedRoute> {
  const pinned = failures.filter((entry) => entry.check.startsWith("PINNED_"));
  if (!pinned.length) return { evidence: [] };
  const state = await disputeState(workspace, feature);
  const waivers = await pinnedWaivers(workspace, feature);
  const report = await pinnedTestsReport(workspace, feature, {
    failing: true,
    command,
    failures: pinned,
    capacity,
  });
  const evidence = [
    ...(report?.hint ? [report.hint] : []),
    ...(report?.disputes ?? []).map(
      (entry) => `Pinned test ${JSON.stringify(entry.test)} dispute ${entry.status}: ${entry.note}`,
    ),
  ];
  const unreported = missingResults(pinned, state.declared);
  if (unreported.length) return { evidence, objective: incompleteSuiteNote(unreported) };
  const only = failures.length === pinned.length;
  const settled =
    only &&
    pinned.every((entry) =>
      allFailuresIn(entry.output, state.declared, waivers.names, entry.pinnedFailures),
    );
  if (settled) return { evidence, override: upheldOverride(command, feature, task) };
  // Without a reviewer that can still rule, a dispute awaiting one goes to the human too.
  const cannotRule = !capacity.available && state.pending.length > 0;
  const handOff = cannotRule ? [...state.handedOff, ...state.pending] : state.handedOff;
  const covered = [...handOff.map((entry) => entry.test), ...waivers.names];
  const allSettled =
    only &&
    pinned.every((entry) =>
      allFailuresIn(entry.output, state.declared, covered, entry.pinnedFailures),
    );
  if (handOff.length && allSettled)
    return { evidence, override: handedOffOverride(feature, handOff, cannotRule) };
  const stuck = await pinnedHandoff(workspace, feature, failures, history);
  if (stuck) return { evidence, override: stuck };
  const crashed =
    only && pinned.every((entry) => suiteCrashed({ ...entry, status: "failed" }, state.declared));
  return { evidence, ...(crashed ? { objective: CRASH_OBJECTIVE } : {}) };
}

function missingResults(failures: readonly FailingPinned[], declared: readonly string[]): string[] {
  return [
    ...new Set(
      failures.flatMap((entry) =>
        unreportedPinnedTests(entry.output, declared, entry.pinnedFailures),
      ),
    ),
  ];
}

function upheldOverride(
  command: "done" | "accept",
  feature: string,
  task: string | undefined,
): NonNullable<PinnedRoute["override"]> {
  return command === "done"
    ? {
        action: "implement",
        objective:
          "The independent reviewer upheld the disputed pinned test(s). Run visp done again: the suite skips them",
        command: cliCommand("done", { feature, task }),
      }
    : {
        action: "accept",
        objective:
          "The independent reviewer upheld the disputed pinned test(s). Run visp accept again: they are waived",
        command: cliCommand("accept", { feature }),
      };
}

function handedOffOverride(
  feature: string,
  handedOff: readonly PinnedDispute[],
  cannotRule: boolean,
): NonNullable<PinnedRoute["override"]> {
  const tests = handedOff.map((entry) => JSON.stringify(entry.test)).join(", ");
  return {
    action: "fix",
    objective: cannotRule
      ? `The independent reviewer cannot rule on the dispute of ${tests} (its review budget is spent or it is unavailable). Hand it to the human reviewer: run visp pr, which lists it`
      : `The independent reviewer left the dispute of ${tests} unruled twice. Hand it to the human reviewer: run visp pr, which lists it`,
    command: cliCommand("pr", { feature }),
    completion: "handoff",
  };
}

const CRASH_OBJECTIVE =
  "The pinned suite crashed before it reported any declared test. Read the error in the evidence: if it names something your product must provide (a file, module, server or output) provide it; otherwise change nothing under acceptance/. Then rerun visp done";

/** An execution of a pinned check as the persistence rule reads it (state.executions). */
export type PinnedHistoryRun = PinnedRun & { readonly task?: string };

/**
 * Hands the pinned suite to the human reviewer when it keeps failing the same unattributed way
 * (crash, environment failure, timeout) across at least two source states: the fault is in the
 * suite or its environment, and more runs cannot fix it. Only when every current non-passed
 * failure is such a pinned check. This is disclosure, not acceptance: accept still fails on it.
 */
export async function pinnedHandoff(
  workspace: WorkspaceState,
  feature: string,
  failures: readonly { check: string; status: string }[],
  history: readonly PinnedHistoryRun[],
): Promise<NonNullable<PinnedRoute["override"]> | undefined> {
  const open = failures.filter((entry) => entry.status !== "passed");
  if (!open.length || !open.every((entry) => entry.check.startsWith("PINNED_"))) return undefined;
  const { declared } = await disputeState(workspace, feature);
  const stuck = [...new Set(open.map((entry) => entry.check))].map((check) => ({
    check,
    ...persistentPinnedFailure(
      history.filter((run) => run.check === check),
      declared,
      workspace.paths.root,
    ),
  }));
  const first = stuck[0];
  if (!first || stuck.some((entry) => entry.count === undefined)) return undefined;
  const what = first.status === "crash" ? "crashed" : "could not run";
  return {
    action: "fix",
    completion: "handoff",
    command: cliCommand("pr", { feature }),
    objective: `The pinned suite ${first.check} ${what} the same way in ${first.count} runs while the product changed${first.line ? ` (${first.line})` : ""}. More runs will not change it; if the error names something your product should provide, provide it first. Then run visp pr: it hands the suite to the human reviewer`,
  };
}
