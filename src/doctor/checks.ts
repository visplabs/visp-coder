import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { browserExecutableIdentity } from "../core/browser-executable.js";
import { CONFIG_FILE, LEGACY_STATE_IGNORE, PRODUCT_NAME, STATE_DIR } from "../core/constants.js";
import { describeCommand, resolveCommand, run } from "../core/exec.js";
import { inspectFileTransactions } from "../core/file-transaction.js";
import { isRepository, workingTreeChanges } from "../core/git.js";
import { ok, type Result } from "../core/result.js";
import { inspectStateLock, STATE_LOCK_DIRECTORY } from "../core/state-lock.js";
import { checkCurrency, openProjectStore } from "../graph/index.js";
import { skillCatalog } from "../skills/catalog.js";
import { SKILL_STATES } from "../skills/schema.js";
import { readIndex } from "../skills/store.js";
import { findTask, type TaskGraph } from "../workflow/artifacts/tasks.js";
import { foreignHostFile, hostFileProtection } from "../workflow/product/byproducts.js";
import { describeProductCheck } from "../workflow/product/check/check-command.js";
import { readProductRecord } from "../workflow/product/store.js";
import type { WorkspaceState } from "../workflow/state.js";
import {
  checkEnforcement,
  checkHarnessActivation,
  checkHarnessAssets,
  checkMcpRegistration,
  checkPreviousHarnessAssets,
} from "./installation.js";
import { checkInstalledRuntime, checkPathRuntime } from "./runtime.js";

/**
 * One health command for the whole tool. A check that cannot determine its
 * answer reports `unknown` rather than `ok`: claiming health you did not verify
 * is the failure this tool exists to prevent.
 */

export type CheckStatus = "ok" | "warn" | "fail" | "unknown";

export interface Check {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly recovery?: string;
}

export type Verdict = "healthy" | "degraded" | "unhealthy";

export interface DoctorReport {
  readonly verdict: Verdict;
  readonly checks: readonly Check[];
}

export interface DoctorRuntime {
  /** Test seam; production executes the installed guard command. */
  readonly guardHandshake?: (root: string) => Promise<Result<void>>;
}

export async function runChecks(
  state: WorkspaceState,
  runtime: DoctorRuntime = {},
): Promise<DoctorReport> {
  const checks: Check[] = [
    await checkStateOwnership(state),
    await checkTransactions(state),
    await checkAuthorizationMarkers(state),
    await checkState(state),
    await checkConfig(state),
    await checkInstalledRuntime(state),
    await checkPathRuntime(state),
    await checkGit(state),
    await checkForeignHostFiles(state),
    await checkHarnessAssets(state),
    await checkMcpRegistration(state),
    await checkCodexTrust(state),
    await checkCodexCli(state),
    await checkClaudeCli(state),
    await checkHarnessActivation(state),
    await checkPreviousHarnessAssets(state),
    await checkEnforcement(state, runtime),
    await checkValidationCommands(state),
    await checkBrowser(state),
    await checkIndex(state),
    await checkEvidenceTracked(state),
    await checkSkillLibrary(state),
    checkPolicy(state),
    await checkFeature(state),
  ];

  const runtimeMismatch = checks.find(
    (check) => check.name === "installed runtime" && check.status === "fail",
  );
  const reported = runtimeMismatch
    ? checks.map((check) =>
        ["harness assets", "harness activation", "enforcement"].includes(check.name)
          ? {
              ...check,
              status: "unknown" as const,
              detail: `This CLI build differs from the installed runtime; ${check.name} cannot be judged against its templates`,
              recovery: undefined,
            }
          : check,
      )
    : checks;
  return { verdict: verdictFor(reported), checks: reported };
}

async function checkBrowser(state: WorkspaceState): Promise<Check> {
  if (!state.status?.activeFeature)
    return { name: "browser", status: "ok", detail: "No active browser journey declared" };
  const record = await readProductRecord(state);
  if (
    !record.ok ||
    !record.value.brief.checks.some(
      (check) =>
        typeof check.command === "object" &&
        !Array.isArray(check.command) &&
        check.command.kind === "browser-journey",
    )
  )
    return { name: "browser", status: "ok", detail: "No active browser journey declared" };
  const binary = await browserExecutableIdentity();
  return "missing" in binary
    ? {
        name: "browser",
        status: "warn",
        detail: `${binary.binary} is unavailable for browser journeys`,
        recovery: "Set CHROME_BIN to an installed Chrome or Chromium executable",
      }
    : { name: "browser", status: "ok", detail: `Browser executable found: ${binary.path}` };
}

async function checkCodexTrust(state: WorkspaceState): Promise<Check> {
  if (state.config.harness !== "codex")
    return {
      name: "codex hooks trust",
      status: "ok",
      detail: "Codex is not the selected coding host",
    };
  const configPath = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");
  let config = "";
  try {
    config = await readFile(configPath, "utf8");
  } catch {
    return {
      name: "codex hooks trust",
      status: "unknown",
      detail: "Codex hook trust could not be read",
      recovery: "Open Codex and run /hooks to trust .codex/hooks.json",
    };
  }
  const prefix = `${state.paths.root}/.codex/hooks.json:`;
  // Codex keys trust by event and entry position; the edit hook came later than the others,
  // so a project trusted before it has no entry for it and the hook does not run.
  const entries = [
    ["user_prompt_submit:0:", "the prompt hook"],
    ["pre_tool_use:0:", "the shell hook"],
    ["pre_tool_use:1:", "the edit hook"],
    ["stop:0:", "the Stop hook"],
  ];
  const missing = entries
    .filter(([entry]) => !config.includes(`${prefix}${entry}`))
    .map(([, name]) => name);
  const projectSection = config
    .split(`[projects.${JSON.stringify(state.paths.root)}]`)[1]
    ?.split(/^\[/mu)[0];
  if (!/^\s*trust_level\s*=\s*"trusted"/mu.test(projectSection ?? ""))
    missing.push("project trust");
  return missing.length === 0
    ? {
        name: "codex hooks trust",
        status: "ok",
        detail: "Project trust and prompt, shell, edit and Stop hook trust entries exist",
      }
    : {
        name: "codex hooks trust",
        status: "unknown",
        detail: `Codex hook trust is unverified for ${missing.join(", ")}`,
        recovery:
          "Open Codex and run /hooks to trust .codex/hooks.json before headless runs, again after an upgrade adds a hook",
      };
}

async function checkCodexCli(state: WorkspaceState): Promise<Check> {
  if (state.config.critic?.launch !== "codex-exec")
    return { name: "codex critic CLI", status: "ok", detail: "Codex exec is not selected" };
  const version = await run("codex", ["--version"], { cwd: state.paths.root, timeoutMs: 5000 });
  if (!version.ok || version.value.exitCode !== 0)
    return {
      name: "codex critic CLI",
      status: "warn",
      detail: "Codex CLI is unavailable",
      recovery: "Install the Codex CLI or choose another critic.launch",
    };
  const login = await run("codex", ["login", "status"], { cwd: state.paths.root, timeoutMs: 5000 });
  return login.ok && login.value.exitCode === 0
    ? { name: "codex critic CLI", status: "ok", detail: "Codex CLI is available and signed in" }
    : {
        name: "codex critic CLI",
        status: "unknown",
        detail: "Codex sign-in could not be verified",
        recovery: "Run codex login status and sign in if needed",
      };
}

async function checkClaudeCli(state: WorkspaceState): Promise<Check> {
  if (state.config.critic?.launch !== "claude-exec")
    return { name: "claude critic CLI", status: "ok", detail: "Claude exec is not selected" };
  if (state.config.critic.harness !== "claude-code")
    return {
      name: "claude critic CLI",
      status: "warn",
      detail: "critic.launch: claude-exec requires critic.harness: claude-code",
      recovery: "Set critic.harness: claude-code or choose another critic.launch",
    };
  const version = await run("claude", ["--version"], { cwd: state.paths.root, timeoutMs: 5000 });
  if (!version.ok || version.value.exitCode !== 0)
    return {
      name: "claude critic CLI",
      status: "warn",
      detail: "Claude Code CLI is unavailable",
      recovery: "Install Claude Code and sign in, or choose another critic.launch",
    };
  const login = await run("claude", ["auth", "status", "--json"], {
    cwd: state.paths.root,
    timeoutMs: 10_000,
  });
  const signedIn =
    login.ok && login.value.exitCode === 0 && /"loggedIn"\s*:\s*true/.test(login.value.stdout);
  return signedIn
    ? {
        name: "claude critic CLI",
        status: "ok",
        detail: "Claude Code CLI is available and signed in",
      }
    : {
        name: "claude critic CLI",
        status: "warn",
        detail: "Claude Code is not signed in",
        recovery: "Run claude and sign in, or choose another critic.launch",
      };
}

async function checkStateOwnership(state: WorkspaceState): Promise<Check> {
  const inspected = await inspectStateLock(state.paths.root);
  if (!inspected.ok)
    return { name: "state ownership", status: "unknown", detail: inspected.error.message };
  const ownership = inspected.value;
  if (ownership.state === "unlocked")
    return { name: "state ownership", status: "ok", detail: "No active mutation owner" };
  if (ownership.state === "active")
    return {
      name: "state ownership",
      status: "warn",
      detail: `VISP process ${ownership.owner?.pid} is writing; retry after it finishes`,
    };
  return {
    name: "state ownership",
    status: "fail",
    detail:
      ownership.state === "abandoned"
        ? "The previous mutation owner has exited"
        : "Mutation ownership cannot be established; no automatic lock deletion is safe",
    recovery:
      ownership.state === "abandoned"
        ? `${PRODUCT_NAME} doctor --fix`
        : `Inspect ${STATE_LOCK_DIRECTORY}/owner.json and the named host before recovering ownership${ownership.owner ? `; after confirming it has stopped, run visp doctor --fix --recover-lock ${ownership.owner.token}` : ""}`,
  };
}

async function checkAuthorizationMarkers(state: WorkspaceState): Promise<Check> {
  const inconsistent = await inconsistentAuthorizationMarkers(state);
  if (!inconsistent.ok) {
    return {
      name: "authorization markers",
      status: "fail",
      detail: `Authorization state could not be checked: ${inconsistent.error.message}`,
      recovery: `${PRODUCT_NAME} doctor --fix`,
    };
  }
  if (inconsistent.value.length === 0) {
    return { name: "authorization markers", status: "ok", detail: "No stale authorizations" };
  }
  return {
    name: "authorization markers",
    status: "warn",
    detail: `Stale authorization for ${inconsistent.value.join(", ")}`,
    recovery: `${PRODUCT_NAME} doctor --fix`,
  };
}

/** Machine-local markers whose tracked task is done, missing, or no longer readable. */
export async function inconsistentAuthorizationMarkers(
  state: WorkspaceState,
): Promise<Result<string[]>> {
  const markers = await state.store.readActiveMarkers();
  if (!markers.ok) return markers;
  const graphs = new Map<string, Result<TaskGraph | undefined>>();
  const inconsistent: string[] = [];
  for (const marker of markers.value) {
    let graph = graphs.get(marker.feature);
    if (!graph) {
      graph = await state.store.readTasksIfExists(marker.feature);
      graphs.set(marker.feature, graph);
    }
    if (!graph.ok) return graph;
    const task = graph.value ? findTask(graph.value, marker.task) : undefined;
    if (!task || task.status === "done") inconsistent.push(marker.task);
  }
  return ok(inconsistent.sort());
}

async function checkTransactions(state: WorkspaceState): Promise<Check> {
  const ownership = await inspectStateLock(state.paths.root);
  if (ownership.ok && ownership.value.state === "active")
    return {
      name: "file transactions",
      status: "warn",
      detail: "Another active writer may be applying a transaction; it will not be recovered",
    };
  const inspected = await inspectFileTransactions(state.paths.root);
  if (!inspected.ok) {
    return {
      name: "file transactions",
      status: "fail",
      detail: `Transaction journals could not be read: ${inspected.error.message}`,
      recovery: `Inspect ${STATE_DIR}/state/transactions before making more changes`,
    };
  }
  if (inspected.value.pending.length > 0) {
    return {
      name: "file transactions",
      status: "fail",
      detail: `${inspected.value.pending.length} interrupted transaction(s) need rollback`,
      recovery: `${PRODUCT_NAME} doctor --fix`,
    };
  }
  if (inspected.value.committed.length > 0) {
    return {
      name: "file transactions",
      status: "warn",
      detail: `${inspected.value.committed.length} committed transaction journal(s) need cleanup`,
      recovery: `${PRODUCT_NAME} doctor --fix`,
    };
  }
  return { name: "file transactions", status: "ok", detail: "No interrupted file updates" };
}

async function checkSkillLibrary(state: WorkspaceState): Promise<Check> {
  const index = await readIndex(state);
  if (!index.ok) {
    return {
      name: "skill library",
      status: "unknown",
      detail: `Could not read the skill library: ${index.error.message}`,
    };
  }
  if (index.value.skills.length === 0) {
    const available = skillCatalog().map((skill) => skill.id);
    return {
      name: "skill library",
      status: "ok",
      detail:
        "The skill library is empty; no procedure can enter a context pack" +
        (available.length > 0
          ? `. Optional catalog: ${available.join(", ")} (run: ${PRODUCT_NAME} skill catalog)`
          : ""),
    };
  }

  const counts = SKILL_STATES.flatMap((skillState) => {
    const count = index.value.skills.filter((skill) => skill.state === skillState).length;
    return count === 0 ? [] : [`${skillState} ${count}`];
  });
  return {
    name: "skill library",
    status: "ok",
    detail: `${index.value.skills.length} skills: ${counts.join(", ")}`,
  };
}

async function checkState(state: WorkspaceState): Promise<Check> {
  const present = await state.files.exists(state.paths.state);
  if (!present.ok) {
    return {
      name: "state directory",
      status: "fail",
      detail: `State directory could not be checked: ${present.error.message}`,
      recovery: `${PRODUCT_NAME} doctor --fix`,
    };
  }
  return present.value
    ? { name: "state directory", status: "ok", detail: `${STATE_DIR}/ exists` }
    : {
        name: "state directory",
        status: "fail",
        detail: `${STATE_DIR}/ is missing`,
        recovery: `${PRODUCT_NAME} init --harness ${state.config.harness}`,
      };
}

async function checkConfig(state: WorkspaceState): Promise<Check> {
  const present = await state.files.exists(state.paths.config);
  if (!present.ok) {
    return {
      name: "configuration",
      status: "fail",
      detail: `Configuration could not be checked: ${present.error.message}`,
      recovery: `${PRODUCT_NAME} init --harness ${state.config.harness}`,
    };
  }
  return present.value
    ? {
        name: "configuration",
        status: state.config.preset === "go" || state.config.preset === "rust" ? "warn" : "ok",
        detail:
          state.config.preset === "go" || state.config.preset === "rust"
            ? `${CONFIG_FILE} loaded, preset ${state.config.preset} — note: the index parses ts/js/python only, so structural answers fall back to paths here`
            : `${CONFIG_FILE} loaded, preset ${state.config.preset}`,
      }
    : {
        name: "configuration",
        status: "warn",
        detail: `No ${CONFIG_FILE}; defaults are in use`,
        recovery: `${PRODUCT_NAME} init --harness ${state.config.harness}`,
      };
}

async function checkGit(state: WorkspaceState): Promise<Check> {
  const repository = await isRepository(state.paths.root);
  if (repository) {
    return { name: "git", status: "ok", detail: "Repository found, so diffs can be checked" };
  }
  const featureWorkExists = state.status?.activeFeature !== undefined;
  return {
    name: "git",
    status: featureWorkExists ? "fail" : "warn",
    detail: featureWorkExists
      ? "Feature work exists outside a Git repository, so it cannot be authorized or evidenced against a before-tree"
      : "Not a git repository, so scope checks cannot read a diff",
    recovery: "git init",
  };
}

/** Another host's files that appeared in the project are ignored as product; say which. */
async function checkForeignHostFiles(state: WorkspaceState): Promise<Check> {
  const name = "other host files";
  if (!(await isRepository(state.paths.root)))
    return { name, status: "unknown", detail: "Not a git repository" };
  const changes = await workingTreeChanges(state.paths.root);
  if (!changes.ok) return { name, status: "unknown", detail: changes.error.message };
  const record = state.status?.activeFeature ? await readProductRecord(state) : undefined;
  const protection = hostFileProtection(state, record?.ok ? record.value.brief : undefined);
  const foreign = changes.value.files
    .filter((file) => file.status === "untracked")
    .map((file) => file.path)
    .filter((path) => foreignHostFile(path, false, state.config.harness, protection));
  if (!foreign.length)
    return { name, status: "ok", detail: "No untracked files of another coding host" };
  // Not a warning with a fix: committing them makes them product again (and a scope failure)
  // and deleting them removes another app's files.
  const shown = foreign.slice(0, 5).join(", ");
  return {
    name,
    status: "ok",
    detail: `VISP ignores these as product: ${shown}${foreign.length > 5 ? ` (+${foreign.length - 5} more)` : ""}; no action needed`,
  };
}

/** Product checks and configured project commands both participate in verification. */
async function checkValidationCommands(state: WorkspaceState): Promise<Check> {
  const configured = state.config.workflow.validationCommands;

  // There is no shell, so a chained or env-prefixed command cannot run. Caught
  // here it is a typo; found at verify it is a `refused` on work already done.
  const unrunnable = configured.filter((spec) => !resolveCommand(spec).ok).map(describeCommand);
  if (unrunnable.length > 0) {
    return {
      name: "validation commands",
      status: "fail",
      detail: `Cannot run without a shell: ${unrunnable.join("; ")}`,
      recovery: "One entry is one command. Split it in two, or give it as a list of arguments.",
    };
  }

  const product = await checkProductValidation(state);
  if (product) return product;

  if (configured.length > 0) {
    return {
      name: "validation commands",
      status: "ok",
      detail: `${configured.length} configured: ${configured.map(describeCommand).join(", ")}`,
    };
  }

  const feature = state.status?.activeFeature;
  if (feature) {
    const graph = await state.store.readTasksIfExists(feature);
    if (
      graph.ok &&
      graph.value?.tasks.some(
        (task) => task.validationCommands.length > 0 || (task.validationChecks?.length ?? 0) > 0,
      )
    ) {
      return {
        name: "validation commands",
        status: "ok",
        detail: "Tasks declare their own validation commands",
      };
    }
  }

  return {
    name: "validation commands",
    status: "warn",
    detail: "None configured, so verify cannot prove anything ran",
    recovery: `Add workflow.validationCommands to ${CONFIG_FILE}`,
  };
}

async function checkProductValidation(state: WorkspaceState): Promise<Check | undefined> {
  if (!state.status?.activeFeature) return undefined;
  const record = await readProductRecord(state);
  if (!record.ok) {
    if (record.error.code === "MIGRATION_REQUIRED") return undefined;
    return {
      name: "validation commands",
      status: "fail",
      detail: `Product checks could not be inspected: ${record.error.message}`,
      recovery: record.error.recovery ?? `${PRODUCT_NAME} brief`,
    };
  }
  const checks = record.value.brief.checks;
  const configured = state.config.workflow.validationCommands.length;
  const supplementary = `${configured} configured project check(s) also run during verification.`;
  return checks.length > 0
    ? {
        name: "validation commands",
        status: "ok",
        detail: `Product brief declares ${checks.length} check(s): ${checks.map((check) => `${check.id}: ${describeProductCheck(check)}`).join(", ")}. ${supplementary} This confirms configuration, not execution or acceptance.`,
      }
    : {
        name: "validation commands",
        status: "warn",
        detail: `No execution checks declared in the active product brief. ${supplementary}`,
        recovery: `Define relevant checks in ${PRODUCT_NAME} brief; configured project commands do not replace checks linked to product outcomes`,
      };
}

/**
 * Without an index, context packs fall back to path matching, which quietly
 * gives an agent less than it could have had.
 */
async function checkIndex(state: WorkspaceState): Promise<Check> {
  const present = await state.files.exists(state.paths.graphStore);
  if (!present.ok) {
    return {
      name: "repository index",
      status: "fail",
      detail: `The index path could not be checked: ${present.error.message}`,
      recovery: `${PRODUCT_NAME} index`,
    };
  }
  if (!present.value) {
    return {
      name: "repository index",
      status: "warn",
      detail: "Not built, so context packs cannot use structure",
      recovery: `${PRODUCT_NAME} index`,
    };
  }

  const store = await openProjectStore(state.files, state.paths.graphStore);
  if (!store.ok) {
    return {
      name: "repository index",
      status: "fail",
      detail: `The index could not be opened: ${store.error.message}`,
      recovery: `${PRODUCT_NAME} index`,
    };
  }

  try {
    const head = store.value.readHead();
    if (!head.ok || !head.value) {
      return {
        name: "repository index",
        status: "warn",
        detail: "The index has no snapshot yet",
        recovery: `${PRODUCT_NAME} index`,
      };
    }

    if (head.value.root !== state.paths.root)
      return {
        name: "repository index",
        status: "warn",
        detail: "The index belongs to another checkout and cannot supply current product context",
        recovery: `${PRODUCT_NAME} index --refresh`,
      };

    const currency = await checkCurrency(state.paths.root, head.value, state.config.graph);
    if (!currency.ok || currency.value.state === "unverified") {
      return {
        name: "repository index",
        status: "unknown",
        detail: "The index could not be compared against the worktree",
      };
    }

    if (currency.value.state === "divergent") {
      const { added, changed, deleted } = currency.value.counts;
      return {
        name: "repository index",
        status: "warn",
        detail: `Behind the worktree: ${added} added, ${changed} changed, ${deleted} deleted`,
        recovery: `${PRODUCT_NAME} index --refresh`,
      };
    }

    return {
      name: "repository index",
      status: "ok",
      detail: `${head.value.entities.length} entities, current with the worktree`,
    };
  } finally {
    store.value.close();
  }
}

/**
 * Earlier versions ignored the whole state directory, which left the evidence
 * trail on one machine. Report it rather than rewriting someone's .gitignore.
 */
async function checkEvidenceTracked(state: WorkspaceState): Promise<Check> {
  if (!(await isRepository(state.paths.root))) {
    return {
      name: "evidence trail",
      status: "unknown",
      detail: "Git is unavailable, so Visp cannot determine whether its evidence can be committed",
      recovery: "git init",
    };
  }

  const ignore = await state.files.readTextIfExists(".gitignore");
  if (!ignore.ok || ignore.value === undefined) {
    return {
      name: "evidence trail",
      status: "ok",
      detail: "Evidence paths are not ignored and can be committed",
    };
  }

  const lines = new Set(ignore.value.split("\n").map((line) => line.trim()));
  if (!lines.has(LEGACY_STATE_IGNORE)) {
    return {
      name: "evidence trail",
      status: "ok",
      detail: "Spec, plan, tasks and evidence are not ignored and can be committed",
    };
  }

  return {
    name: "evidence trail",
    status: "ok",
    detail: `.gitignore deliberately keeps ${STATE_DIR}/ local; share any evidence needed for review separately`,
  };
}

function checkPolicy(state: WorkspaceState): Check {
  return {
    name: "policy",
    status: "ok",
    detail: `Strictness is ${state.policy.strictness}, with ${state.overrides.length} override(s)`,
  };
}

async function checkFeature(state: WorkspaceState): Promise<Check> {
  const feature = state.status?.activeFeature;

  // Having no feature yet is the normal state right after setup, not a fault.
  if (!feature) {
    return {
      name: "active feature",
      status: "ok",
      detail: `None yet. Start one with: ${PRODUCT_NAME} feature "<goal>"`,
    };
  }

  const intent = await state.store.readIntent(feature);
  return intent.ok
    ? { name: "active feature", status: "ok", detail: `${feature}: ${intent.value.goal}` }
    : {
        name: "active feature",
        status: "fail",
        detail: `${feature} is active but its intent could not be read`,
        recovery: `${PRODUCT_NAME} status`,
      };
}

function verdictFor(checks: readonly Check[]): Verdict {
  if (checks.some((check) => check.status === "fail")) return "unhealthy";
  if (checks.some((check) => check.status === "warn" || check.status === "unknown")) {
    return "degraded";
  }
  return "healthy";
}
