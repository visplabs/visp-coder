import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { resolveCriticDefault } from "../config/critic-defaults.js";
import { DIR, PRODUCT_NAME, STATE_DIR } from "../core/constants.js";
import { isExecutableMode } from "../core/mode.js";
import {
  agentActivationFile,
  planAgentActivation,
  planAgentDeactivation,
  requiresAgentActivation,
} from "../harness/activation.js";
import {
  assetFingerprint,
  CLAUDE_SETTINGS_REGISTRATION,
  inspectForeignHarnessAssets,
  isCurrentAsset,
  readAssetManifest,
} from "../harness/asset-inspection.js";
import {
  CLAUDE_SETTINGS_FILE,
  hasClaudeSessionHooks,
  hookCommand,
  inspectPreToolUseResidue,
  preToolUseRegistration,
} from "../harness/claude-settings.js";
import {
  codexRegistrationAdvice,
  codexRegistrationProblem,
} from "../harness/codex-mcp-registration.js";
import { preCommitHookPath } from "../harness/git-hook.js";
import { verifyGuardHandshake } from "../harness/guard-handshake.js";
import {
  CODEX_HOOK_SCRIPT,
  HOOK_MARKER,
  isCurrentGeneratedHook,
  renderPreCommitHook,
  renderPreToolUseHook,
} from "../harness/hooks.js";
import { type InstallState, readInstallState } from "../harness/install-state.js";
import { verifyRequestedMcp } from "../harness/install-verification.js";
import {
  CODEX_CONFIG_FILE,
  mcpConfigFile,
  planMcpRegistration,
} from "../harness/mcp-registration.js";
import { type Asset, planFor } from "../harness/targets.js";
import type { WorkspaceState } from "../workflow/state.js";
import type { Check, DoctorRuntime } from "./checks.js";

/**
 * Absence is not the only way an asset stops working. A file visp wrote and has
 * since changed the template for is stale, and looks identical to a healthy one
 * from a directory listing — so compare content, not just presence.
 */
export async function checkHarnessAssets(state: WorkspaceState): Promise<Check> {
  const installation = await readInstallState(state.paths, state.files);
  if (!installation.ok) {
    return {
      name: "harness assets",
      status: "fail",
      detail: installation.error.message,
      recovery: `${PRODUCT_NAME} install`,
    };
  }
  const profile =
    installation.value?.harness === state.config.harness
      ? installation.value.profile
      : state.config.profile;
  const critic = await resolveCriticDefault(state.config.harness, state.config.critic);
  if (!critic.ok) {
    return {
      name: "harness assets",
      status: "unknown",
      detail: critic.error.message,
      recovery: `${PRODUCT_NAME} install`,
    };
  }
  const plan = planFor(state.config.harness, profile, critic.value ?? null);
  const manifest = await readAssetManifest(state.paths);
  const recorded = manifest.ok ? manifest.value : {};

  const { missing, stale, edited } = await inspectHarnessAssetFiles(state, plan.assets, recorded);

  const note =
    edited.length > 0 ? `; edited by you, left alone: ${edited.slice(0, 3).join(", ")}` : "";

  if (missing.length > 0) {
    return {
      name: "harness assets",
      status: "warn",
      detail: `Missing for ${state.config.harness}: ${missing.slice(0, 3).join(", ")}${note}`,
      recovery: `${PRODUCT_NAME} install`,
    };
  }

  if (stale.length > 0) {
    return {
      name: "harness assets",
      status: "warn",
      detail: `Stale for ${state.config.harness}: ${stale.slice(0, 3).join(", ")}${note}`,
      recovery: `${PRODUCT_NAME} install --force`,
    };
  }

  if (edited.length > 0) {
    return {
      name: "harness assets",
      status: "warn",
      detail: `Edited for ${state.config.harness}: ${edited.slice(0, 3).join(", ")}; edited by you, left alone`,
      recovery: `Review the preserved files; run ${PRODUCT_NAME} install --force only if VISP should replace them`,
    };
  }

  return {
    name: "harness assets",
    status: "ok",
    detail: `${state.config.harness} assets are installed${note}`,
  };
}

export async function checkMcpRegistration(state: WorkspaceState): Promise<Check> {
  const recorded = await readInstallState(state.paths, state.files);
  if (!recorded.ok)
    return { name: "mcp registration", status: "unknown", detail: recorded.error.message };
  if (!recorded.value?.mcp || recorded.value.harness !== state.config.harness)
    return {
      name: "mcp registration",
      status: "ok",
      detail: "No MCP registration requested for this harness",
    };
  const path = mcpConfigFile(state.config.harness);
  const verified = await verifyRequestedMcp(state.files, {
    harness: state.config.harness,
    mcp: true,
  });
  if (verified.ok)
    return { name: "mcp registration", status: "ok", detail: `${path} registers VISP` };
  // `doctor --fix` never rewrites a Codex table VISP did not write, so advising it would loop.
  const customized = await customizedCodexEntry(state);
  if (customized)
    return {
      name: "mcp registration",
      status: "warn",
      detail: `${path} ${codexRegistrationProblem(customized.unreadable)}`,
      recovery: `In ${path}, ${codexRegistrationAdvice(customized.unreadable)}`,
    };
  return {
    name: "mcp registration",
    status: "warn",
    detail: `${path} does not contain a usable VISP MCP registration`,
    recovery: `${PRODUCT_NAME} doctor --fix`,
  };
}

async function customizedCodexEntry(
  state: WorkspaceState,
): Promise<{ readonly unreadable: boolean } | undefined> {
  if (state.config.harness !== "codex") return undefined;
  const current = await state.files.readTextIfExists(CODEX_CONFIG_FILE);
  if (!current.ok) return undefined;
  const planned = planMcpRegistration(current.value, false, "codex");
  return planned.ok && planned.value.status === "customized"
    ? { unreadable: planned.value.unreadable === true }
    : undefined;
}

async function inspectHarnessAssetFiles(
  state: WorkspaceState,
  assets: readonly Asset[],
  recorded: Readonly<Record<string, string>>,
): Promise<{ missing: string[]; stale: string[]; edited: string[] }> {
  const result = { missing: [] as string[], stale: [] as string[], edited: [] as string[] };
  for (const asset of assets) {
    const current = await state.files.readTextIfExists(asset.path);
    if (!current.ok || current.value === undefined) {
      result.missing.push(asset.path);
      continue;
    }
    if (isCurrentAsset(current.value, asset)) continue;

    // Matching what we recorded means visp wrote it and the template has since
    // moved on. Anything else is the user's edit, which is theirs to keep.
    const destination =
      recorded[asset.path] === assetFingerprint(current.value) ? result.stale : result.edited;
    destination.push(asset.path);
  }
  return result;
}

export async function checkHarnessActivation(state: WorkspaceState): Promise<Check> {
  if (state.config.harness === "generic")
    return {
      name: "harness activation",
      status: "warn",
      detail: "Generic hosts do not load AGENTS.visp.md automatically",
      recovery: "Point your coding agent at AGENTS.visp.md or paste it into its system prompt",
    };
  if (!requiresAgentActivation(state.config.harness)) {
    return {
      name: "harness activation",
      status: "ok",
      detail: `${state.config.harness} does not require a managed AGENTS.md reference`,
    };
  }

  const current = await state.files.readTextIfExists(agentActivationFile(state.config.harness));
  if (!current.ok) {
    return {
      name: "harness activation",
      status: "unknown",
      detail: `Could not inspect ${agentActivationFile(state.config.harness)}: ${current.error.message}`,
      recovery: `${PRODUCT_NAME} install`,
    };
  }
  const activation = planAgentActivation(state.config.harness, current.value, false);
  if (!activation.ok) {
    return {
      name: "harness activation",
      status: "fail",
      detail: activation.error.message,
      recovery: `${PRODUCT_NAME} install --force`,
    };
  }
  return activation.value.status === "current"
    ? {
        name: "harness activation",
        status: "ok",
        detail: `${agentActivationFile(state.config.harness)} activates ${state.config.harness} instructions`,
      }
    : {
        name: "harness activation",
        status: "warn",
        detail: `${agentActivationFile(state.config.harness)} does not activate the installed VISP guide`,
        recovery: `${PRODUCT_NAME} install`,
      };
}

export async function checkPreviousHarnessAssets(state: WorkspaceState): Promise<Check> {
  const found = await inspectForeignHarnessAssets(state.paths, state.config.harness);
  if (!found.ok) {
    return {
      name: "previous harness assets",
      status: "unknown",
      detail: `Could not inspect prior assets: ${found.error.message}`,
    };
  }
  const owned = [
    ...found.value.owned,
    ...(found.value.claudeRegistration ? [CLAUDE_SETTINGS_REGISTRATION] : []),
    ...found.value.mcpRegistrations.map(({ path }) => `${path} (VISP MCP registration)`),
  ];
  const edited = [...found.value.edited];
  await collectPreviousActivations(state, owned, edited);
  const manual = [...edited, ...found.value.unrecognized];
  if (owned.length === 0 && manual.length === 0) {
    return {
      name: "previous harness assets",
      status: "ok",
      detail: "No previous-harness residue found",
    };
  }
  // Keep active hooks and registrations visible when adding another host asset.
  owned.sort(
    (a, b) => Number(/registration|hooks\//.test(b)) - Number(/registration|hooks\//.test(a)),
  );
  const detail = [
    ...(owned.length > 0
      ? [
          `VISP-owned assets for another harness remain: ${owned.slice(0, 3).join(", ")}${owned.length > 3 ? ` (+${owned.length - 3} more)` : ""}`,
        ]
      : []),
    ...(manual.length > 0
      ? [
          `Edited or unrecognized previous-harness files were preserved for manual review: ${manual
            .slice(0, 3)
            .join(", ")}`,
        ]
      : []),
  ].join(". ");
  return {
    name: "previous harness assets",
    status: "warn",
    detail,
    recovery:
      owned.length > 0
        ? `${PRODUCT_NAME} install --prune-previous-harness; review preserved files manually`
        : "Review the preserved files and remove them manually only if they are obsolete",
  };
}

async function collectPreviousActivations(
  state: WorkspaceState,
  owned: string[],
  edited: string[],
): Promise<void> {
  for (const path of ["AGENTS.md", "CLAUDE.md"]) {
    if (
      requiresAgentActivation(state.config.harness) &&
      path === agentActivationFile(state.config.harness)
    )
      continue;
    const current = await state.files.readTextIfExists(path);
    if (!current.ok) continue;
    const status = planAgentDeactivation(current.value).status;
    if (status === "removed") owned.push(`${path} (VISP activation block)`);
    if (status === "edited") edited.push(`${path} (edited VISP activation block)`);
  }
}

/**
 * The surfaces that actually refuse an out-of-scope change. Everything else in
 * this report describes what visp knows; this describes whether anything acts
 * on it. A project with none of these installed is running unenforced, and
 * saying otherwise would be the exact failure the tool exists to prevent.
 */
export async function checkEnforcement(
  state: WorkspaceState,
  runtime: DoctorRuntime,
): Promise<Check> {
  const requested = await readInstallState(state.paths, state.files);
  if (!requested.ok) {
    return {
      name: "enforcement",
      status: "fail",
      detail: requested.error.message,
      recovery: `${PRODUCT_NAME} install`,
    };
  }
  const installation =
    requested.value?.harness === state.config.harness ? requested.value : undefined;
  const surfaces = await inspectEnforcementSurfaces(state, installation);

  if (installation?.hooks.every((hook) => hook === "ci")) {
    return {
      name: "enforcement",
      status: "warn",
      detail:
        "Nothing enforces scope locally because local hooks were explicitly omitted" +
        (installation.hooks.includes("ci") ? "; generated CI remains the requested boundary" : ""),
    };
  }

  // Both hooks shell out to `visp`. Installed but unrunnable is worse than not
  // installed: the edit hook denies every write when it cannot check, and the
  // pre-commit hook refuses an active task's commit. Only worth asking once a surface
  // that would run it exists.
  const inspectionCouldNotRun = surfaces.inactive.some((surface) =>
    surface.includes("configured path could not be resolved"),
  );
  const runtimeProblem =
    surfaces.active.length > 0 || inspectionCouldNotRun
      ? await guardRuntimeProblem(state.paths.root, runtime)
      : undefined;
  if (runtimeProblem) {
    return {
      name: "enforcement",
      status: "fail",
      detail: `${surfaces.active.length ? `${surfaces.active.join(", ")} installed, but ` : "Guard availability could not be established: "}${runtimeProblem.message}`,
      recovery: runtimeProblem.recovery ?? `${PRODUCT_NAME} guard --handshake --json`,
    };
  }

  if (
    ["cursor", "copilot", "opencode", "generic"].includes(state.config.harness) &&
    surfaces.inactive.length === 0
  ) {
    return {
      name: "enforcement",
      status: "warn",
      detail: `Git pre-commit checks commits, but ${state.config.harness} has no installed host edit, prompt or Stop hook${installation?.hooks.includes("ci") ? "; CI checks pull requests" : ""}`,
      recovery: "Run visp done before committing; use visp doctor to inspect local hooks",
    };
  }

  if (surfaces.inactive.length === 0) {
    const codexUnchecked =
      state.config.harness === "codex" && !surfaces.active.some((s) => s.startsWith("edit hook"));
    return {
      name: "enforcement",
      status: codexUnchecked ? "warn" : "ok",
      detail: `Refusals are enforced by local guardrails: ${surfaces.active.join(", ")}${installation?.hooks.includes("ci") ? ". CI checks pull requests" : ""}${codexUnchecked ? ". Codex scope checks are commit-time only (the apply_patch edit hook is not installed)" : ""}`,
    };
  }

  return {
    name: "enforcement",
    status: "warn",
    detail:
      surfaces.active.length === 0
        ? `Nothing enforces scope: ${surfaces.inactive.join(", ")} not installed`
        : `Active: ${surfaces.active.join(", ")}. Not installed: ${surfaces.inactive.join(", ")}`,
    recovery: `${PRODUCT_NAME} doctor --fix`,
  };
}

interface EnforcementSurfaces {
  readonly active: string[];
  readonly inactive: string[];
}

async function inspectEnforcementSurfaces(
  state: WorkspaceState,
  installation?: InstallState,
): Promise<EnforcementSurfaces> {
  const surfaces: EnforcementSurfaces = { active: [], inactive: [] };
  const wantsClaude = installation
    ? installation.hooks.includes("claude")
    : state.config.harness === "claude-code";
  const wantsGit = installation ? installation.hooks.includes("git") : true;
  if (state.config.harness === "claude-code" && wantsClaude) {
    addSurface(surfaces, await inspectClaudeEditHook(state));
  }
  if (state.config.harness === "codex") {
    addSurface(surfaces, await inspectCodexEditHook(state));
  }
  if (wantsGit) addSurface(surfaces, await inspectPreCommitHook(state));
  return surfaces;
}

interface SurfaceState {
  readonly active?: string;
  readonly inactive?: string;
}

function addSurface(surfaces: EnforcementSurfaces, state: SurfaceState): void {
  if (state.active) surfaces.active.push(state.active);
  if (state.inactive) surfaces.inactive.push(state.inactive);
}

/**
 * Codex's edit hook is an `apply_patch` entry in `.codex/hooks.json` that runs the generated
 * script. Whether Codex trusts the entry is the separate "codex hooks trust" check. A missing
 * hook is reported by leaving the surface out, which keeps the commit-time warning.
 */
async function inspectCodexEditHook(state: WorkspaceState): Promise<SurfaceState> {
  const script = await state.files.readTextIfExists(CODEX_HOOK_SCRIPT);
  const registered = await state.files.readTextIfExists(".codex/hooks.json");
  if (!script.ok || script.value === undefined || !registered.ok) return {};
  return hasCodexEditEntry(registered.value) ? { active: "edit hook (apply_patch)" } : {};
}

function hasCodexEditEntry(text: string | undefined): boolean {
  if (text === undefined) return false;
  try {
    const entries: unknown = JSON.parse(text)?.hooks?.PreToolUse;
    return (
      Array.isArray(entries) &&
      entries.some(
        (entry) =>
          entry?.matcher === "apply_patch" &&
          JSON.stringify(entry.hooks ?? []).includes("codex-hooks.mjs"),
      )
    );
  } catch {
    return false;
  }
}

async function inspectClaudeEditHook(state: WorkspaceState): Promise<SurfaceState> {
  const hookPath = `${STATE_DIR}/${DIR.hooks}/claude-pretooluse.mjs`;
  const script = await state.files.readTextIfExists(hookPath);
  if (!script.ok || script.value === undefined) return missingEditHook(state, hookPath);
  if (!isCurrentGeneratedHook(script.value, renderPreToolUseHook))
    return { inactive: "edit hook (stale or edited)" };
  const metadata = await state.files.metadata(hookPath);
  if (!metadata.ok || !isExecutableMode(metadata.value?.mode)) {
    return { inactive: "edit hook (not executable)" };
  }

  const wired = await preToolUseRegistration(state.paths.root, hookPath);
  const registration = wired.ok ? wired.value : "absent";
  if (registration === "present") {
    const settings = await state.files.readTextIfExists(CLAUDE_SETTINGS_FILE);
    if (!settings.ok || !hasClaudeSessionHooks(settings.value, hookPath))
      return { inactive: "prompt, Stop or Bash hook (settings registration is missing)" };
    // Claude Code runs the command with Git Bash on Windows, which doctor cannot locate
    // reliably (a `bash` on PATH may be WSL's), so there it checks that node runs the script.
    const check = spawnSync(
      process.platform === "win32" ? "node" : "/bin/sh",
      process.platform === "win32"
        ? [join(state.paths.root, hookPath)]
        : ["-c", hookCommand(hookPath, true)],
      {
        cwd: state.paths.root,
        env: { ...process.env, CLAUDE_PROJECT_DIR: state.paths.root },
        input: "{}",
        encoding: "utf8",
        timeout: 5_000,
      },
    );
    return check.status === 0
      ? { active: "edit hook (edit tools only), prompt, Stop and Bash hooks" }
      : { inactive: "edit hook (registered command cannot start)" };
  }
  if (registration === "malformed") {
    return { inactive: `edit hook (${CLAUDE_SETTINGS_FILE} is not valid JSON)` };
  }
  if (registration === "customized") {
    return { inactive: "edit hook (settings registration is stale or edited)" };
  }
  return { inactive: "edit hook (script written, not wired into settings)" };
}

/** Settings are committed, the script is not: what the settings still run without it. */
async function missingEditHook(state: WorkspaceState, hookPath: string): Promise<SurfaceState> {
  const settings = await state.files.readTextIfExists(CLAUDE_SETTINGS_FILE);
  if (!settings.ok) return { inactive: "edit hook" };
  const residue = inspectPreToolUseResidue(settings.value, hookPath);
  if (residue.current)
    return {
      inactive: `edit hook (script missing; Claude Code refuses writes while a slice is authorized, until ${PRODUCT_NAME} install restores it)`,
    };
  // An earlier build ran the script directly, with no fallback for a missing one.
  if (residue.exact)
    return {
      inactive: `edit hook (script missing; settings run an earlier VISP command, which fails every edit until ${PRODUCT_NAME} install)`,
    };
  return residue.customized
    ? { inactive: "edit hook (script missing; settings registration is stale or edited)" }
    : { inactive: "edit hook" };
}

async function inspectPreCommitHook(state: WorkspaceState): Promise<SurfaceState> {
  const resolved = await preCommitHookPath(state.paths.root);
  if (!resolved.ok) return { inactive: "pre-commit (configured path could not be resolved)" };
  const hook = await state.files.readTextIfExists(resolved.value.absolute);
  if (!hook.ok) return { inactive: `pre-commit (${hook.error.message})` };
  const local = await state.files.readTextIfExists(`${resolved.value.absolute}.local`);
  if (!local.ok) return { inactive: `pre-commit (${local.error.message})` };
  if (
    hook.value !== undefined &&
    isCurrentGeneratedHook(hook.value, (cli) => renderPreCommitHook(local.value !== undefined, cli))
  ) {
    const metadata = await state.files.metadata(resolved.value.absolute);
    if (metadata.ok && isExecutableMode(metadata.value?.mode)) return { active: "pre-commit" };
    return { inactive: "pre-commit (not executable)" };
  }
  if (hook.ok && (hook.value ?? "").includes(HOOK_MARKER)) {
    return { inactive: "pre-commit (stale or edited)" };
  }
  if (hook.ok && hook.value !== undefined) {
    return { inactive: "pre-commit (a hook is there, but not this one)" };
  }
  return { inactive: "pre-commit" };
}

async function guardRuntimeProblem(root: string, runtime: DoctorRuntime) {
  const handshake = await (runtime.guardHandshake ?? verifyGuardHandshake)(root);
  return handshake.ok ? undefined : handshake.error;
}
