import { existsSync, readFileSync } from "node:fs";
import { balancedCritic } from "../config/critic.js";
import { DIR, type Harness, PROFILES, STATE_DIR } from "../core/constants.js";
import { vispError } from "../core/errors.js";
import {
  applyFileTransaction,
  type FileMutation,
  filePrecondition,
  inspectFileTransactions,
  recoverFileTransactions,
} from "../core/file-transaction.js";
import { ProjectFileSystem } from "../core/fs.js";
import type { ProjectPaths } from "../core/paths.js";
import { err, ok, type Result } from "../core/result.js";
import { pinnedRange } from "../core/version.js";
import {
  agentActivationFile,
  planAgentDeactivation,
  requiresAgentActivation,
} from "./activation.js";
import { assetFingerprint, isCurrentAsset, readAssetManifest } from "./asset-inspection.js";
import {
  CLAUDE_PRE_TOOL_USE_HOOK,
  CLAUDE_SETTINGS_FILE,
  planClaudeSettingsRemoval,
} from "./claude-settings.js";
import { commandGuide, RETIRED_COMMAND_GUIDE_PATH } from "./command-guide.js";
import { preCommitHookPath } from "./git-hook.js";
import {
  HOOK_MARKER,
  isCurrentGeneratedHook,
  renderCiWorkflow,
  renderPreCommitHook,
  renderPreToolUseHook,
} from "./hooks.js";
import { planConfigBackup, removalOf } from "./install-plan.js";
import { readInstallState } from "./install-state.js";
import type { AssetManifest } from "./install-types.js";
import { mcpConfigFile, planMcpUnregistration } from "./mcp-registration.js";
import { type Asset, planFor } from "./targets.js";

const CI_WORKFLOW = ".github/workflows/visp.yml";
const AUTHORIZATION_DIRECTORIES = ["product-authorizations", "implement-allowed"] as const;

export interface UninstallOptions {
  readonly harness: Harness;
  /** Also remove files and hook entries you edited. It never overrides an authorized slice. */
  readonly force?: boolean;
  /** Plan and report only; nothing is recovered, written or removed. */
  readonly dryRun?: boolean;
}

export interface UninstallRuntime {
  /** Test seam for exercising the complete mutation plan. */
  readonly applyTransaction?: typeof applyFileTransaction;
}

export interface UninstallChange {
  /** `edit` changes a shared file, `restore` puts back the hook install had set aside. */
  readonly operation: "remove" | "edit" | "restore";
  readonly path: string;
  readonly detail?: string;
}

export interface UninstallOutcome {
  readonly dryRun: boolean;
  readonly harness: Harness;
  readonly changes: readonly UninstallChange[];
  /** Recognized as VISP's but edited, or entries VISP does not own; left in place. */
  readonly kept: readonly { readonly path: string; readonly reason: string }[];
  readonly remaining: readonly string[];
  readonly manualSteps: readonly string[];
}

interface Plan {
  readonly mutations: FileMutation[];
  readonly changes: UninstallChange[];
  readonly kept: { path: string; reason: string }[];
  readonly manualSteps: string[];
  /** Manifest keys whose files are gone. */
  readonly forgotten: string[];
}

/**
 * The reverse of `visp install`. Removes only what VISP wrote and still recognizes as its own,
 * as one recoverable transaction. Feature history under `.visp/` and `visp.yml` are never touched.
 */
export async function uninstallHarness(
  paths: ProjectPaths,
  options: UninstallOptions,
  runtime: UninstallRuntime = {},
): Promise<Result<UninstallOutcome>> {
  const fs = new ProjectFileSystem(paths.root);
  const ready = await checkReady(paths, fs, options);
  if (!ready.ok) return ready;

  const planned = await planUninstall(paths, fs, options);
  if (!planned.ok) return planned;
  const outcome = outcomeOf(options, planned.value);
  if (options.dryRun || planned.value.mutations.length === 0) return ok(outcome);

  const apply = runtime.applyTransaction ?? applyFileTransaction;
  const applied = await apply(paths.root, "harness-uninstall", planned.value.mutations);
  if (!applied.ok) return applied;
  await pruneEmptyDirectories(paths, fs, planned.value.mutations);
  return ok(outcome);
}

/** A dry run only inspects transactions; a real run recovers them. A live slice blocks both. */
async function checkReady(
  paths: ProjectPaths,
  fs: ProjectFileSystem,
  options: UninstallOptions,
): Promise<Result<void>> {
  if (options.dryRun) {
    const inspected = await inspectFileTransactions(paths.root);
    if (!inspected.ok) return inspected;
    if (inspected.value.pending.length > 0) {
      return err(
        vispError("STAGE_BLOCKED", "Uninstall preview requires recovery of a pending transaction", {
          recovery: "visp doctor --fix",
          details: { pending: inspected.value.pending },
        }),
      );
    }
  } else {
    const recovered = await recoverFileTransactions(paths.root);
    if (!recovered.ok) return recovered;
  }
  const recorded = await readInstallState(paths, fs);
  if (!recorded.ok) return recorded;
  if (recorded.value && recorded.value.harness !== options.harness) {
    return err(
      vispError(
        "STAGE_BLOCKED",
        `visp is installed for ${recorded.value.harness}, not ${options.harness}; uninstalling ${options.harness} would break that installation`,
        { recovery: `Run visp uninstall --harness ${recorded.value.harness}` },
      ),
    );
  }
  // --force covers edited files only, never an authorized slice.
  const authorized = await authorizationMarkers(fs);
  if (!authorized.ok) return authorized;
  if (authorized.value.length === 0) return ok(undefined);
  return err(
    vispError("STAGE_BLOCKED", "A slice is authorized; uninstalling now would drop its guard", {
      recovery: `Finish the slice with visp done. A person who wants to abandon it can delete the marker files by hand: ${authorized.value.join(", ")}`,
      details: { markers: authorized.value },
    }),
  );
}

function outcomeOf(options: UninstallOptions, plan: Plan): UninstallOutcome {
  return {
    dryRun: options.dryRun === true,
    harness: options.harness,
    changes: plan.changes,
    kept: plan.kept,
    remaining: [".visp/", "visp.yml"],
    manualSteps: [
      ...plan.manualSteps,
      "Kept on purpose: feature history and project state under .visp/ (uninstall removes only .visp/hooks scripts, the install record and the asset manifest, and writes backups under .visp/state/backups/), visp.yml and the .visp entries `visp init` added to .gitignore. Delete them by hand if you want them gone: rm -rf .visp visp.yml",
    ],
  };
}

/** Marker files of authorized slices, as the Git hook sees them: any `.json` there counts. */
async function authorizationMarkers(fs: ProjectFileSystem): Promise<Result<string[]>> {
  const found: string[] = [];
  for (const name of AUTHORIZATION_DIRECTORIES) {
    const directory = `${STATE_DIR}/${DIR.state}/${name}`;
    const listed = await fs.listEntries(directory);
    if (!listed.ok) return listed;
    for (const entry of listed.value)
      if (entry.name.endsWith(".json")) found.push(`${directory}/${entry.name}`);
  }
  return ok(found);
}

async function planUninstall(
  paths: ProjectPaths,
  fs: ProjectFileSystem,
  options: UninstallOptions,
): Promise<Result<Plan>> {
  const manifest = await readAssetManifest(paths, fs);
  if (!manifest.ok) return manifest;
  const recorded = await readInstallState(paths, fs);
  if (!recorded.ok) return recorded;
  const plan: Plan = { mutations: [], changes: [], kept: [], manualSteps: [], forgotten: [] };
  const force = options.force === true;

  for (const asset of generatedAssets(options.harness)) {
    const planned = await planAssetRemoval(fs, asset, manifest.value, force, plan);
    if (!planned.ok) return planned;
  }
  const steps = [
    () => planActivationRemoval(fs, options.harness, plan),
    () => planClaudeSettings(fs, manifest.value, force, plan),
    () => planMcpRemoval(fs, options.harness, manifest.value, plan),
    () => planGitHookRemoval(paths, fs, manifest.value, force, plan),
  ];
  for (const step of steps) {
    const planned = await step();
    if (!planned.ok) return planned;
  }

  const bookkeeping = await planBookkeeping(paths, fs, options.harness, manifest.value, plan);
  if (!bookkeeping.ok) return bookkeeping;
  return ok(plan);
}

/** Every file install can write for this host, whatever its profile, plus the shared hooks. */
function generatedAssets(harness: Harness): Asset[] {
  const assets = new Map<string, Asset>();
  for (const profile of PROFILES)
    for (const asset of planFor(harness, profile, balancedCritic(harness) ?? null).assets)
      assets.set(asset.path, asset);
  assets.set(CLAUDE_PRE_TOOL_USE_HOOK, {
    path: CLAUDE_PRE_TOOL_USE_HOOK,
    content: renderPreToolUseHook(),
    executable: true,
    render: renderPreToolUseHook,
  });
  assets.set(CI_WORKFLOW, { path: CI_WORKFLOW, content: renderCiWorkflow(pinnedRange()) });
  // An install from an earlier build may still have the command guide at the project root.
  assets.set(RETIRED_COMMAND_GUIDE_PATH, {
    path: RETIRED_COMMAND_GUIDE_PATH,
    content: commandGuide(false, true),
  });
  return [...assets.values()];
}

async function planAssetRemoval(
  fs: ProjectFileSystem,
  asset: Asset,
  manifest: AssetManifest,
  force: boolean,
  plan: Plan,
): Promise<Result<void>> {
  const current = await fs.readTextIfExists(asset.path);
  if (!current.ok) return current;
  if (current.value === undefined) return ok(undefined);
  const owned =
    manifest[asset.path] === assetFingerprint(current.value) ||
    isCurrentAsset(current.value, asset);
  if (!owned && !force) {
    plan.kept.push({
      path: asset.path,
      reason: "edited since install, or not written by VISP; use --force to remove it",
    });
    return ok(undefined);
  }
  return removeFile(fs, asset.path, plan, owned ? undefined : "edited; removed by --force");
}

async function removeFile(
  fs: ProjectFileSystem,
  path: string,
  plan: Plan,
  detail?: string,
): Promise<Result<void>> {
  const removal = await removalOf(fs, path);
  if (!removal.ok) return removal;
  plan.mutations.push(removal.value);
  plan.changes.push({ operation: "remove", path, ...(detail ? { detail } : {}) });
  plan.forgotten.push(path);
  return ok(undefined);
}

/** The VISP block in AGENTS.md / CLAUDE.md; the file goes only when nothing else is in it. */
async function planActivationRemoval(
  fs: ProjectFileSystem,
  harness: Harness,
  plan: Plan,
): Promise<Result<void>> {
  if (!requiresAgentActivation(harness)) return ok(undefined);
  const path = agentActivationFile(harness);
  const current = await fs.readTextIfExists(path);
  if (!current.ok) return current;
  const removal = planAgentDeactivation(current.value);
  if (removal.status === "absent") return ok(undefined);
  if (removal.status === "edited") {
    plan.kept.push({
      path,
      reason: "its VISP block was edited; delete the block between the visp:instructions markers",
    });
    return ok(undefined);
  }
  const content = removal.content ?? "";
  if (content === "") {
    return removeFile(fs, path, plan, "only held the VISP block");
  }
  plan.mutations.push({
    kind: "write",
    path,
    content,
    expectedBefore: filePrecondition(current.value),
  });
  plan.changes.push({ operation: "edit", path, detail: "removed the VISP block" });
  return ok(undefined);
}

async function planClaudeSettings(
  fs: ProjectFileSystem,
  manifest: AssetManifest,
  force: boolean,
  plan: Plan,
): Promise<Result<void>> {
  const current = await fs.readTextIfExists(CLAUDE_SETTINGS_FILE);
  if (!current.ok) return current;
  const removal = planClaudeSettingsRemoval(current.value, CLAUDE_PRE_TOOL_USE_HOOK, force);
  if (removal.status === "malformed") {
    if (current.value?.includes(CLAUDE_PRE_TOOL_USE_HOOK)) {
      plan.kept.push({
        path: CLAUDE_SETTINGS_FILE,
        reason: "it could not be parsed; remove the VISP hook entries by hand",
      });
    }
    return ok(undefined);
  }
  if (removal.customized) {
    plan.kept.push({
      path: CLAUDE_SETTINGS_FILE,
      reason: "an edited VISP hook entry remains; use --force to remove it",
    });
  }
  if (removal.status !== "removed") return ok(undefined);
  return rewriteShared(
    fs,
    CLAUDE_SETTINGS_FILE,
    current.value,
    { content: removal.content ?? "", empty: removal.empty === true },
    createdByInstall(manifest, CLAUDE_SETTINGS_FILE),
    plan,
    "removed VISP's hook entries",
  );
}

async function planMcpRemoval(
  fs: ProjectFileSystem,
  harness: Harness,
  manifest: AssetManifest,
  plan: Plan,
): Promise<Result<void>> {
  if (harness === "generic") return ok(undefined);
  const path = mcpConfigFile(harness);
  const current = await fs.readTextIfExists(path);
  if (!current.ok) return current;
  const removal = planMcpUnregistration(current.value, harness, true);
  if (removal.status === "customized" || removal.status === "malformed") {
    plan.kept.push({
      path,
      reason:
        removal.status === "customized"
          ? "its visp server entry was edited; remove it by hand"
          : "it could not be parsed; remove the visp server entry by hand",
    });
    return ok(undefined);
  }
  if (removal.status !== "removed" || removal.content === undefined) return ok(undefined);
  const empty =
    removal.content.trim() === "" || EMPTY_MCP_CONFIG.test(removal.content.replace(/\s/g, ""));
  return rewriteShared(
    fs,
    path,
    current.value,
    { content: removal.content, empty },
    createdByInstall(manifest, path),
    plan,
    "removed the visp MCP server",
  );
}

/** What install writes into a new file, minus the entry: nothing else is in it. */
const EMPTY_MCP_CONFIG = /^﻿?\{(?:"[A-Za-z]+":\{\})?\}$/u;

/** The hook as install wrote it (its fingerprint), or as this build generates it anywhere. */
function ownedHook(text: string, recorded: string | undefined): boolean {
  return (
    recorded === assetFingerprint(text) ||
    [false, true].some((chained) =>
      isCurrentGeneratedHook(text, (executable) => renderPreCommitHook(chained, executable)),
    )
  );
}

/** Install records a shared file it created, so an emptied one may go; one the project had stays. */
function createdByInstall(manifest: AssetManifest, path: string): boolean {
  return manifest[path] !== undefined;
}

/** A shared file loses VISP's part, after its previous text is saved. */
async function rewriteShared(
  fs: ProjectFileSystem,
  path: string,
  before: string | undefined,
  after: { readonly content: string; readonly empty: boolean },
  created: boolean,
  plan: Plan,
  detail: string,
): Promise<Result<void>> {
  const backup = await planConfigBackup(fs, path, before, plan);
  if (!backup.ok) return backup;
  if (after.empty && created) {
    const removal = await removalOf(fs, path);
    if (!removal.ok) return removal;
    plan.mutations.push(removal.value);
    plan.changes.push({
      operation: "remove",
      path,
      detail: `${detail}; install created it and nothing else is in it`,
    });
    plan.forgotten.push(path);
    return ok(undefined);
  }
  plan.mutations.push({
    kind: "write",
    path,
    content: after.content,
    expectedBefore: filePrecondition(before),
  });
  plan.changes.push({ operation: "edit", path, detail });
  plan.forgotten.push(path);
  return ok(undefined);
}

/** The pre-commit hook, only if it is VISP's; the hook install set aside comes back. */
async function planGitHookRemoval(
  paths: ProjectPaths,
  fs: ProjectFileSystem,
  manifest: AssetManifest,
  force: boolean,
  plan: Plan,
): Promise<Result<void>> {
  const resolved = await preCommitHookPath(paths.root);
  if (!resolved.ok) return ok(undefined);
  const { absolute, display } = resolved.value;
  if (paths.relative(absolute) === undefined) {
    outsideHook(absolute, display, plan);
    return ok(undefined);
  }
  const current = await fs.readTextIfExists(absolute);
  if (!current.ok) return current;
  if (current.value === undefined || !current.value.includes(HOOK_MARKER)) return ok(undefined);
  if (!ownedHook(current.value, manifest[display])) {
    // An edited hook is the project's now: kept, or saved first when --force removes it.
    if (!force) {
      plan.kept.push({
        path: display,
        reason: "a VISP hook that was edited or comes from another build; use --force to remove it",
      });
      return ok(undefined);
    }
    const backup = await planConfigBackup(fs, display, current.value, plan);
    if (!backup.ok) return backup;
  }

  const localPath = `${absolute}.local`;
  const local = await fs.readTextIfExists(localPath);
  if (!local.ok) return local;
  const chained = current.value.includes('"$0.local"');
  if (!chained || local.value === undefined || local.value.includes(HOOK_MARKER)) {
    const removal = await removalOf(fs, absolute);
    if (!removal.ok) return removal;
    plan.mutations.push(removal.value);
    plan.changes.push({ operation: "remove", path: display });
    plan.forgotten.push(display);
    return ok(undefined);
  }

  return restoreChainedHook(fs, { absolute, display, localPath }, current.value, local.value, plan);
}

/** A hook path outside the project cannot be part of its transaction. */
function outsideHook(absolute: string, display: string, plan: Plan): void {
  if (existsSync(absolute) && readFileSync(absolute, "utf8").includes(HOOK_MARKER)) {
    plan.manualSteps.push(
      `Git's pre-commit hook is outside this project (${display}) and is VISP's; remove it by hand.`,
    );
  }
}

async function restoreChainedHook(
  fs: ProjectFileSystem,
  hook: { readonly absolute: string; readonly display: string; readonly localPath: string },
  current: string,
  local: string,
  plan: Plan,
): Promise<Result<void>> {
  const metadata = await fs.metadata(hook.absolute);
  if (!metadata.ok) return metadata;
  const localMetadata = await fs.metadata(hook.localPath);
  if (!localMetadata.ok) return localMetadata;
  const removal = await removalOf(fs, hook.localPath);
  if (!removal.ok) return removal;
  plan.mutations.push(
    {
      kind: "write",
      path: hook.absolute,
      content: local,
      ...(localMetadata.value?.mode === undefined ? {} : { mode: localMetadata.value.mode }),
      expectedBefore: filePrecondition(current, metadata.value?.mode),
    },
    removal.value,
  );
  plan.changes.push({
    operation: "restore",
    path: hook.display,
    detail: `put back the earlier hook from ${hook.display}.local`,
  });
  plan.forgotten.push(hook.display);
  return ok(undefined);
}

/** The install record and the fingerprints of what was removed. Feature history stays. */
async function planBookkeeping(
  paths: ProjectPaths,
  fs: ProjectFileSystem,
  harness: Harness,
  manifest: AssetManifest,
  plan: Plan,
): Promise<Result<void>> {
  const state = await readInstallState(paths, fs);
  if (!state.ok) return state;
  if (state.value && state.value.harness === harness) {
    const removal = await removalOf(fs, paths.installState);
    if (!removal.ok) return removal;
    plan.mutations.push(removal.value);
  }
  const remaining = Object.fromEntries(
    Object.entries(manifest).filter(([path]) => !plan.forgotten.includes(path)),
  );
  if (Object.keys(remaining).length === Object.keys(manifest).length) return ok(undefined);
  if (Object.keys(remaining).length === 0) {
    const removal = await removalOf(fs, paths.assetManifest);
    if (!removal.ok) return removal;
    plan.mutations.push(removal.value);
    return ok(undefined);
  }
  const current = await fs.readTextIfExists(paths.assetManifest);
  if (!current.ok) return current;
  plan.mutations.push({
    kind: "write",
    path: paths.assetManifest,
    content: `${JSON.stringify(remaining, null, 2)}\n`,
    expectedBefore: filePrecondition(current.value),
  });
  return ok(undefined);
}

/** Directories install created and nothing else uses; `.visp/` and Git's are never touched. */
async function pruneEmptyDirectories(
  paths: ProjectPaths,
  fs: ProjectFileSystem,
  mutations: readonly FileMutation[],
): Promise<void> {
  const parents = new Set<string>();
  for (const mutation of mutations) {
    if (mutation.kind !== "remove") continue;
    const relative = paths.relative(mutation.path);
    if (relative === undefined || /^\.(?:visp|git)(?:\/|$)/u.test(relative)) continue;
    for (let dir = parentOf(relative); dir !== ""; dir = parentOf(dir)) parents.add(dir);
  }
  for (const dir of [...parents].sort((a, b) => b.length - a.length)) {
    // A directory that still holds something is not empty: the removal fails and it stays.
    await fs.removeDir(dir);
  }
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}
