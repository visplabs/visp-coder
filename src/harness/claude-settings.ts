import { isDeepStrictEqual } from "node:util";
import { DIR, PRODUCT_NAME, STATE_DIR } from "../core/constants.js";
import { ProjectFileSystem } from "../core/fs.js";
import { ok, type Result } from "../core/result.js";
import { removeJsoncMember, setJsoncMember } from "./jsonc-edit.js";

/**
 * Registers the PreToolUse hook in the project's `.claude/settings.json`,
 * merging into whatever is already there. Writing the hook script without
 * wiring it up installs nothing: Claude Code only runs hooks this file names,
 * so leaving the wiring to the user means the enforcement surface is off by
 * default and no one finds out.
 *
 * Other hooks are left untouched, on the same reasoning as `mcp-registration`:
 * clobbering a project's configuration to add one entry is a poor trade.
 */

export const CLAUDE_SETTINGS_FILE = ".claude/settings.json";
export const CLAUDE_PRE_TOOL_USE_HOOK = ".visp/hooks/claude-pretooluse.mjs";

/** Tools that write files, and so must be checked before they run. */
export const PRE_TOOL_USE_MATCHER = "Edit|Write|NotebookEdit";

export type RegistrationStatus = "added" | "current" | "customized" | "replaced" | "malformed";

/** Whether the wiring is in place, for `doctor` to report. */
export type RegistrationState = "present" | "absent" | "customized" | "malformed";

interface HookEntry {
  matcher?: string;
  hooks?: { type?: string; command?: string; timeout?: number }[];
  [key: string]: unknown;
}

interface ClaudeSettings {
  hooks?: { PreToolUse?: HookEntry[]; UserPromptSubmit?: unknown; [event: string]: unknown };
  [key: string]: unknown;
}

/**
 * The lean worker's compaction (`workflow.autoCompact`): compact at 90% of a 100k-token window,
 * so the session stays under the 100k prompt size where every Haiku 5.5 price is 5 times higher.
 * In batch leandef2 the lean worker spent 15 to 23 turns above it on the larger task, and that
 * premium was 65% of its cost. Names and ranges: code.claude.com/docs/en/env-vars.
 */
export const COMPACTION_ENV = {
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000",
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "90",
} as const;

/**
 * `current` with the compaction variables set (`on`) or VISP's values removed. A value the
 * project set differently is its own and stays, as does unparseable text (returned unchanged).
 */
export function withCompactionEnv(current: string | undefined, on: boolean): string | undefined {
  const parsed = parseSettings(current);
  if (parsed === "malformed") return current;
  const env = parsed.env;
  if (env !== undefined && (typeof env !== "object" || env === null || Array.isArray(env)))
    return current;
  const values = (env ?? {}) as Record<string, unknown>;
  const start = current?.trim() ? current : "{}\n";
  let text = start;
  for (const [name, value] of Object.entries(COMPACTION_ENV)) {
    if (on && values[name] === undefined) text = setJsoncMember(text, ["env", name], value) ?? text;
    if (!on && values[name] === value) text = removeJsoncMember(text, ["env", name], true) ?? text;
  }
  const next = parseSettings(text);
  // An env object only VISP's values filled goes with them.
  if (!on && text !== start && next !== "malformed" && isDeepStrictEqual(next.env, {}))
    text = removeJsoncMember(text, ["env"], true) ?? text;
  return text === start ? current : text;
}

/** Authorization marker directories under `.visp/state`, as the pre-commit fallback reads them. */
const PRODUCT_AUTHORIZATIONS = "product-authorizations";
const IMPLEMENT_MARKERS = "implement-allowed";

/**
 * The command Claude Code runs. Relative to the project, so it survives a move.
 *
 * The script exits 0 on every path it handles, so `|| exit 2` only turns a crash or a
 * missing `node` (GUI-launched hosts often lack the shell's node) into a block. That is
 * wanted on the edit matcher, the scope-enforcement point, and harmful elsewhere: on a
 * prompt it erases the user's message, on Stop it forces the worker to continue, on a
 * shell command it blocks every command.
 *
 * This file is committed but the script is not (`.visp/hooks/` is per checkout), so a fresh
 * clone runs the command with no script. Then only the authorization state decides, in plain
 * sh so it works without node: no state means no slice can be authorized and Claude Code's
 * own permission decision stands; a marker, or state that cannot be read (a link, no
 * permission), refuses the write. A leftover marker from a closed slice also refuses, until
 * `visp install` restores the script, which reads it exactly. The other events stay quiet.
 *
 * Claude Code runs shell-form hooks with `sh -c`, and with Git Bash on Windows, so the same
 * POSIX text serves every platform.
 */
export function hookCommand(hookPath: string, failClosed: boolean): string {
  const script = `h="$CLAUDE_PROJECT_DIR/${hookPath}"`;
  if (!failClosed) return `${script}; [ ! -f "$h" ] || node "$h"`;
  const refusal = `${PRODUCT_NAME}: ${hookPath} is missing and a VISP slice may be authorized, so this write was refused. Run ${PRODUCT_NAME} install --harness claude-code (or ${PRODUCT_NAME} doctor --fix), then retry. Do not edit ${CLAUDE_SETTINGS_FILE}.`;
  return [
    script,
    `if [ -f "$h" ]; then node "$h" || exit 2; else s="$CLAUDE_PROJECT_DIR/${STATE_DIR}/${DIR.state}"; r=`,
    `for d in "$s" "$s/${PRODUCT_AUTHORIZATIONS}" "$s/${IMPLEMENT_MARKERS}"; do if [ -L "$d" ] || { [ -e "$d" ] && ! { [ -r "$d" ] && [ -x "$d" ]; }; }; then r=1; fi; done`,
    `for m in "$s"/${PRODUCT_AUTHORIZATIONS}/*.json "$s"/${IMPLEMENT_MARKERS}/*.json; do if [ -e "$m" ] || [ -L "$m" ]; then r=1; fi; done`,
    `if [ -n "$r" ]; then echo "${refusal}" >&2; exit 2; fi; fi`,
  ].join("; ");
}

/** What earlier builds wrote: the script run directly, and cmd.exe syntax on Windows. */
function legacyHookCommands(hookPath: string): string[] {
  const posix = `node "$CLAUDE_PROJECT_DIR/${hookPath}"`;
  const windows = `node "%CLAUDE_PROJECT_DIR%\\${hookPath.replaceAll("/", "\\")}"`;
  return [posix, `${posix} || exit 2`, windows, `${windows} || exit /b 2`];
}

/**
 * The same script records each user prompt, so `visp feature` has the verbatim request,
 * and on Stop sends a worker back to an unfinished feature. `visp next` may wait for a
 * running review, so Stop gets a longer timeout than the 60 s default.
 */
function sessionEntries(hookPath: string): Record<"UserPromptSubmit" | "Stop", HookEntry> {
  return {
    UserPromptSubmit: { hooks: [{ type: "command", command: hookCommand(hookPath, false) }] },
    Stop: { hooks: [{ type: "command", command: hookCommand(hookPath, false), timeout: 180 }] },
  };
}

/** Shell commands that would delete VISP state are checked by the same script. */
function shellEntryFor(hookPath: string): HookEntry {
  return { matcher: "Bash", hooks: [{ type: "command", command: hookCommand(hookPath, false) }] };
}

/** The shell entry VISP generates, in any build: the Bash matcher pointing at the hook script. */
function isGeneratedShellEntry(entry: HookEntry, hookPath: string): boolean {
  return entry.matcher === "Bash" && referencesHook(entry, hookPath);
}

/** Other hooks for these events stay; VISP's own entries are replaced by generated ones. */
function withPromptHook(settings: ClaudeSettings, hookPath: string): ClaudeSettings {
  const hooks: Record<string, unknown> = { ...(settings.hooks ?? {}) };
  for (const [event, expected] of Object.entries(sessionEntries(hookPath))) {
    const current = Array.isArray(hooks[event]) ? (hooks[event] as HookEntry[]) : [];
    hooks[event] = [...current.filter((entry) => !referencesHook(entry, hookPath)), expected];
  }
  const tools = Array.isArray(hooks.PreToolUse) ? (hooks.PreToolUse as HookEntry[]) : [];
  const shell = shellEntryFor(hookPath);
  hooks.PreToolUse = [...tools.filter((entry) => !isGeneratedShellEntry(entry, hookPath)), shell];
  return { ...settings, hooks: hooks as ClaudeSettings["hooks"] };
}

function withoutPromptHook(settings: ClaudeSettings, hookPath: string): ClaudeSettings {
  const hooks: Record<string, unknown> = { ...(settings.hooks ?? {}) };
  for (const event of Object.keys(sessionEntries(hookPath))) {
    if (!Array.isArray(hooks[event])) continue;
    // By reference, so an entry an older build generated (with a different exit code) goes too.
    const remaining = (hooks[event] as HookEntry[]).filter(
      (entry) => !referencesHook(entry, hookPath),
    );
    if (remaining.length) hooks[event] = remaining;
    else delete hooks[event];
  }
  if (Array.isArray(hooks.PreToolUse)) {
    hooks.PreToolUse = (hooks.PreToolUse as HookEntry[]).filter(
      (entry) => !isGeneratedShellEntry(entry, hookPath),
    );
  }
  return { ...settings, hooks: hooks as ClaudeSettings["hooks"] };
}

function hasPromptHook(settings: ClaudeSettings, hookPath: string): boolean {
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const shell = shellEntryFor(hookPath);
  const tools = Array.isArray(hooks.PreToolUse) ? (hooks.PreToolUse as HookEntry[]) : [];
  if (!tools.some((entry) => isDeepStrictEqual(entry, shell))) return false;
  return Object.entries(sessionEntries(hookPath)).every(
    ([event, expected]) =>
      Array.isArray(hooks[event]) &&
      (hooks[event] as HookEntry[]).some((entry) => isDeepStrictEqual(entry, expected)),
  );
}

export function hasClaudeSessionHooks(current: string | undefined, hookPath: string): boolean {
  const settings = parseSettings(current);
  return settings !== "malformed" && hasPromptHook(settings, hookPath);
}

function entryFor(hookPath: string, command = hookCommand(hookPath, true)): HookEntry {
  return { matcher: PRE_TOOL_USE_MATCHER, hooks: [{ type: "command", command }] };
}

/** The edit entry this build or an earlier one generated: replaced and removed without --force. */
function isGeneratedEditEntry(entry: HookEntry, hookPath: string): boolean {
  return [hookCommand(hookPath, true), ...legacyHookCommands(hookPath)].some((command) =>
    isDeepStrictEqual(entry, entryFor(hookPath, command)),
  );
}

export interface PlannedClaudeRegistration {
  readonly status: RegistrationStatus;
  readonly content?: string;
  /** The rewrite dropped structure the file had (unparseable text or a malformed hooks value). */
  readonly discarded?: true;
}

export type UnregistrationStatus = "absent" | "removed" | "customized" | "malformed";

export interface PlannedClaudeUnregistration {
  readonly status: UnregistrationStatus;
  readonly content?: string;
}

export interface PreToolUseResidue {
  /** An edit entry this build or an earlier one generated, so removable without review. */
  readonly exact: boolean;
  /** This build's edit entry. */
  readonly current: boolean;
  readonly customized: boolean;
  readonly malformed: boolean;
}

const MALFORMED_RESIDUE: PreToolUseResidue = {
  exact: false,
  current: false,
  customized: false,
  malformed: true,
};

/** Pure registration merge for transactional installers. */
export function planPreToolUseRegistration(
  current: string | undefined,
  hookPath: string,
  force: boolean,
): Result<PlannedClaudeRegistration> {
  const parsed = parseSettings(current);

  if (parsed === "malformed") {
    // Rewriting a file we cannot parse would discard whatever it holds.
    return force
      ? ok({
          status: "replaced",
          content: formatSettings(
            withPromptHook({ hooks: { PreToolUse: [entryFor(hookPath)] } }, hookPath),
          ),
          discarded: true,
        })
      : ok({ status: "malformed" });
  }

  const settings = parsed;
  const existing = preToolUseEntries(settings);
  if (existing === "malformed") {
    return force
      ? ok({
          status: "replaced",
          content: formatSettings(
            withPromptHook(
              {
                ...settings,
                hooks: { ...siblingHooks(settings), PreToolUse: [entryFor(hookPath)] },
              },
              hookPath,
            ),
          ),
          discarded: true,
        })
      : ok({ status: "malformed" });
  }
  const expected = entryFor(hookPath);
  const exact = existing.findIndex((entry) => isDeepStrictEqual(entry, expected));
  if (exact !== -1)
    return hasPromptHook(settings, hookPath)
      ? ok({ status: "current" })
      : ok({ status: "replaced", content: formatSettings(withPromptHook(settings, hookPath)) });

  const { mine, generated } = ownEditEntry(existing, hookPath);
  if (mine !== -1 && !generated && !force) return ok({ status: "customized" });

  const next = [...existing];
  if (mine === -1) next.push(expected);
  else next[mine] = expected;

  return ok({
    status: mine === -1 ? "added" : "replaced",
    content: formatSettings(
      withPromptHook(
        { ...settings, hooks: { ...(settings.hooks ?? {}), PreToolUse: next } },
        hookPath,
      ),
    ),
  });
}

/** The edit entry to replace: one some build generated, else any that names the script. */
function ownEditEntry(
  existing: HookEntry[],
  hookPath: string,
): { mine: number; generated: boolean } {
  const generated = existing.findIndex((entry) => isGeneratedEditEntry(entry, hookPath));
  if (generated !== -1) return { mine: generated, generated: true };
  return { mine: existing.findIndex((entry) => referencesHook(entry, hookPath)), generated: false };
}

/** Removes only entries some VISP build generated, byte for byte, from Claude settings. */
export function planPreToolUseUnregistration(
  current: string | undefined,
  hookPath: string,
): PlannedClaudeUnregistration {
  const parsed = parseSettings(current);
  if (parsed === "malformed") return { status: "malformed" };
  const existing = preToolUseEntries(parsed);
  if (existing === "malformed") return { status: "malformed" };

  const exact = existing.filter((entry) => isGeneratedEditEntry(entry, hookPath));
  if (exact.length === 0) {
    return {
      status: existing.some((entry) => referencesHook(entry, hookPath)) ? "customized" : "absent",
    };
  }

  return {
    status: "removed",
    content: formatSettings(
      withoutPromptHook(
        {
          ...parsed,
          hooks: {
            ...(parsed.hooks ?? {}),
            PreToolUse: existing.filter((entry) => !isGeneratedEditEntry(entry, hookPath)),
          },
        },
        hookPath,
      ),
    ),
  };
}

export interface PlannedClaudeSettingsRemoval {
  readonly status: UnregistrationStatus;
  /** The settings text without VISP's entries; absent when the file would be left empty. */
  readonly content?: string;
  /** Nothing is left once VISP's entries go; `content` is then what remains of the file. */
  readonly empty?: true;
  /** An edited entry that names the hook script stays (without `force`). */
  readonly customized?: true;
}

/**
 * Uninstall: drops every entry some VISP build generated, byte for byte (or, with `force`,
 * every entry naming the script) and the containers that emptied. An entry the project edited
 * stays and is reported. Only the hook events VISP touched are re-rendered; the rest of the
 * file keeps its bytes, so a project's own settings and layout survive.
 */
export function planClaudeSettingsRemoval(
  current: string | undefined,
  hookPath: string,
  force: boolean,
): PlannedClaudeSettingsRemoval {
  if (current === undefined || current.trim() === "") return { status: "absent" };
  const parsed = parseSettings(current);
  if (parsed === "malformed") return { status: "malformed" };
  if (preToolUseEntries(parsed) === "malformed") return { status: "malformed" };

  const owned = (event: string, entry: HookEntry) =>
    force ? referencesHook(entry, hookPath) : isGeneratedEntry(event, entry, hookPath);
  const hooks: Record<string, unknown> = { ...siblingHooks(parsed) };
  let customized = false;
  for (const event of ["PreToolUse", ...Object.keys(sessionEntries(hookPath))]) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    const kept = (entries as HookEntry[]).filter((entry) => !owned(event, entry));
    customized ||= kept.some((entry) => referencesHook(entry, hookPath));
    hooks[event] = kept;
  }
  const next = withoutEmptyHooks({ ...parsed, hooks: hooks as ClaudeSettings["hooks"] }, parsed);
  const flag = customized ? ({ customized: true } as const) : {};
  if (isDeepStrictEqual(next, parsed)) {
    return customized ? { status: "customized", customized: true } : { status: "absent" };
  }
  return {
    status: "removed",
    content: spanEdited(current, parsed, next),
    ...(Object.keys(next).length === 0 ? { empty: true as const } : {}),
    ...flag,
  };
}

/** Every command a VISP build has generated for these hooks. */
function generatedCommands(hookPath: string): string[] {
  return [
    hookCommand(hookPath, false),
    hookCommand(hookPath, true),
    ...legacyHookCommands(hookPath),
  ];
}

/** An entry exactly as some VISP build generated it for `event`. */
function isGeneratedEntry(event: string, entry: HookEntry, hookPath: string): boolean {
  const commands = generatedCommands(hookPath);
  if (event === "PreToolUse")
    return (
      isGeneratedEditEntry(entry, hookPath) ||
      commands.some((command) =>
        isDeepStrictEqual(entry, { matcher: "Bash", hooks: [{ type: "command", command }] }),
      )
    );
  const timeouts = event === "Stop" ? [undefined, 180] : [undefined];
  return commands.some((command) =>
    timeouts.some((timeout) =>
      isDeepStrictEqual(entry, {
        hooks: [{ type: "command", command, ...(timeout === undefined ? {} : { timeout }) }],
      }),
    ),
  );
}

/** Event lists and the `hooks` object that VISP emptied go; ones the project left empty stay. */
function withoutEmptyHooks(settings: ClaudeSettings, original: ClaudeSettings): ClaudeSettings {
  const hooks: Record<string, unknown> = { ...(settings.hooks ?? {}) };
  const before = siblingHooks(original);
  for (const [event, value] of Object.entries(hooks)) {
    if (Array.isArray(value) && value.length === 0 && (before[event] as unknown[])?.length !== 0)
      delete hooks[event];
  }
  const next: ClaudeSettings = { ...settings };
  const emptied = Object.keys(hooks).length === 0 && Object.keys(before).length > 0;
  if (emptied || original.hooks === undefined) delete next.hooks;
  else next.hooks = hooks as ClaudeSettings["hooks"];
  return next;
}

/**
 * `next` written into `source` by touching only the `hooks` members that differ. Falls back to
 * a whole-file rewrite when a span edit cannot be made safely or does not read back as `next`.
 */
function spanEdited(source: string, before: ClaudeSettings, next: ClaudeSettings): string {
  const text = editHooks(source, siblingHooks(before), next.hooks && siblingHooks(next));
  try {
    if (text !== undefined && isDeepStrictEqual(JSON.parse(text), next)) return text;
  } catch {
    // Fall through to the whole-file rewrite.
  }
  return formatSettings(next);
}

function editHooks(
  source: string,
  was: Record<string, unknown>,
  now: Record<string, unknown> | undefined,
): string | undefined {
  if (now === undefined) return removeJsoncMember(source, ["hooks"], true);
  let text: string | undefined = source;
  for (const event of Object.keys(was)) {
    if (text === undefined) break;
    if (!(event in now)) text = removeJsoncMember(text, ["hooks", event], true);
    else if (!isDeepStrictEqual(was[event], now[event]))
      text = setJsoncMember(text, ["hooks", event], now[event]);
  }
  return text;
}

/** Distinguishes removable generated entries from project-customized references. */
export function inspectPreToolUseResidue(
  current: string | undefined,
  hookPath: string,
): PreToolUseResidue {
  const parsed = parseSettings(current);
  if (parsed === "malformed") return MALFORMED_RESIDUE;
  const existing = preToolUseEntries(parsed);
  if (existing === "malformed") return MALFORMED_RESIDUE;

  const expected = entryFor(hookPath);
  return {
    exact: existing.some((entry) => isGeneratedEditEntry(entry, hookPath)),
    current: existing.some((entry) => isDeepStrictEqual(entry, expected)),
    customized: existing.some(
      (entry) =>
        !isGeneratedEditEntry(entry, hookPath) &&
        !isGeneratedShellEntry(entry, hookPath) &&
        referencesHook(entry, hookPath),
    ),
    malformed: false,
  };
}

/** Reports whether the hook is wired, without changing anything. */
export async function preToolUseRegistration(
  root: string,
  hookPath: string,
): Promise<Result<RegistrationState>> {
  const current = await new ProjectFileSystem(root).readTextIfExists(CLAUDE_SETTINGS_FILE);
  if (!current.ok) return current;
  const residue = inspectPreToolUseResidue(current.value, hookPath);
  if (residue.malformed) return ok("malformed");
  if (residue.current) return ok("present");
  // An earlier build's entry still runs, but not this build's command: reinstall replaces it.
  return ok(residue.exact || residue.customized ? "customized" : "absent");
}

/**
 * A path reference identifies an edited VISP entry for conflict reporting.
 * It never establishes health: only the exact generated entry is active.
 * Either separator matches: earlier builds wrote backslashes on Windows.
 */
function referencesHook(entry: HookEntry, hookPath: string): boolean {
  return Array.isArray(entry.hooks)
    ? entry.hooks.some(
        (hook) =>
          typeof hook?.command === "string" &&
          hook.command.replaceAll("\\", "/").includes(hookPath),
      )
    : false;
}

/** The other hook events, when `hooks` is a plain object; anything else holds none to keep. */
function siblingHooks(settings: ClaudeSettings): Record<string, unknown> {
  const hooks = settings.hooks;
  return typeof hooks === "object" && hooks !== null && !Array.isArray(hooks) ? hooks : {};
}

function preToolUseEntries(settings: ClaudeSettings): HookEntry[] | "malformed" {
  const hooks = settings.hooks;
  if (hooks === undefined) return [];
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return "malformed";
  const entries = hooks.PreToolUse;
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) return "malformed";
  return entries.every(
    (entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry),
  )
    ? (entries as HookEntry[])
    : "malformed";
}

function parseSettings(current: string | undefined): ClaudeSettings | "malformed" {
  if (current === undefined || current.trim() === "") return {};

  try {
    const value = JSON.parse(current) as unknown;
    // A JSON array or scalar parses but is not a settings object.
    if (typeof value !== "object" || value === null || Array.isArray(value)) return "malformed";
    return value as ClaudeSettings;
  } catch {
    return "malformed";
  }
}

function formatSettings(settings: ClaudeSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}
