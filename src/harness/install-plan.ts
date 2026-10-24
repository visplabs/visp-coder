import { basename, dirname } from "node:path";
import { parseDocument } from "yaml";
import { balancedCritic, type CriticConfig } from "../config/critic.js";
import { resolveCriticDefault } from "../config/critic-defaults.js";
import { parseConfig } from "../config/load.js";
import type { VispConfig } from "../config/schema.js";
import { DIR, type Harness, PROFILES, type Profile, STATE_DIR } from "../core/constants.js";
import { vispError } from "../core/errors.js";
import { run } from "../core/exec.js";
import { type FileMutation, filePrecondition } from "../core/file-transaction.js";
import type { ProjectFileSystem } from "../core/fs.js";
import { isExecutableMode } from "../core/mode.js";
import type { ProjectPaths } from "../core/paths.js";
import { err, ok, type Result } from "../core/result.js";
import { requireRuntimeAgreement } from "../core/runtime-agreement.js";
import { pinnedRange, runtimeIdentity } from "../core/version.js";
import {
  agentActivationFile,
  planAgentActivation,
  planAgentDeactivation,
  requiresAgentActivation,
} from "./activation.js";
import {
  assetFingerprint,
  CLAUDE_SETTINGS_REGISTRATION,
  type ForeignHarnessAssets,
  type ForeignMcpRegistration,
  inspectForeignHarnessAssets,
  mcpRegistrationLabel,
  parseAssetManifestText,
  readAssetManifest,
  sameAssetContent,
} from "./asset-inspection.js";
import {
  CLAUDE_PRE_TOOL_USE_HOOK,
  CLAUDE_SETTINGS_FILE,
  type PlannedClaudeRegistration,
  planPreToolUseRegistration,
  planPreToolUseUnregistration,
  withCompactionEnv,
} from "./claude-settings.js";
import { codexRegistrationAdvice, codexRegistrationProblem } from "./codex-mcp-registration.js";
import { COMMAND_GUIDE_PATH, RETIRED_COMMAND_GUIDE_PATH } from "./command-guide.js";
import { preCommitHookPath } from "./git-hook.js";
import {
  HOOK_MARKER,
  renderCiWorkflow,
  renderClaudeSettingsSnippet,
  renderPreCommitHook,
  renderPreToolUseHook,
} from "./hooks.js";
import { installStateText, readInstallState } from "./install-state.js";
import type { AssetManifest, HookKind, InstallOptions, InstallPlan } from "./install-types.js";
import {
  mcpConfigFile as configFileForHarness,
  planMcpRegistration,
  planMcpUnregistration,
} from "./mcp-registration.js";
import { type Asset, planFor } from "./targets.js";

/** Requested cross-harness assets are valid, but only the selected host's hooks enforce its scope. */
export function localEnforcementRequirements(options: InstallOptions): string[] {
  const hooks = options.hooks ?? [];
  if (hooks.includes("git") || (options.harness === "claude-code" && hooks.includes("claude")))
    return [];
  if (hooks.includes("claude"))
    return [
      `Claude edit hooks do not enforce scope for the selected ${options.harness} harness. An installed Git hook is still required before coding can be authorized; request it with visp install --hooks git. Cross-harness assets are preserved.`,
    ];
  return [
    "Assets-only or CI-only installation cannot authorize coding. Install a local enforcement hook before starting a feature.",
  ];
}

/** Read existing surfaces and produce one transaction without mutating the project. */
export async function buildInstallPlan(
  paths: ProjectPaths,
  options: InstallOptions,
  profile: Profile,
  fs: ProjectFileSystem,
): Promise<Result<InstallPlan>> {
  const installed = await checkInstallRuntime(paths, fs, options);
  if (!installed.ok) return installed;
  const manifest = await readAssetManifest(paths, fs);
  if (!manifest.ok) return manifest;
  const configuration = await readInstallConfig(fs, paths);
  if (!configuration.ok) return configuration;
  const settings = configuration.value.settings;
  const reviewer = reviewerHarness(settings, options.harness);
  const critic = await resolveCriticDefault(options.harness, {
    ...settings.critic,
    harness: reviewer,
  });
  if (!critic.ok) return critic;
  const harnessPlan = planFor(options.harness, profile, critic.value ?? null);
  const planned: InstallPlan = {
    assets: [],
    mutations: [],
    fingerprints: {},
    created: {},
    removals: [],
    manualSteps: [...harnessPlan.manualSteps, ...criticSetupSteps(critic.value, options.harness)],
    expectedManifest: `${JSON.stringify(manifest.value, null, 2)}\n`,
    expectedConfig: undefined,
  };
  if (options.harness === "generic")
    planned.manualSteps.push(
      'If your host supports MCP, add a VISP server manually: {"visp":{"command":"visp","args":["serve","--mcp"]}}',
    );
  const previousInstall = await readInstallState(paths, fs);
  if (!previousInstall.ok) return previousInstall;
  const droppedHooks =
    previousInstall.value?.hooks.filter(
      (hook) => (hook === "git" || hook === "claude") && !(options.hooks ?? []).includes(hook),
    ) ?? [];
  if (droppedHooks.length)
    planned.manualSteps.push(
      `This installation drops previously recorded local hooks: ${droppedHooks.join(", ")}. Include them with --hooks to keep local enforcement.`,
    );

  const assets = await planAssets(fs, harnessPlan.assets, options, manifest.value, planned);
  if (!assets.ok) return assets;
  const profilePrune = await planOtherProfilePrune(
    fs,
    options.harness,
    profile,
    manifest.value,
    planned,
  );
  if (!profilePrune.ok) return profilePrune;
  const activation = await planActivation(fs, options, planned);
  if (!activation.ok) return activation;
  const hooks = await planHooks(fs, paths, options, manifest.value, planned, autoCompact(settings));
  if (!hooks.ok) return hooks;
  const mcp = await planMcp(fs, options, planned);
  if (!mcp.ok) return mcp;
  const previous = await planPreviousHarnessAssets(fs, paths, options, manifest.value, planned);
  if (!previous.ok) return previous;
  const installState = await planInstallState(fs, paths, options, profile);
  if (!installState.ok) return installState;
  if (installState.value) planned.mutations.push(installState.value);
  const nextManifest = await planManifest(fs, paths, manifest.value, planned);
  if (!nextManifest.ok) return nextManifest;
  const config = await planConfigUpdates(fs, paths, options.configUpdates, configuration.value);
  if (!config.ok) return config;
  planned.expectedConfig = config.value.expected;
  if (config.value.mutation !== undefined) planned.mutations.push(config.value.mutation);
  return ok(planned);
}

async function checkInstallRuntime(
  paths: ProjectPaths,
  fs: ProjectFileSystem,
  options: InstallOptions,
): Promise<Result<void>> {
  const identified = requireRuntimeAgreement(runtimeIdentity());
  if (!identified.ok) return identified;
  const installed = await readInstallState(paths, fs);
  if (!installed.ok) return installed;
  if (!installed.value?.runtime || options.replaceRuntime) return ok(undefined);
  const agreement = requireRuntimeAgreement(
    installed.value.runtime,
    runtimeIdentity(),
    "installed assets",
  );
  return agreement.ok
    ? agreement
    : err({
        ...agreement.error,
        recovery: `Installed assets use node ${JSON.stringify(installed.value.runtime.executable)}; run that build or use visp install --replace-runtime and restart MCP and host processes that use the old build. --force only replaces edited files.`,
      });
}

async function readInstallConfig(fs: ProjectFileSystem, paths: ProjectPaths) {
  const source = await fs.readTextIfExists(paths.config);
  if (!source.ok) return source;
  const settings = parseConfig(source.value ?? "", paths.config);
  return settings.ok ? ok({ source: source.value, settings: settings.value }) : settings;
}

function criticSetupSteps(critic: CriticConfig | undefined, installedHost: Harness): string[] {
  return critic && critic.harness !== installedHost
    ? [
        `The critic remains enabled for ${critic.harness}. Installing ${installedHost} assets does not establish that reviewer's capabilities or install its host integration. Complete setup in the reviewer host and run critic preflight; changing installation mode does not disable the critic.`,
      ]
    : [];
}

async function planInstallState(
  fs: ProjectFileSystem,
  paths: ProjectPaths,
  options: InstallOptions,
  profile: Profile,
): Promise<Result<FileMutation | undefined>> {
  const current = await fs.readTextIfExists(paths.installState);
  if (!current.ok) return current;
  const parsed = await readInstallState(paths, fs);
  if (!parsed.ok) return parsed;
  const next = {
    kind: "install-state" as const,
    version: 1 as const,
    harness: options.harness,
    profile,
    hooks: [...(options.hooks ?? [])],
    mcp: options.mcp === true,
    runtime: runtimeIdentity(),
  };
  const expected = installStateText(next);
  if (parsed.value && current.value === expected) return ok(undefined);
  return ok({
    kind: "write",
    path: paths.installState,
    content: expected,
    expectedBefore: filePrecondition(current.value),
  });
}

async function planAssets(
  fs: ProjectFileSystem,
  assets: readonly Asset[],
  options: InstallOptions,
  manifest: AssetManifest,
  planned: InstallPlan,
): Promise<Result<void>> {
  for (const asset of assets) {
    const result = await planAsset(fs, asset, options.force === true, manifest, planned);
    if (!result.ok) return result;
  }
  return ok(undefined);
}

async function planHooks(
  fs: ProjectFileSystem,
  paths: ProjectPaths,
  options: InstallOptions,
  manifest: AssetManifest,
  planned: InstallPlan,
  compact: boolean,
): Promise<Result<void>> {
  for (const hook of options.hooks ?? []) {
    const installed = await planHook(
      fs,
      paths,
      hook,
      options.force === true,
      manifest,
      planned,
      compact,
    );
    if (!installed.ok) return installed;
  }
  return ok(undefined);
}

async function planPreviousHarnessAssets(
  fs: ProjectFileSystem,
  paths: ProjectPaths,
  options: InstallOptions,
  manifest: AssetManifest,
  planned: InstallPlan,
): Promise<Result<void>> {
  const prior = await inspectForeignHarnessAssets(paths, options.harness, manifest);
  if (!prior.ok) return prior;
  if (!hasForeignHarnessResidue(prior.value)) return ok(undefined);

  if (options.prunePreviousHarness) {
    const pruned = await planOwnedPreviousHarnessResidue(fs, prior.value, manifest, planned);
    if (!pruned.ok) return pruned;
  } else addOwnedResidueStep(prior.value, planned);

  addManualResidueSteps(prior.value, planned);
  return ok(undefined);
}

async function planOwnedPreviousHarnessResidue(
  fs: ProjectFileSystem,
  residue: ForeignHarnessAssets,
  manifest: AssetManifest,
  planned: InstallPlan,
): Promise<Result<void>> {
  const assets = await planOwnedPreviousAssets(fs, residue.owned, manifest, planned);
  if (!assets.ok) return assets;
  if (residue.claudeRegistration) {
    const registration = await planPreviousClaudeRegistration(fs, planned);
    if (!registration.ok) return registration;
  }
  for (const registration of residue.mcpRegistrations) {
    const removed = await planPreviousMcpRegistration(fs, registration, planned);
    if (!removed.ok) return removed;
  }
  return ok(undefined);
}

function hasForeignHarnessResidue(residue: ForeignHarnessAssets): boolean {
  return (
    residue.owned.length > 0 ||
    residue.edited.length > 0 ||
    residue.unrecognized.length > 0 ||
    residue.claudeRegistration ||
    residue.mcpRegistrations.length > 0
  );
}

async function planOwnedPreviousAssets(
  fs: ProjectFileSystem,
  assets: readonly string[],
  manifest: AssetManifest,
  planned: InstallPlan,
): Promise<Result<void>> {
  for (const asset of assets) {
    const current = await fs.readTextIfExists(asset);
    if (!current.ok) return current;
    if (current.value !== undefined && manifest[asset] !== assetFingerprint(current.value)) {
      planned.manualSteps.push(`${asset} changed during installation and was left alone.`);
      continue;
    }
    planRemoval(asset, planned, current.value);
  }
  return ok(undefined);
}

function addOwnedResidueStep(residue: ForeignHarnessAssets, planned: InstallPlan): void {
  const owned = [
    ...residue.owned,
    ...(residue.claudeRegistration ? [CLAUDE_SETTINGS_REGISTRATION] : []),
    ...residue.mcpRegistrations.map(({ path }) => mcpRegistrationLabel(path)),
  ];
  if (owned.length === 0) return;
  planned.manualSteps.push(
    `Fingerprint-matched assets from another harness remain: ${owned
      .slice(0, 3)
      .join(", ")}. Use --prune-previous-harness to remove only VISP-owned copies.`,
  );
}

async function planPreviousMcpRegistration(
  fs: ProjectFileSystem,
  registration: ForeignMcpRegistration,
  planned: InstallPlan,
): Promise<Result<void>> {
  if (planned.mutations.some((mutation) => mutation.path === registration.path))
    return ok(undefined);
  const current = await fs.readTextIfExists(registration.path);
  if (!current.ok) return current;
  const removal = planMcpUnregistration(current.value, registration.harness);
  if (removal.status !== "removed" || removal.content === undefined) {
    planned.manualSteps.push(
      `${mcpRegistrationLabel(registration.path)} changed during installation and was left alone.`,
    );
    return ok(undefined);
  }
  const backup = await planConfigBackup(fs, registration.path, current.value, planned);
  if (!backup.ok) return backup;
  planned.mutations.push({
    kind: "write",
    path: registration.path,
    content: removal.content,
    expectedBefore: filePrecondition(current.value),
  });
  planned.assets.push({ path: mcpRegistrationLabel(registration.path), status: "removed" });
  return ok(undefined);
}

/**
 * The text of a host configuration VISP is about to rewrite, kept under the ignored
 * `.visp/state/backups/`: MCP configuration can hold tokens, which must not land beside it in
 * the repository. One copy per distinct text, and only the latest few per file.
 */
export async function planConfigBackup(
  fs: ProjectFileSystem,
  path: string,
  text: string | undefined,
  plan: { readonly mutations: FileMutation[] },
): Promise<Result<void>> {
  if (text === undefined || text.trim() === "") return ok(undefined);
  const directory = dirname(`${STATE_DIR}/${DIR.state}/backups/${path}`);
  const prefix = `${basename(path)}.`;
  const fingerprint = assetFingerprint(text);
  const listed = await fs.listEntries(directory);
  if (!listed.ok) return listed;
  const earlier = listed.value
    .filter((entry) => entry.type === "file" && entry.name.startsWith(prefix))
    .map((entry) => entry.name)
    .sort();
  if (earlier.some((name) => name.endsWith(`-${fingerprint}`))) return ok(undefined);
  for (const name of earlier.slice(0, Math.max(0, earlier.length - (KEPT_BACKUPS - 1)))) {
    const removal = await removalOf(fs, `${directory}/${name}`);
    if (!removal.ok) return removal;
    plan.mutations.push(removal.value);
  }
  // A sequence number after the newest backup, not the clock, so the same project state always
  // plans the same backup path (interrupted installs replay their plan).
  const newest = earlier.map((name) => Number(/^\d+/.exec(name.slice(prefix.length))?.[0] ?? 0));
  const next = Math.max(0, ...newest) + 1;
  plan.mutations.push({
    kind: "write",
    path: `${directory}/${prefix}${String(next).padStart(13, "0")}-${fingerprint}`,
    content: text,
    expectedBefore: { existed: false },
  });
  return ok(undefined);
}

/** Backups kept per host configuration file. */
const KEPT_BACKUPS = 5;

export async function removalOf(
  fs: ProjectFileSystem,
  path: string,
): Promise<Result<FileMutation>> {
  const content = await fs.readBytes(path);
  if (!content.ok) return content;
  const metadata = await fs.readMetadata(path);
  if (!metadata.ok) return metadata;
  return ok({
    kind: "remove",
    path,
    expectedBefore: filePrecondition(content.value, metadata.value?.mode),
  });
}

async function planPreviousClaudeRegistration(
  fs: ProjectFileSystem,
  planned: InstallPlan,
): Promise<Result<void>> {
  const current = await fs.readTextIfExists(CLAUDE_SETTINGS_FILE);
  if (!current.ok) return current;
  const registration = planPreToolUseUnregistration(current.value, CLAUDE_PRE_TOOL_USE_HOOK);
  if (registration.status !== "removed" || registration.content === undefined) {
    planned.manualSteps.push(
      `${CLAUDE_SETTINGS_REGISTRATION} changed during installation and was left alone.`,
    );
    return ok(undefined);
  }
  planned.mutations.push({
    kind: "write",
    path: CLAUDE_SETTINGS_FILE,
    content: registration.content,
    expectedBefore: filePrecondition(current.value),
  });
  planned.assets.push({ path: CLAUDE_SETTINGS_REGISTRATION, status: "removed" });
  return ok(undefined);
}

function addManualResidueSteps(residue: ForeignHarnessAssets, plan: InstallPlan): void {
  if (residue.edited.length > 0) {
    plan.manualSteps.push(
      `Edited assets from another harness were left alone: ${residue.edited
        .slice(0, 3)
        .join(", ")}. Review and remove them manually if they are obsolete.`,
    );
  }
  if (residue.unrecognized.length > 0) {
    plan.manualSteps.push(
      `Unrecognized files at another harness's VISP paths were left alone: ${residue.unrecognized
        .slice(0, 3)
        .join(", ")}. Review and remove them manually if they are obsolete.`,
    );
  }
}

async function planManifest(
  fs: ProjectFileSystem,
  paths: ProjectPaths,
  manifest: AssetManifest,
  plan: InstallPlan,
): Promise<Result<void>> {
  const next: AssetManifest = { ...manifest, ...plan.created, ...plan.fingerprints };
  for (const path of plan.removals) delete next[path];
  const current = await fs.readTextIfExists(paths.assetManifest);
  if (!current.ok) return current;
  const observed = parseAssetManifestText(current.value);
  if (!observed.ok) return observed;
  if (JSON.stringify(observed.value) !== JSON.stringify(manifest)) {
    return err(
      vispError("IO_ERROR", "The harness asset manifest changed during installation", {
        recovery: "Review the concurrent edit, then rerun visp install",
      }),
    );
  }
  const expected = `${JSON.stringify(next, null, 2)}\n`;
  plan.expectedManifest = expected;
  if (current.value === expected) return ok(undefined);
  plan.mutations.push({
    kind: "write",
    path: paths.assetManifest,
    content: expected,
    expectedBefore: filePrecondition(current.value),
  });
  return ok(undefined);
}

async function planAsset(
  fs: ProjectFileSystem,
  asset: Asset,
  force: boolean,
  manifest: AssetManifest,
  plan: InstallPlan,
): Promise<Result<void>> {
  const current = await fs.readTextIfExists(asset.path);
  if (!current.ok) return current;
  const metadata = await fs.metadata(asset.path);
  if (!metadata.ok) return metadata;

  if (current.value !== undefined && sameAssetContent(current.value, asset)) {
    const executableDrift = asset.executable && !isExecutableMode(metadata.value?.mode);
    plan.assets.push({ path: asset.path, status: executableDrift ? "written" : "unchanged" });
    plan.fingerprints[asset.path] = assetFingerprint(asset.content);
    if (executableDrift) {
      plan.mutations.push({
        kind: "write",
        path: asset.path,
        content: asset.content,
        mode: 0o755,
        expectedBefore: filePrecondition(current.value, metadata.value?.mode),
      });
    }
    return ok(undefined);
  }

  if (current.value !== undefined) {
    const owned = manifest[asset.path] === assetFingerprint(current.value);
    if (!force && !owned) {
      return err(
        vispError(
          "STAGE_BLOCKED",
          `Required harness asset is edited or unrecognized: ${asset.path}`,
          {
            recovery: `Review ${asset.path}, then rerun visp install --force to replace it`,
          },
        ),
      );
    }
  }

  plan.mutations.push({
    kind: "write",
    path: asset.path,
    content: asset.content,
    ...(asset.executable ? { mode: 0o755 } : {}),
    expectedBefore: filePrecondition(current.value, metadata.value?.mode),
  });
  plan.assets.push({ path: asset.path, status: "written" });
  plan.fingerprints[asset.path] = assetFingerprint(asset.content);
  return ok(undefined);
}

async function planActivation(
  fs: ProjectFileSystem,
  options: InstallOptions,
  plan: InstallPlan,
): Promise<Result<void>> {
  const activationFile = agentActivationFile(options.harness);
  for (const previousFile of ["AGENTS.md", "CLAUDE.md"]) {
    if (requiresAgentActivation(options.harness) && previousFile === activationFile) continue;
    const previous = await fs.readTextIfExists(previousFile);
    if (!previous.ok) return previous;
    const pruned = planPreviousActivation(previous.value, options, plan, previousFile);
    if (!pruned.ok) return pruned;
  }
  const current = await fs.readTextIfExists(activationFile);
  if (!current.ok) return current;

  if (!requiresAgentActivation(options.harness)) {
    plan.activation = "not-required";
    return ok(undefined);
  }

  const activation = planAgentActivation(options.harness, current.value, options.force === true);
  if (!activation.ok) return activation;
  plan.activation = activation.value.status;
  if (activation.value.content !== undefined) {
    const target = await fs.authoredWriteTarget(activationFile);
    if (!target.ok) return target;
    plan.mutations.push({
      kind: "write",
      path: target.value,
      content: activation.value.content,
      expectedBefore: filePrecondition(current.value),
    });
    plan.assets.push({ path: activationFile, status: "written" });
  }
  return ok(undefined);
}

function planPreviousActivation(
  current: string | undefined,
  options: InstallOptions,
  plan: InstallPlan,
  activationFile: string,
): Result<void> {
  const previous = planAgentDeactivation(current);
  if (previous.status === "absent") return ok(undefined);
  if (previous.status === "edited") {
    plan.manualSteps.push(`${activationFile} contains an edited VISP block and was left alone.`);
    return ok(undefined);
  }
  if (!options.prunePreviousHarness) {
    plan.manualSteps.push(
      `${activationFile} still activates a previous harness; use --prune-previous-harness to remove only its VISP block.`,
    );
    return ok(undefined);
  }

  const content = previous.content ?? "";
  plan.mutations.push(
    content === ""
      ? {
          kind: "remove",
          path: activationFile,
          expectedBefore: filePrecondition(current),
        }
      : {
          kind: "write",
          path: activationFile,
          content,
          expectedBefore: filePrecondition(current),
        },
  );
  plan.assets.push({ path: `${activationFile} (VISP block)`, status: "removed" });
  return ok(undefined);
}

async function planHook(
  fs: ProjectFileSystem,
  paths: ProjectPaths,
  hook: HookKind,
  force: boolean,
  manifest: AssetManifest,
  plan: InstallPlan,
  compact: boolean,
): Promise<Result<void>> {
  if (hook === "claude") return planClaudeHook(fs, force, manifest, plan, compact);
  if (hook === "ci") {
    return planAsset(
      fs,
      { path: ".github/workflows/visp.yml", content: renderCiWorkflow(pinnedRange()) },
      force,
      manifest,
      plan,
    );
  }

  return planGitHook(fs, paths, force, plan);
}

/** Whether install sets the lean worker's compaction variables (`workflow.autoCompact`). */
function autoCompact(settings: VispConfig): boolean {
  const { workflow } = settings;
  return workflow.autoCompact ?? (workflow.profile === "lean" && workflow.worker !== "weak");
}

async function planClaudeHook(
  fs: ProjectFileSystem,
  force: boolean,
  manifest: AssetManifest,
  plan: InstallPlan,
  compact: boolean,
): Promise<Result<void>> {
  const path = CLAUDE_PRE_TOOL_USE_HOOK;
  const content = renderPreToolUseHook();
  const script = await planAsset(fs, { path, content, executable: true }, force, manifest, plan);
  if (!script.ok) return script;

  const current = await fs.readTextIfExists(CLAUDE_SETTINGS_FILE);
  if (!current.ok) return current;
  const registration = planPreToolUseRegistration(current.value, path, force);
  if (!registration.ok) return registration;
  plan.claudeSettings = registration.value.status;
  if (registration.value.status === "malformed" || registration.value.status === "customized") {
    if (registration.value.status === "malformed") {
      plan.settingsSnippet = renderClaudeSettingsSnippet(path);
    }
    return err(
      vispError(
        "ARTIFACT_INVALID",
        registration.value.status === "malformed"
          ? `${CLAUDE_SETTINGS_FILE} could not be safely merged`
          : `${CLAUDE_SETTINGS_FILE} contains an edited VISP hook registration`,
        {
          recovery:
            registration.value.status === "malformed"
              ? "Repair the JSON or rerun visp install --force"
              : "Review the customized hook and rerun visp install --force to restore it",
        },
      ),
    );
  }
  const backup = await planSettingsBackup(fs, registration.value, current.value, plan);
  if (!backup.ok) return backup;
  const registered = registration.value.content ?? current.value;
  const settings = withCompactionEnv(registered, compact);
  if (settings !== undefined && settings !== current.value) {
    recordCreated(plan, CLAUDE_SETTINGS_FILE, current.value, settings);
    plan.mutations.push({
      kind: "write",
      path: CLAUDE_SETTINGS_FILE,
      content: settings,
      expectedBefore: filePrecondition(current.value),
    });
  }
  return ok(undefined);
}

/** `install --force` rewrites settings it cannot merge; the old text is kept beside it. */
async function planSettingsBackup(
  fs: ProjectFileSystem,
  registration: PlannedClaudeRegistration,
  text: string | undefined,
  plan: InstallPlan,
): Promise<Result<void>> {
  if (!registration.discarded || text === undefined) return ok(undefined);
  const path = `${CLAUDE_SETTINGS_FILE}.visp-backup-${assetFingerprint(text)}`;
  const existing = await fs.readTextIfExists(path);
  if (!existing.ok) return existing;
  if (existing.value !== text) {
    plan.mutations.push({
      kind: "write",
      path,
      content: text,
      expectedBefore: filePrecondition(existing.value),
    });
  }
  plan.manualSteps.push(
    `${CLAUDE_SETTINGS_FILE} could not be merged and was rewritten; the previous text is saved as ${path}. Copy back any permissions or env settings you need, then delete the backup: it may contain env secrets.`,
  );
  return ok(undefined);
}

async function planGitHook(
  fs: ProjectFileSystem,
  paths: ProjectPaths,
  force: boolean,
  plan: InstallPlan,
): Promise<Result<void>> {
  const resolved = await preCommitHookPath(paths.root);
  if (!resolved.ok) return resolved;
  if (paths.relative(resolved.value.absolute) === undefined) {
    return err(
      vispError(
        "STAGE_BLOCKED",
        `Git's effective hook path is outside this worktree: ${resolved.value.display}`,
        {
          recovery:
            "Either rerun with --no-hooks, or review Git's worktreeConfig migration warning, then run `git config extensions.worktreeConfig true` and `git config --worktree core.hooksPath .visp/hooks/git` before reinstalling",
          details: { hookPath: resolved.value.absolute, projectRoot: paths.root },
        },
      ),
    );
  }
  const current = await fs.readTextIfExists(resolved.value.absolute);
  if (!current.ok) return current;
  const metadata = await fs.metadata(resolved.value.absolute);
  if (!metadata.ok) return metadata;
  const foreign = current.value !== undefined && !current.value.includes(HOOK_MARKER);
  if (foreign && !force) {
    return err(
      vispError(
        "STAGE_BLOCKED",
        `A foreign pre-commit hook already exists at ${resolved.value.display}`,
        {
          recovery:
            "Integrate VISP manually, omit the git hook, or rerun visp install --force to preserve the existing hook as pre-commit.local",
        },
      ),
    );
  }

  const localPath = `${resolved.value.absolute}.local`;
  const local = await fs.readTextIfExists(localPath);
  if (!local.ok) return local;
  if (foreign) {
    const tracked = await run(
      "git",
      ["ls-files", "--error-unmatch", "--", resolved.value.display],
      { cwd: paths.root },
    );
    if (!tracked.ok) return tracked;
    if (tracked.value.exitCode === 0 || local.value !== undefined) {
      return err(
        vispError("STAGE_BLOCKED", `Cannot chain the foreign hook at ${resolved.value.display}`, {
          recovery:
            tracked.value.exitCode === 0
              ? "This hook is tracked by Git; integrate VISP manually without replacing it"
              : "pre-commit.local already exists; integrate VISP manually",
        }),
      );
    }
    plan.mutations.push({
      kind: "write",
      path: localPath,
      content: current.value ?? "",
      mode: metadata.value?.mode,
      expectedBefore: filePrecondition(local.value),
    });
  }
  const expected = renderPreCommitHook(foreign || local.value !== undefined);

  const currentAndExecutable = current.value === expected && isExecutableMode(metadata.value?.mode);
  plan.assets.push({
    path: resolved.value.display,
    status: currentAndExecutable ? "unchanged" : "written",
  });
  plan.fingerprints[resolved.value.display] = assetFingerprint(expected);
  if (!currentAndExecutable) {
    plan.mutations.push({
      kind: "write",
      path: resolved.value.absolute,
      content: expected,
      mode: 0o755,
      expectedBefore: filePrecondition(current.value, metadata.value?.mode),
    });
  }
  return ok(undefined);
}

async function planMcp(
  fs: ProjectFileSystem,
  options: InstallOptions,
  plan: InstallPlan,
): Promise<Result<void>> {
  if (!options.mcp) return ok(undefined);
  const path = configFileForHarness(options.harness);
  const current = await fs.readTextIfExists(path);
  if (!current.ok) return current;
  const registration = planMcpRegistration(
    current.value,
    options.force === true || options.replaceRuntime === true,
    options.harness,
  );
  if (!registration.ok) return registration;
  plan.mcp = registration.value.status;
  plan.mcpConfigFile = path;
  const { status } = registration.value;
  if (status === "malformed" || status === "customized")
    return unmergedMcp(path, status, options.harness, plan, registration.value.unreadable);
  if (registration.value.content !== undefined) {
    recordCreated(plan, path, current.value, registration.value.content);
    const written = await planConfigWrite(
      fs,
      path,
      current.value,
      registration.value.content,
      plan,
    );
    if (!written.ok) return written;
  }
  return options.harness === "cursor" ? planOldClaudeMcpRemoval(fs, plan) : ok(undefined);
}

/** Codex's TOML is left for the user with a manual step; a JSON host's install stops. */
function unmergedMcp(
  path: string,
  status: "malformed" | "customized",
  harness: InstallOptions["harness"],
  plan: InstallPlan,
  unreadable?: boolean,
): Result<void> {
  if (harness === "codex") {
    plan.manualSteps.push(
      status === "customized"
        ? `${path} ${codexRegistrationProblem(unreadable)}: ${codexRegistrationAdvice(unreadable)}. Other installation assets will still be installed.`
        : `${path} could not be merged; add [mcp_servers.visp] manually or rerun visp install --no-mcp. Other installation assets will still be installed.`,
    );
    return ok(undefined);
  }
  return err(
    vispError(
      "ARTIFACT_INVALID",
      status === "malformed"
        ? `${path} is not a safely mergeable MCP configuration; it was left unchanged`
        : `${path} contains a customized VISP registration that was left unchanged`,
      {
        recovery:
          status === "malformed"
            ? `Repair ${path} or rerun visp install --no-mcp; --force never replaces unparseable configuration`
            : `Review ${path}, then rerun visp install --force to replace only the VISP registration`,
      },
    ),
  );
}

/**
 * A shared file that install creates is recorded in the manifest, with the text it wrote, so
 * `visp uninstall` may delete it once nothing else is left in it. A file the project already
 * had is only ever edited back.
 */
function recordCreated(
  plan: InstallPlan,
  path: string,
  before: string | undefined,
  content: string,
): void {
  if (before === undefined || before.trim() === "") plan.created[path] = assetFingerprint(content);
}

/** Rewrites a host configuration after keeping its previous text. */
async function planConfigWrite(
  fs: ProjectFileSystem,
  path: string,
  before: string | undefined,
  content: string,
  plan: InstallPlan,
): Promise<Result<void>> {
  const backup = await planConfigBackup(fs, path, before, plan);
  if (!backup.ok) return backup;
  plan.mutations.push({ kind: "write", path, content, expectedBefore: filePrecondition(before) });
  return ok(undefined);
}

/** Cursor moved from .mcp.json to .cursor/mcp.json; the old VISP entry goes. */
async function planOldClaudeMcpRemoval(
  fs: ProjectFileSystem,
  plan: InstallPlan,
): Promise<Result<void>> {
  const old = await fs.readTextIfExists(".mcp.json");
  if (!old.ok) return old;
  const removal = planMcpUnregistration(old.value, "claude-code");
  if (removal.status !== "removed" || removal.content === undefined) return ok(undefined);
  const written = await planConfigWrite(fs, ".mcp.json", old.value, removal.content, plan);
  if (!written.ok) return written;
  plan.assets.push({ path: ".mcp.json (old VISP registration)", status: "removed" });
  return ok(undefined);
}

async function planConfigUpdates(
  fs: ProjectFileSystem,
  paths: ProjectPaths,
  updates: InstallOptions["configUpdates"],
  observed: { readonly source: string | undefined; readonly settings: VispConfig },
): Promise<Result<{ readonly expected?: string; readonly mutation?: FileMutation }>> {
  const current = await fs.readTextIfExists(paths.config);
  if (!current.ok) return current;
  if (current.value !== observed.source) {
    return err(vispError("IO_ERROR", "Configuration changed while planning harness installation"));
  }
  if (
    current.value === undefined ||
    !updates ||
    (updates.harness === undefined && updates.profile === undefined)
  ) {
    return ok({ ...(current.value === undefined ? {} : { expected: current.value }) });
  }

  const next = configWithInstallChoices(current.value, updates, observed.settings);
  return next === current.value
    ? ok({ expected: current.value })
    : ok({
        expected: next,
        mutation: {
          kind: "write",
          path: paths.config,
          content: next,
          expectedBefore: filePrecondition(current.value),
        },
      });
}

function configWithInstallChoices(
  current: string,
  updates: NonNullable<InstallOptions["configUpdates"]>,
  config: VispConfig,
): string {
  const document = parseDocument(current);
  let changed = false;
  if (updates.harness !== undefined && document.get("harness") !== updates.harness) {
    const reviewer = reviewerHarness(config, updates.harness);
    if (reviewer && config.critic?.harness === undefined) {
      document.setIn(["critic", "harness"], reviewer);
    }
    document.set("harness", updates.harness);
    changed = true;
  }
  if (updates.profile !== undefined && document.get("profile") !== updates.profile) {
    document.set("profile", updates.profile);
    changed = true;
  }
  return changed ? String(document) : current;
}

function reviewerHarness(config: VispConfig, target: Harness) {
  return (
    config.critic?.harness ??
    balancedCritic(config.harness)?.harness ??
    balancedCritic(target)?.harness
  );
}

async function planOtherProfilePrune(
  fs: ProjectFileSystem,
  harness: Harness,
  profile: Profile,
  manifest: AssetManifest,
  plan: InstallPlan,
): Promise<Result<void>> {
  const other = PROFILES.find((candidate) => candidate !== profile);
  if (!other) return ok(undefined);
  const keep = new Set(planFor(harness, profile).assets.map((asset) => asset.path));
  const stale = planFor(harness, other)
    .assets.map((asset) => asset.path)
    .filter((path) => !keep.has(path));
  // The guide's old path is pruned only when an earlier install recorded it there.
  const retired = manifest[RETIRED_COMMAND_GUIDE_PATH] ? [RETIRED_COMMAND_GUIDE_PATH] : [];
  for (const path of [...stale, ...retired]) {
    const current = await fs.readTextIfExists(path);
    if (!current.ok) return current;
    if (current.value === undefined) continue;
    if (manifest[path] === assetFingerprint(current.value)) {
      planRemoval(path, plan, current.value);
    } else {
      plan.manualSteps.push(staleAssetStep(path, other));
    }
  }
  return ok(undefined);
}

function staleAssetStep(path: string, other: Profile): string {
  return path === RETIRED_COMMAND_GUIDE_PATH
    ? `${path} is an edited copy of the command guide, which now lives at ${COMMAND_GUIDE_PATH}; remove it yourself if it is no longer wanted.`
    : `${path} belongs to the ${other} profile but has been edited; remove it yourself if it is no longer wanted.`;
}

function planRemoval(path: string, plan: InstallPlan, current: string | undefined): void {
  if (plan.removals.includes(path)) return;
  plan.mutations.push({
    kind: "remove",
    path,
    expectedBefore: filePrecondition(current),
  });
  plan.assets.push({ path, status: "removed" });
  plan.removals.push(path);
}
