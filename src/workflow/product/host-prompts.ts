import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FileMutation } from "../../core/file-transaction.js";
import { filePrecondition } from "../../core/file-transaction.js";
import { ok, type Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";

/** Written by the Claude Code hook on every user prompt; git-ignored session state. */
export const HOST_PROMPTS_FILE = "user-prompts.jsonl";
/** The host session of the latest user prompt, written beside the prompts; never consumed. */
export const HOST_SESSION_FILE = "host-session.json";

/** Written while `visp feature` records a request; its age tells `next` and `work` to wait. */
export const FEATURE_STARTING_FILE = "feature-starting.json";
/** Older markers are left by a killed `visp feature`; a later command ignores them. */
const FEATURE_STARTING_MS = 120_000;

/** Mark that `visp feature` is recording a request. A failed write only loses the hint. */
export async function beginFeatureStart(workspace: WorkspaceState): Promise<void> {
  try {
    await mkdir(workspace.paths.sessionDir, { recursive: true });
    await writeFile(
      join(workspace.paths.sessionDir, FEATURE_STARTING_FILE),
      `${JSON.stringify({ at: Date.now() })}\n`,
    );
  } catch {}
}

export async function endFeatureStart(workspace: WorkspaceState): Promise<void> {
  await rm(join(workspace.paths.sessionDir, FEATURE_STARTING_FILE), { force: true }).catch(
    () => undefined,
  );
}

/** How long a `visp feature` has been recording a request, when one started recently. */
export async function featureStartingAge(workspace: WorkspaceState): Promise<number | undefined> {
  try {
    const text = await readFile(join(workspace.paths.sessionDir, FEATURE_STARTING_FILE), "utf8");
    const at = Number(JSON.parse(text).at);
    const age = Date.now() - at;
    return Number.isFinite(age) && age >= 0 && age < FEATURE_STARTING_MS ? age : undefined;
  } catch {
    return undefined;
  }
}

export interface HostRequest {
  /** The request to preserve: a verbatim excerpt the worker quoted, or the latest prompt. */
  readonly request: string;
  readonly origin: "worker-quoted-host-prompt" | "host-prompt";
  /** Every recorded user prompt since the last feature, oldest first. */
  readonly prompts: readonly string[];
  /** Whether a host prompt hook recorded them; false when they were read from the Codex session. */
  readonly recordedByHook: boolean;
  /** Consumes the recorded prompts so the next feature starts from newer ones. */
  readonly mutation?: FileMutation;
}

/**
 * Weak workers paraphrase or summarize the user's request when they start a feature,
 * and the tester and reviewer then judge against the paraphrase. When the host recorded
 * the user's prompts, the worker's text is kept only if it is a verbatim excerpt of one.
 */
export async function hostRequest(
  workspace: WorkspaceState,
  workerText: string | undefined,
): Promise<Result<HostRequest | undefined>> {
  const path = join(workspace.paths.sessionDir, HOST_PROMPTS_FILE);
  const text = await workspace.files.readTextIfExists(path);
  if (!text.ok) return text;
  const recorded = text.value ? promptLines(text.value) : [];
  // Codex has no prompt hook, but commands see their session, which records user messages.
  const prompts = recorded.length ? recorded : await codexSessionPrompts();
  const latest = prompts.at(-1);
  if (!latest) return ok(undefined);
  const mutation: FileMutation | undefined =
    recorded.length && text.value
      ? { kind: "remove", path, expectedBefore: filePrecondition(text.value) }
      : undefined;
  const quoted = workerText?.trim();
  // A verbatim first sentence is still a summary; the quote must carry most of its prompt.
  if (
    quoted &&
    prompts.some(
      (prompt) =>
        normalized(prompt).includes(normalized(quoted)) &&
        normalized(quoted).length * 2 >= normalized(prompt).length,
    )
  )
    return ok({
      request: quoted,
      origin: "worker-quoted-host-prompt",
      prompts,
      recordedByHook: recorded.length > 0,
      ...(mutation ? { mutation } : {}),
    });
  return ok({
    request: latest,
    origin: "host-prompt",
    prompts,
    recordedByHook: recorded.length > 0,
    ...(mutation ? { mutation } : {}),
  });
}

/**
 * Codex runs project hooks only once the user trusts them with /hooks, and a headless
 * `codex exec` in an untrusted project runs none: no prompt record, no shell protection and
 * no Stop reminder, with nothing saying so. VISP installs a Codex prompt hook, so a request
 * that could only be read from the Codex session file means the hooks did not run.
 */
export function codexHooksWarning(
  harness: string,
  host: Pick<HostRequest, "recordedByHook"> | undefined,
): string | undefined {
  return harness === "codex" && host && !host.recordedByHook
    ? "Codex did not run VISP's project hooks in this session (they are probably not trusted), so the Stop reminder and shell protection are off. Open Codex in this project and trust them once with /hooks, including before headless codex exec runs."
    : undefined;
}

/**
 * Whether the host recorded user prompts that no feature has taken yet; with `since`, only
 * prompts recorded after that time count.
 */
export async function hasUntakenPrompts(
  workspace: WorkspaceState,
  since?: string,
): Promise<Result<boolean>> {
  const text = await workspace.files.readTextIfExists(
    join(workspace.paths.sessionDir, HOST_PROMPTS_FILE),
  );
  if (!text.ok) return text;
  const prompts = text.value === undefined ? [] : recordedPrompts(text.value);
  const after = since === undefined ? undefined : Date.parse(since);
  return ok(
    prompts.some(
      (entry) => after === undefined || (entry.at !== undefined && Date.parse(entry.at) > after),
    ),
  );
}

/** The host session that sent the latest user prompt, when the host's hook reports one. */
export async function currentHostSession(
  workspace: WorkspaceState,
  forGrant = false,
): Promise<Result<string | undefined>> {
  if (forGrant) {
    const active = await activeHostSessions(workspace);
    if (!active.ok) return active;
    if (active.value.size > 1) return ok(undefined);
  }

  const text = await workspace.files.readTextIfExists(
    join(workspace.paths.sessionDir, HOST_SESSION_FILE),
  );
  if (!text.ok || text.value === undefined) return text.ok ? ok(undefined) : text;
  try {
    const session = (JSON.parse(text.value) as { session?: unknown }).session;
    return ok(typeof session === "string" && session ? session : undefined);
  } catch {
    return ok(undefined);
  }
}

/**
 * Claude Code delivers a background command's completion to the session as a prompt; one
 * became a feature's request. The prompt hook no longer records them, and the ones an older
 * hook recorded are skipped here. The hook script repeats this test.
 */
const HOST_NOTIFICATION = /^(\s*<task-notification>[\s\S]*?<\/task-notification>)+\s*$/;

interface RecordedPrompt {
  readonly prompt: string;
  readonly at?: string;
}

function recordedPrompts(text: string): RecordedPrompt[] {
  return text.split("\n").flatMap((line) => {
    try {
      const { prompt, at } = JSON.parse(line) as { prompt?: unknown; at?: unknown };
      return typeof prompt === "string" && prompt.trim() && !HOST_NOTIFICATION.test(prompt)
        ? [{ prompt, ...(typeof at === "string" ? { at } : {}) }]
        : [];
    } catch {
      return [];
    }
  });
}

function promptLines(text: string): string[] {
  return recordedPrompts(text).map((entry) => entry.prompt);
}

/**
 * The user messages of the Codex session running this command: Codex sets CODEX_THREAD_ID
 * for commands and records the session as `sessions/<yyyy>/<mm>/<dd>/rollout-*-<id>.jsonl`.
 * `codex exec` records `event_msg` items of type UserMessage; Codex Desktop records
 * `event_msg` payloads `user_message` with a string message, used when no item form exists.
 * `response_item` messages are never read: they carry injected AGENTS.md and environment
 * context, which would become the "request".
 */
export async function codexSessionPrompts(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const thread = environment.CODEX_THREAD_ID;
  if (!thread || !/^[A-Za-z0-9-]+$/.test(thread)) return [];
  const home = environment.CODEX_HOME ?? join(homedir(), ".codex");
  const file = await findRollout(join(home, "sessions"), thread, 3);
  if (!file) return [];
  const text = await readFile(file, "utf8").catch(() => "");
  const items: string[] = [];
  const messages: string[] = [];
  for (const line of text.split("\n")) {
    const prompt = rolloutUserMessage(line);
    if (prompt) (prompt.form === "item" ? items : messages).push(prompt.text);
  }
  return items.length ? items : messages;
}

interface RolloutEvent {
  readonly type?: string;
  readonly payload?: {
    readonly type?: string;
    readonly message?: unknown;
    readonly item?: { readonly type?: string; readonly content?: { readonly text?: unknown }[] };
  };
}

function rolloutUserMessage(line: string): { form: "item" | "message"; text: string } | undefined {
  let event: RolloutEvent;
  try {
    event = JSON.parse(line) as RolloutEvent;
  } catch {
    return undefined;
  }
  if (event.type !== "event_msg") return undefined;
  const item = event.payload?.item;
  if (typeof item?.type === "string" && /^user_?message$/i.test(item.type)) {
    const joined = (item.content ?? [])
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("");
    return joined.trim() ? { form: "item", text: joined } : undefined;
  }
  const message = event.payload?.message;
  return event.payload?.type === "user_message" && typeof message === "string" && message.trim()
    ? { form: "message", text: message }
    : undefined;
}

async function findRollout(
  directory: string,
  thread: string,
  depth: number,
): Promise<string | undefined> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const match = entries.find((entry) => entry.isFile() && entry.name.endsWith(`${thread}.jsonl`));
  if (match) return join(directory, match.name);
  if (depth === 0) return undefined;
  // Newest date directories first.
  for (const entry of entries
    .filter((item) => item.isDirectory())
    .sort((a, b) => b.name.localeCompare(a.name))) {
    const found = await findRollout(join(directory, entry.name), thread, depth - 1);
    if (found) return found;
  }
  return undefined;
}

function normalized(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

async function activeHostSessions(workspace: WorkspaceState): Promise<Result<Set<string>>> {
  const entries = await workspace.files.listDir(join(workspace.paths.sessionDir, "hosts"));
  if (!entries.ok) return entries;
  const active = new Set<string>();
  for (const entry of entries.value.filter((name) => name.endsWith(".json"))) {
    const read = await workspace.files.readTextIfExists(
      join(workspace.paths.sessionDir, "hosts", entry),
    );
    if (!read.ok) return read;
    try {
      const item = JSON.parse(read.value ?? "{}");
      if (typeof item.session === "string" && Date.now() - Date.parse(item.at) < 60 * 60 * 1000)
        active.add(item.session);
    } catch {
      /* An interrupted heartbeat is not a caller identity. */
    }
  }
  return ok(active);
}
