import { existsSync, readFileSync } from "node:fs";
import {
  EXIT,
  GUARD_PROTOCOL_VERSION,
  PACKAGE_NAME,
  PRODUCT_NAME,
  STATE_DIR,
} from "../core/constants.js";
import { runtimeIdentity } from "../core/version.js";
import { HOST_SESSION_FILE } from "../workflow/product/host-prompts.js";
import { AUTHORIZATION_CHECK } from "./authorization-check.js";
import { hookCommand } from "./claude-settings.js";
import patchPaths from "./scripts/patch-paths.script.mjs?raw";
import preToolUseHook from "./scripts/pretooluse.script.mjs?raw";

/**
 * Enforcement surfaces. Each one shells out to `visp guard` rather than
 * reimplementing scope rules, so a refusal is identical wherever it happens and
 * updating the rules updates every surface at once.
 */

/** Identifies a file visp wrote, so install never clobbers a foreign hook. */
export const HOOK_MARKER = "managed by visp";
export const HOOK_TEMPLATE_VERSION = 18;

/**
 * Claude Code PreToolUse hook. Receives the tool call on stdin and blocks a
 * write before it happens, which is the only point where an out-of-scope edit
 * can still be prevented rather than merely reported.
 */
export function renderPreToolUseHook(executable = runtimeIdentity().executable): string {
  return fillHookTemplate(preToolUseHook, {
    MARKER: HOOK_MARKER,
    TEMPLATE_VERSION: String(HOOK_TEMPLATE_VERSION),
    PRODUCT_NAME,
    CLI: JSON.stringify(executable),
    HOST_SESSION_FILE,
    PACKAGE_NAME,
    STATE_DIR,
    EXIT_REFUSED: String(EXIT.refused),
    GUARD_PROTOCOL_VERSION: String(GUARD_PROTOCOL_VERSION),
    BUILD_ID: JSON.stringify(runtimeIdentity().buildId),
    RUNTIME_VERSION: JSON.stringify(runtimeIdentity().version).replaceAll("'", "\\u0027"),
    AUTHORIZATION_CHECK: JSON.stringify(AUTHORIZATION_CHECK),
    PATCH_PATHS: `(${patchPaths.slice(patchPaths.indexOf("function patchPaths")).trim()})`,
  });
}

/**
 * The hook source in scripts/ is plain JavaScript, so it is linted and run as written. Each
 * `__HOOK_NAME__` in it stands for a value known only when the hook is installed.
 */
function fillHookTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/__HOOK_([A-Z_]+)__/g, (token, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`Unknown hook placeholder ${token}`);
    return value;
  });
}

/** The settings block a user merges into `.claude/settings.json`. */
export function renderClaudeSettingsSnippet(hookPath: string): string {
  return JSON.stringify(
    {
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit|Write|NotebookEdit",
            hooks: [{ type: "command", command: hookCommand(hookPath, true) }],
          },
        ],
      },
    },
    null,
    2,
  );
}

/** Pre-commit hook: the last checkpoint before out-of-scope work is recorded. */
export function renderPreCommitHook(
  chained = false,
  executable = runtimeIdentity().executable,
): string {
  const installedCli = shellLiteral(executable);
  return `#!/bin/sh
# ${HOOK_MARKER}; hook-version: ${HOOK_TEMPLATE_VERSION}
# Refuses a commit whose staged files fall outside the active task's scope.
${chained ? '\n# Preserve the project hook that preceded VISP.\nif [ -x "$0.local" ]; then "$0.local" "$@" || exit $?; fi\n' : ""}

authorization_dir=".visp/state/implement-allowed"
product_authorization_dir=".visp/state/product-authorizations"
has_authorization=0

# If guard itself cannot answer, distinguish an open task from a marker left by
# an interrupted older closure. A malformed marker or graph stays conservative:
# without enough state to prove it stale, the hook treats it as active.
node_runtime=$(command -v node 2>/dev/null)
if [ -n "$node_runtime" ]; then
  authorization_state=$("$node_runtime" - "$authorization_dir" <<'VISP_AUTHORIZATION_CHECK' 2>/dev/null
${AUTHORIZATION_CHECK}
VISP_AUTHORIZATION_CHECK
  )
  case "$authorization_state" in
    active|unknown)
      has_authorization=1
      ;;
  esac
else
  # Node is unavailable too, so no safe semantic read is possible. Preserve
  # fail-closed behavior for any marker that might still be active.
  for marker in "$authorization_dir"/*.json "$product_authorization_dir"/*.json; do
    if [ -f "$marker" ]; then
      has_authorization=1
      break
    fi
  done
fi

unchecked() {
  echo "" >&2
  echo "visp could not check this commit: $1." >&2
  echo "Run '${PRODUCT_NAME} doctor' to find out why." >&2
  if [ "$has_authorization" -eq 1 ]; then
    echo "An active VISP authorization exists, so the commit was refused rather than allowed unchecked." >&2
    return 1
  fi
  echo "No VISP task is authorized, so this ordinary commit is allowed with a warning." >&2
  return 0
}

if [ -z "$node_runtime" ]; then
  unchecked "node is not on PATH"
  exit $?
fi

# --if-authorized: with no task active you are not working under visp, so
# ordinary commits are left alone.
# --include-done: work from a task visp already closed is still in the tree and
# must remain committable, or finishing a task would strand it.
output=$("$node_runtime" ${installedCli} guard --staged --if-authorized --include-done --json 2>/dev/null)

# The exit code alone cannot be trusted. A stale or corrupted CLI might also
# exit 1, the refusal code. Only a parseable guard envelope proves this check ran,
# so that is what the decision reads.
verdict=$(printf '%s' "$output" | "$node_runtime" -e '
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  try {
    const parsed = JSON.parse(raw);
    const data = parsed?.data;
    const valid =
      parsed?.command === "guard" &&
      typeof parsed.ok === "boolean" &&
      data?.protocolVersion === ${GUARD_PROTOCOL_VERSION} &&
      data.runtime?.buildId === ${JSON.stringify(runtimeIdentity().buildId)} &&
      data.runtime?.version === ${JSON.stringify(runtimeIdentity().version).replaceAll("'", "\\u0027")} &&
      Number.isInteger(data.checked) &&
      data.checked >= 0 &&
      typeof data.allowed === "boolean" &&
      Array.isArray(data.violations) &&
      Array.isArray(data.authorizedTasks) &&
      data.authorizedTasks.every((task) => typeof task === "string") &&
      (parsed.ok
        ? data.allowed === true && data.violations.length === 0
        : data.allowed === false &&
          data.violations.length > 0 &&
          data.violations.every((finding) => typeof finding?.message === "string"));
    if (!valid) { console.log("unchecked"); return; }
    if (parsed.ok) { console.log("allow"); return; }
    const first = parsed.data?.violations?.[0];
    console.log("refuse " + (first?.message ?? "changes are outside the authorized scope"));
  } catch {
    console.log("unchecked");
  }
});
' 2>/dev/null)

case "$verdict" in
  allow)
    exit 0
    ;;
  refuse*)
    echo ""
    echo "Commit refused: \${verdict#refuse }"
    echo "Adjust the task's allowedFiles, or unstage the extra files."
    exit 1
    ;;
  *)
    unchecked "the guard returned no valid result"
    exit $?
    ;;
esac
`;
}

/** A generated shell hook must not let an interpreter path become shell syntax. */
function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Whether `current` is the hook this build generates, wherever this build was installed.
 * Every hook embeds the path of the CLI that wrote it, so the same build installed at another
 * path (nvm, npx, a local node_modules) writes different bytes. The hook is re-rendered with
 * its own path: the build ID, version and template must still match exactly. The CLI it calls
 * must be this build too, since the hook refuses any other build's guard answer: another path
 * must hold this build's entry file byte for byte (its chunk names are content hashes, so
 * equal entry files mean the same build).
 */
export function isCurrentGeneratedHook(
  current: string,
  render: (executable: string) => string,
): boolean {
  const executable = embeddedExecutable(current);
  return executable !== undefined && current === render(executable) && isThisBuildEntry(executable);
}

function isThisBuildEntry(path: string): boolean {
  const own = runtimeIdentity().executable;
  if (path === own) return existsSync(path);
  try {
    return readFileSync(path).equals(readFileSync(own));
  } catch {
    return false;
  }
}

/** The CLI path a generated hook calls: the Node hooks' `cli` constant or pre-commit's guard call. */
function embeddedExecutable(hook: string): string | undefined {
  const node = /^const cli = (".*");$/m.exec(hook)?.[1];
  if (node !== undefined) {
    try {
      const parsed: unknown = JSON.parse(node);
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  const shell = /^output=\$\("\$node_runtime" '((?:[^']|'"'"')*)' guard /m.exec(hook)?.[1];
  return shell?.replaceAll(`'"'"'`, "'");
}

/**
 * Pull-request check. A fresh checkout has the committed trail — spec, plan,
 * task graph, evidence — but no implement markers, which are per-worktree. So
 * it asks the graph what the feature declared it would touch, rather than what
 * some developer's machine happened to authorize.
 *
 * The version is pinned: an unpinned install lets a new release change the
 * verdict on an unchanged repository, which is the opposite of the claim that
 * the same state produces the same answer.
 */
export function renderCiWorkflow(version: string): string {
  return `name: visp
# ${HOOK_MARKER}

on:
  pull_request:

permissions:
  contents: read

jobs:
  scope-and-evidence:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install -g ${PACKAGE_NAME}@${version}
      - name: Check the diff against what the feature declared it would touch
        # actions/checkout detaches HEAD for a pull_request, so git cannot name
        # the branch and visp is told it explicitly.
        env:
          HEAD_REF: \${{ github.head_ref }}
        run: ${PRODUCT_NAME} guard --base \${{ github.event.pull_request.base.sha }} --scope tasks --branch "$HEAD_REF"
`;
}

/**
 * Codex runs hooks through a shell from the session directory; resolve the project root.
 * The command keeps its earlier text on purpose: Codex trusts a hook by a hash of its command,
 * so changing it would make upgraded projects skip every hook silently.
 */
export const CODEX_HOOK_SCRIPT = ".visp/hooks/codex-hooks.mjs";
const CODEX_HOOK_COMMAND =
  process.platform === "win32"
    ? `for /f %i in ('git rev-parse --show-toplevel') do @node "%i\\${CODEX_HOOK_SCRIPT.replaceAll("/", "\\")}" || exit /b 2`
    : `node "$(git rev-parse --show-toplevel)/${CODEX_HOOK_SCRIPT}" || exit 2`;

/**
 * Codex reads `.codex/hooks.json` in Claude Code's format. The same script records user
 * prompts, sends a stopping worker back to unfinished work, refuses shell commands that
 * would delete VISP state and refuses apply_patch edits outside the authorized scope. Codex
 * trusts each entry by its event and position, so the edit hook is a second PreToolUse entry:
 * the shell entry a project already trusted keeps its place, and only the new one needs
 * trust. The Git hook and `visp done` still check every edit.
 */
export function renderCodexHooks(): string {
  const entry = (extra: Record<string, unknown> = {}) => ({
    hooks: [{ type: "command", command: CODEX_HOOK_COMMAND, ...extra }],
  });
  return `${JSON.stringify(
    {
      hooks: {
        UserPromptSubmit: [entry()],
        Stop: [entry({ timeout: 180 })],
        PreToolUse: [
          { matcher: "Bash", ...entry() },
          { matcher: "apply_patch", ...entry() },
        ],
      },
    },
    null,
    2,
  )}\n`;
}
