import { resolveCriticPolicy } from "../../../config/critic-defaults.js";
import { vispError } from "../../../core/errors.js";
import { run } from "../../../core/exec.js";
import { applyFileTransaction } from "../../../core/file-transaction.js";
import { hashValue } from "../../../core/hash.js";
import { err, ok, type Result } from "../../../core/result.js";
import type { WorkspaceState } from "../../state.js";
import { featureProfile } from "../profile.js";
import type { ProductRecord } from "../store.js";
import { productSourceSnapshot } from "../subject.js";
import { retryBusy } from "./independent-tests-record.js";

const START_SOURCE = "tester-source-digest";
/** Whether the project had existing code when the tester first started, beside its digest. */
const START_MODE = "tester-launch-mode";
const EXISTING_CODE_MODE = "existing-code";
const NEW_PROJECT_MODE = "new-project";

export async function readStartingSource(
  workspace: WorkspaceState,
  feature: string,
): Promise<Result<string | undefined>> {
  const stored = await workspace.files.readTextIfExists(
    workspace.paths.featureFile(feature, START_SOURCE),
  );
  if (!stored.ok) return stored;
  if (stored.value === undefined) return ok(undefined);
  const digest = stored.value.trim();
  return /^[a-f0-9]{64}$/.test(digest)
    ? ok(digest)
    : err(vispError("ARTIFACT_INVALID", `Unreadable ${START_SOURCE}`));
}

export async function startingSourceDigest(
  workspace: WorkspaceState,
  feature: string,
  brief: ProductRecord["brief"],
): Promise<Result<string>> {
  const stored = await readStartingSource(workspace, feature);
  if (!stored.ok) return stored;
  if (stored.value) return ok(stored.value);
  const source = await productSourceSnapshot(workspace, brief);
  if (!source.ok) return source;
  const digest = hashValue(source.value);
  const mode = (await existingCode(workspace.paths.root)) ? EXISTING_CODE_MODE : NEW_PROJECT_MODE;
  const saved = await retryBusy(() =>
    applyFileTransaction(workspace.paths.root, "record-tester-source", [
      {
        kind: "write",
        path: workspace.paths.featureFile(feature, START_SOURCE),
        content: `${digest}\n`,
        expectedBefore: { existed: false },
      },
      {
        kind: "write",
        path: workspace.paths.featureFile(feature, START_MODE),
        content: `${mode}\n`,
        expectedBefore: { existed: false },
      },
    ]),
  );
  if (!saved.ok) return saved;
  return ok(digest);
}

/**
 * Whether the tester runs in execution mode, as decided when it first started: a retry after
 * files were added or committed keeps its launch mode. Features started before VISP recorded
 * the mode use the project as it is now; `executionRefusal` still guards that case.
 */
export async function launchedOnExistingCode(
  workspace: WorkspaceState,
  feature: string,
): Promise<Result<boolean>> {
  const stored = await workspace.files.readTextIfExists(
    workspace.paths.featureFile(feature, START_MODE),
  );
  if (!stored.ok) return stored;
  if (stored.value === undefined) return ok(await existingCode(workspace.paths.root));
  const mode = stored.value.trim();
  return mode === EXISTING_CODE_MODE || mode === NEW_PROJECT_MODE
    ? ok(mode === EXISTING_CODE_MODE)
    : err(vispError("ARTIFACT_INVALID", `Unreadable ${START_MODE}`));
}

/**
 * Execution mode gives the tester a writable, networked repository copy. A first launch gets
 * it only with `critic.existingCodeTests: true` (testerApplies); retries and direct runs too.
 */
export function executionRefusal(
  workspace: WorkspaceState,
  feature: string,
  existingCodebase: boolean,
): string | undefined {
  if (!existingCodebase || workspace.config.critic?.existingCodeTests === true) return undefined;
  return `The independent tester of ${feature} was not run: on an existing codebase it runs in execution mode (a writable repository copy with network access), which VISP allows only with critic.existingCodeTests: true in visp.yml`;
}

const SOURCE_FILE =
  /\.(py|mjs|cjs|js|jsx|ts|tsx|go|rs|java|kt|rb|php|cs|c|cc|cpp|h|hpp|swift|scala|ex|exs|sh)$/;

const EXISTING_CODE_FILES = 3;
const TOOLING = /^(\.visp|\.claude|\.agents|\.codex|\.github|\.specify|_bmad|node_modules)\//;

/**
 * New projects by default. On an existing codebase, read-only testers assumed routes, error
 * formats and setup the code does not have, and workers changed correct code to satisfy
 * them. With `critic.existingCodeTests: true` the tester runs the existing program in a
 * disposable copy and must pass tests of existing behavior first; in trials 11 of 14 pinned
 * suites were correct; the rest assumed wrong setup, status codes or error bodies, so it
 * stays opt-in.
 */
export async function existingCode(root: string): Promise<boolean> {
  const listed = await run("git", ["ls-files"], { cwd: root, timeoutMs: 10_000 });
  if (!listed.ok || listed.value.exitCode !== 0) return false;
  // A few files are a scaffold; the trial codebase had seven source files.
  const sources = listed.value.stdout
    .split("\n")
    .filter((path) => SOURCE_FILE.test(path) && !TOOLING.test(path));
  return sources.length >= EXISTING_CODE_FILES;
}

export function hasFunctionalOutcome(brief: ProductRecord["brief"]): boolean {
  return brief.outcomes.some((outcome) => outcome.kind === "functional");
}

/**
 * Whether a feature would get a tester, whichever CLI launches it: once per feature, when the
 * critic is on and the project pins no acceptance checks of its own (existing code is opt-in).
 */
export async function testerApplies(
  workspace: WorkspaceState,
  record: ProductRecord,
): Promise<boolean> {
  if (record.brief.acceptanceBaseline.length || record.state.status === "accepted") return false;
  const existing = await existingCode(workspace.paths.root);
  if (existing && workspace.config.critic?.existingCodeTests !== true) return false;
  // A lean feature on a new project gets no tester: with Haiku 5.5 workers bare runs already
  // passed about 100% of hidden checks, and in September the tester had given about 16% of
  // VISP's gain with Haiku 4.5. Only the signs known at the start count, since a tester
  // launched after the work is written keeps no test that fails against it.
  if (!existing && featureProfile(workspace, { brief: record.brief }).name === "lean") return false;
  return criticEnabled(workspace);
}

async function criticEnabled(workspace: WorkspaceState): Promise<boolean> {
  const policy = await resolveCriticPolicy(workspace.config.harness, workspace.config.critic);
  return policy.ok && policy.value.enabled;
}

/**
 * Whether a tester for the critic's harness can test this project: a Codex tester any
 * project, a Claude tester new projects only. The starter decides which CLI launches it.
 */
export async function testerLaunches(
  workspace: WorkspaceState,
  record: ProductRecord,
): Promise<boolean> {
  if (!(await testerApplies(workspace, record))) return false;
  const policy = await resolveCriticPolicy(workspace.config.harness, workspace.config.critic);
  const harness = policy.ok ? policy.value.config?.harness : undefined;
  if (harness === "codex") return true;
  return harness === "claude-code" && !(await existingCode(workspace.paths.root));
}
