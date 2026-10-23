import { z } from "zod";
import { vispError } from "../../core/errors.js";
import { type FileMutation, filePrecondition } from "../../core/file-transaction.js";
import { err, ok, type Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import type { AccountVerification } from "./account-verification.js";
import { dumpLineIndexes, isPastedLine, isProcessInstruction } from "./requirement-noise.js";

/**
 * The requirements a request states, listed by VISP at `feature` without a model, and the
 * worker's account of each at `done`. Undershooting, where one of several parallel branches
 * ships and the others are silently dropped, is the main failure left for strong workers
 * (DeepSWE; ChainSWE workers resolved 66% of issues at their step). A listed requirement
 * stays open until the worker names the passing check that shows it, or says why it is not
 * done.
 */

/** A request with one requirement has no branch to drop; its check accounts for it. */
const MIN_ACCOUNTED = 2;

/** The requirements the worker must account for: none when the request states only one. */
export function accountedRequirements(request: string): ListedRequirement[] {
  const listed = requestRequirements(request);
  return listed.length >= MIN_ACCOUNTED ? listed : [];
}

export interface ListedRequirement {
  readonly id: string;
  readonly statement: string;
}

const LIST_ITEM = /^(\s*)(?:[-*•+]|\d{1,2}[.)])\s+(.+)$/;
/** A code fence (CommonMark): up to three spaces, three or more marks, then an info string. */
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*[\w+#.-]*\s*$/;
const SENTENCE = /(?<=[.!?])\s+(?=[A-Z0-9`"(])/;
/** Prose next to a list counts when it instructs or constrains, not when it describes. */
const IMPERATIVE =
  /^(?:add|build|create|draw|extend|implement|keep|make|render|return|show|support|update|use|write)\b/i;
const CONSTRAINT =
  /\b(?:must|should|shall|needs? to|has to|have to|only|never|always|without|do not|don't|ensure|make sure)\b/i;
const ENDPOINT = /\b(GET|POST|PUT|PATCH|DELETE)\s+`?(\/[^\s`,;)]*)/g;
const SYNC_ASYNC =
  /\bsync(?:hronous)?\b.*\basync(?:hronous)?\b|\basync(?:hronous)?\b.*\bsync(?:hronous)?\b/i;
const BOTH = /\bboth\s+((?:\w+\s+){0,3}?\w+)\s+and\s+((?:\w+\s+){0,3}?\w+)(?=[.,;:)]|$)/i;
const MIN_WORDS = 2;
const MAX_STATEMENT = 300;

/**
 * Context VISP appends to a recorded request (project rules, recalled decisions and the commits
 * since): in force, but not this request's requirements.
 */
const APPENDED_CONTEXT =
  /^(?:Project rules the user stated for all later work|Recorded decisions from earlier (?:requests|work) on this project)/;

/** The user's request without the context VISP appended after it. */
function statedRequest(request: string): string {
  const blocks = request.split(/(\n\s*\n)/);
  const cut = blocks.findIndex((block) => APPENDED_CONTEXT.test(block.trimStart()));
  return cut < 0 ? request : blocks.slice(0, cut).join("");
}

/**
 * The requirements a request states, in request order: list items, else sentences. Pasted code,
 * logs and tracebacks and instructions about how to work are not requirements.
 */
export function requestRequirements(request: string): ListedRequirement[] {
  const parts = requestParts(statedRequest(request));
  const listed = parts.filter((part) => part.item).length >= 2;
  return parts
    .filter((part) => !isProcessInstruction(part.text))
    .filter((part) => part.item || (listed ? instructs(part.text) : words(part.text) >= MIN_WORDS))
    .flatMap((part) => branches(part.text))
    .map((statement, index) => ({
      id: `R${String(index + 1).padStart(3, "0")}`,
      statement: bound(statement),
    }));
}

interface RequestPart {
  readonly text: string;
  readonly item: boolean;
}

/** List items with their continuation lines, and prose sentences outside the lists, in order. */
function requestParts(request: string): RequestPart[] {
  const parts: RequestPart[] = [];
  let fence: string | undefined;
  let item: { indent: number; text: string } | undefined;
  const flush = () => {
    if (item) parts.push({ text: item.text, item: true });
    item = undefined;
  };
  const lines = request.replace(/\r\n?/g, "\n").split("\n");
  const dump = dumpLineIndexes(lines);
  for (const [index, line] of lines.entries()) {
    const mark = FENCE.exec(line)?.[1];
    if (mark) {
      if (!fence) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    const listed = LIST_ITEM.exec(line);
    if (listed) {
      flush();
      item = { indent: listed[1]?.length ?? 0, text: (listed[2] ?? "").trim() };
    } else if (!line.trim()) flush();
    else if (item && /^\s/.test(line) && line.search(/\S/) > item.indent)
      item.text = `${item.text} ${line.trim()}`;
    else if (dump.has(index) || isPastedLine(line)) flush();
    else {
      flush();
      for (const sentence of line.trim().split(SENTENCE))
        if (sentence.trim()) parts.push({ text: sentence.trim(), item: false });
    }
  }
  flush();
  return parts;
}

/** A sentence that introduces a list counts only for a constraint it states itself. */
function instructs(sentence: string): boolean {
  if (sentence.endsWith(":")) return CONSTRAINT.test(sentence);
  return IMPERATIVE.test(sentence) || CONSTRAINT.test(sentence);
}

function words(text: string): number {
  return text.split(/\s+/).length;
}

/** One requirement per parallel branch the text names: endpoints, sync and async, "both X and Y". */
function branches(text: string): string[] {
  const statement = text.replace(/\s+/g, " ").trim();
  const endpoints = [
    ...new Set([...statement.matchAll(ENDPOINT)].map((match) => `${match[1]} ${match[2]}`)),
  ];
  if (endpoints.length >= 2) return endpoints.map((endpoint) => `${endpoint}: ${statement}`);
  if (SYNC_ASYNC.test(statement)) return [`(sync) ${statement}`, `(async) ${statement}`];
  const both = BOTH.exec(statement);
  if (both) return [`(${both[1]}) ${statement}`, `(${both[2]}) ${statement}`];
  return [statement];
}

function bound(statement: string): string {
  return statement.length > MAX_STATEMENT ? `${statement.slice(0, MAX_STATEMENT - 1)}…` : statement;
}

const recorded = { statement: z.string(), at: z.string() };
const doneAccount = {
  id: z.string(),
  status: z.literal("done"),
  check: z.string(),
  note: z.string().optional(),
};
const notDoneAccount = { id: z.string(), status: z.literal("not-done"), reason: z.string() };
const accountSchema = z.discriminatedUnion("status", [
  z.object(doneAccount).strict(),
  z.object(notDoneAccount).strict(),
]);
export type RequirementAccount = z.infer<typeof accountSchema>;

const accountsFileSchema = z
  .object({
    version: z.literal(1),
    accounts: z.array(
      z.discriminatedUnion("status", [
        z.object({ ...doneAccount, ...recorded }).strict(),
        z.object({ ...notDoneAccount, ...recorded }).strict(),
      ]),
    ),
  })
  .strict();

const ACCOUNT = /^\s*(R\d{3})\s*=\s*(.*)$/i;
const NOT_DONE = /^not[ -]done\s*[:-]\s*(.*)$/i;
const CHECK = /^([A-Za-z][\w.-]*)(?:\s+(.+))?$/;
const ACCOUNT_FORMAT =
  'Account for a requirement as R001=<check id that shows it>, optionally followed by the test name, or "R001=not done: <reason>"';

/** `--account R001=C001 [test name]` or `--account "R002=not done: <reason>"`. */
export function parseRequirementAccounts(entries: readonly string[]): Result<RequirementAccount[]> {
  const accounts: RequirementAccount[] = [];
  for (const entry of entries) {
    const matched = ACCOUNT.exec(entry);
    const id = matched?.[1]?.toUpperCase();
    const value = matched?.[2]?.trim() ?? "";
    const notDone = NOT_DONE.exec(value);
    const check = notDone ? undefined : CHECK.exec(value);
    if (id && notDone?.[1]?.trim())
      accounts.push({ id, status: "not-done", reason: notDone[1].trim() });
    else if (id && check?.[1] && !/^not\b/i.test(value))
      accounts.push({
        id,
        status: "done",
        check: check[1],
        ...(check[2]?.trim() ? { note: check[2].trim() } : {}),
      });
    else
      return err(vispError("ARTIFACT_INVALID", `Unreadable account "${entry}". ${ACCOUNT_FORMAT}`));
  }
  return ok(accounts);
}

type StoredAccount = z.infer<typeof accountsFileSchema>["accounts"][number];
const accountsPath = (workspace: WorkspaceState, feature: string) =>
  workspace.paths.featureFile(feature, "requirements.json");

/** Accounts recorded for the feature's current listing; one whose statement changed is dropped. */
export async function readRequirementAccounts(
  workspace: WorkspaceState,
  feature: string,
  listed: readonly ListedRequirement[],
): Promise<Result<{ accounts: StoredAccount[]; text?: string }>> {
  const read = await workspace.files.readTextIfExists(accountsPath(workspace, feature));
  if (!read.ok) return read;
  if (read.value === undefined) return ok({ accounts: [] });
  const parsed = accountsFileSchema.safeParse(safeJson(read.value));
  if (!parsed.success)
    return err(vispError("ARTIFACT_INVALID", `Unreadable ${accountsPath(workspace, feature)}`));
  const current = new Map(listed.map((entry) => [entry.id, entry.statement]));
  return ok({
    accounts: parsed.data.accounts.filter((entry) => current.get(entry.id) === entry.statement),
    text: read.value,
  });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Records this call's accounts with the earlier ones; a later account of a requirement
 * replaces the earlier. Whether a cited check passed is judged when gaps are read, against the
 * current version, so a claim never outlives the evidence it names.
 */
export async function requirementAccountMutation(
  workspace: WorkspaceState,
  feature: string,
  listed: readonly ListedRequirement[],
  incoming: readonly RequirementAccount[],
): Promise<Result<FileMutation | undefined>> {
  if (!incoming.length) return ok(undefined);
  const statements = new Map(listed.map((entry) => [entry.id, entry.statement]));
  const unknown = incoming.filter((entry) => !statements.has(entry.id)).map((entry) => entry.id);
  if (unknown.length)
    return err(
      vispError(
        "ARTIFACT_INVALID",
        listed.length
          ? `${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not listed; the request's requirements are ${listed[0]?.id}–${listed.at(-1)?.id}`
          : "This request lists no requirements to account for",
      ),
    );
  const stored = await readRequirementAccounts(workspace, feature, listed);
  if (!stored.ok) return stored;
  const at = new Date().toISOString();
  const replaced = new Set(incoming.map((entry) => entry.id));
  const accounts = [
    ...stored.value.accounts.filter((entry) => !replaced.has(entry.id)),
    ...incoming.map((entry) => ({ ...entry, statement: statements.get(entry.id) ?? "", at })),
  ].sort((a, b) => a.id.localeCompare(b.id));
  return ok({
    kind: "write",
    path: accountsPath(workspace, feature),
    content: `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`,
    expectedBefore: filePrecondition(stored.value.text),
  });
}

/** The command `done` runs as, and a check of the slice to cite in the example entries. */
export interface AccountCommand {
  readonly done: string;
  readonly check: string;
}

/** The one command that accounts for what is open: workers read `--help` for its shape otherwise. */
function accountCommandText(open: readonly string[], command: AccountCommand | undefined): string {
  const entry = (id: string) => `"${id}=${command?.check ?? "<check id>"} <test name>"`;
  const examples = open.slice(0, 2).map(entry).join(" ");
  const more = open.length > 2 ? " …" : "";
  return `${command?.done ?? "visp done"} --account ${examples}${more}, one entry per requirement; for one that is not done: "${open[0]}=not done: <reason>"`;
}

/** What still needs an account: none, or a check that has not passed on the current version. */
export function requirementGaps(
  listed: readonly ListedRequirement[],
  accounts: readonly StoredAccount[],
  passedChecks: ReadonlySet<string>,
  command?: AccountCommand,
): string[] {
  const byId = new Map(accounts.map((entry) => [entry.id, entry]));
  const gaps: string[] = [];
  const open: string[] = [];
  for (const requirement of listed) {
    const account = byId.get(requirement.id);
    if (!account) open.push(requirement.id);
    else if (account.status === "done" && !passedChecks.has(account.check))
      gaps.push(
        `${requirement.id} cites ${account.check}, which has not passed on the current version; name a passing check or rerun it`,
      );
  }
  if (open.length)
    gaps.unshift(
      `Requirements not accounted for: ${open.join(", ")}. At visp done, give each its passing check and a test it runs, or say why it is not done: ${accountCommandText(open, command)}`,
    );
  return gaps;
}

/** Where each requirement stands, tersely: the statements were listed at `feature`. */
export function requirementSummary(
  listed: readonly ListedRequirement[],
  accounts: readonly StoredAccount[],
  verified: ReadonlyMap<string, AccountVerification> = new Map(),
): string[] {
  const byId = new Map(accounts.map((entry) => [entry.id, entry]));
  return listed.map((requirement) => {
    const account = byId.get(requirement.id);
    if (!account) return `${requirement.id}: open`;
    if (account.status !== "done") return `${requirement.id}: not done, ${account.reason}`;
    const checked = verified.get(requirement.id);
    return `${requirement.id}: done, ${account.check}${account.note ? ` ${account.note}` : ""}${checked ? ` (${checked.summary})` : ""}`;
  });
}
