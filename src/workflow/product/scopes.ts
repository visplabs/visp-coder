import { z } from "zod";
import { vispError } from "../../core/errors.js";
import { committedChangesSince } from "../../core/git.js";
import { hashValue } from "../../core/hash.js";
import { err, ok, type Result } from "../../core/result.js";
import { checkPaths } from "../../orchestrate/guard.js";
import type { ImplementMarker } from "../artifacts/evidence.js";
import { cliCommand } from "../next-action.js";
import { resolveRule, ruleContextFor } from "../policy/resolve.js";
import type { ScopeOptions, WorkspaceState } from "../state.js";
import { currentHostSession } from "./host-prompts.js";
import { closedSlice, type ProductBrief, type ProductSlice, sliceDigest } from "./model.js";
import { changedProtectedEnvFiles } from "./protected-env.js";
import {
  authorizationPath,
  type ProductRecord,
  type ProductSelection,
  readProductRecord,
  reviewBaselinePath,
} from "./store.js";
import { productSourceChanges, productSourceSnapshot } from "./subject.js";

export const productAuthorizationSchema = z
  .object({
    version: z.literal(2),
    feature: z.string(),
    task: z.string(),
    createdAt: z.string(),
    root: z.string(),
    contractDigest: z.string(),
    baseline: z.record(z.string()),
    blockedPaths: z.array(z.string()).optional(),
    envBaseline: z.record(z.string()).optional(),
    headCommit: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .optional(),
    /** The host session that ran `visp work`, when the host's prompt hook reports one. */
    session: z.string().optional(),
  })
  .strict();
export type ProductAuthorization = z.infer<typeof productAuthorizationSchema>;

export function selectProductSlice(
  workspace: WorkspaceState,
  record: ProductRecord,
  options: ProductSelection,
  chooseNext = false,
): Result<ProductSlice | undefined> {
  const requested =
    options.task ??
    (workspace.status?.activeFeature === record.brief.feature
      ? workspace.status?.activeTask
      : undefined);
  if (requested !== undefined) {
    const slice = record.brief.slices.find((entry) => entry.id === requested);
    if (!slice && options.task !== undefined)
      return err(
        vispError(
          "TASK_NOT_FOUND",
          `${requested} is not a slice in ${record.brief.feature}. Valid slices: ${record.brief.slices.map((entry) => entry.id).join(", ") || "none"}`,
          {
            recovery: `visp work --feature ${record.brief.feature} --task <valid-id>`,
          },
        ),
      );
    if (
      slice &&
      (options.task !== undefined ||
        !chooseNext ||
        !closedSlice(record.state.slices[slice.id]?.status))
    )
      return ok(slice);
  }
  return ok(
    chooseNext
      ? record.brief.slices.find(
          (slice) =>
            !closedSlice(record.state.slices[slice.id]?.status) &&
            slice.dependsOn.every((id) => closedSlice(record.state.slices[id]?.status)),
        )
      : undefined,
  );
}

function markerForProduct(
  brief: ProductBrief,
  slice: ProductSlice,
  createdAt: string,
): ImplementMarker {
  return {
    kind: "implement-marker",
    createdAt,
    feature: brief.feature,
    task: slice.id,
    allowedFiles: slice.scope.allowed,
    expectedFiles: slice.scope.expected,
    forbiddenFiles: slice.scope.forbidden,
    contractHash: sliceDigest(brief, slice),
  };
}

export async function readProductAuthorization(
  workspace: WorkspaceState,
  record: ProductRecord,
): Promise<Result<ProductAuthorization | undefined>> {
  const retained = await readProductAuthorizationBaseline(
    workspace,
    record,
    authorizationPath(workspace, record.brief.feature),
  );
  if (!retained.ok || !retained.value) return retained;
  return ok(
    closedSlice(record.state.slices[retained.value.task]?.status) ? undefined : retained.value,
  );
}

/** Read-only baseline context, including closed slices; this never grants editing authority. */
export async function readProductAuthorizationBaseline(
  workspace: WorkspaceState,
  record: ProductRecord,
  path?: string,
): Promise<Result<ProductAuthorization | undefined>> {
  let content = await workspace.files.readTextIfExists(
    path ?? authorizationPath(workspace, record.brief.feature),
  );
  if (content.ok && content.value === undefined && path === undefined)
    content = await workspace.files.readTextIfExists(
      reviewBaselinePath(workspace, record.brief.feature),
    );
  if (!content.ok || content.value === undefined) return content.ok ? ok(undefined) : content;
  let input: unknown;
  try {
    input = JSON.parse(content.value);
  } catch {
    return err(vispError("ARTIFACT_INVALID", "Invalid product authorization"));
  }
  const parsed = productAuthorizationSchema.safeParse(input);
  if (!parsed.success) return err(vispError("ARTIFACT_INVALID", "Invalid product authorization"));
  const auth = parsed.data;
  const slice = record.brief.slices.find((entry) => entry.id === auth.task);
  // Old or copied baselines do not describe this checkout and contract.
  if (
    !slice ||
    auth.feature !== record.brief.feature ||
    auth.root !== hashValue(workspace.paths.root) ||
    auth.contractDigest !== sliceDigest(record.brief, slice)
  )
    return ok(undefined);
  return ok(auth);
}

export async function productScopes(
  workspace: WorkspaceState,
  options: ScopeOptions = {},
): Promise<Result<ImplementMarker[]>> {
  const record = await readProductRecord(workspace, options);
  if (!record.ok) return record.error.code === "NO_ACTIVE_FEATURE" ? ok([]) : record;
  const { brief, state } = record.value;
  if (options.source === "tasks")
    return ok(brief.slices.map((slice) => markerForProduct(brief, slice, state.createdAt)));
  const auth = await readProductAuthorization(workspace, record.value);
  if (!auth.ok) return auth;
  const earlier = await fromEarlierSession(workspace, auth.value, options.hostSession);
  if (!earlier.ok) return earlier;
  const active = earlier.value ? undefined : auth.value;
  return ok(
    brief.slices
      .filter(
        (slice) =>
          active?.task === slice.id ||
          (options.includeDone && closedSlice(state.slices[slice.id]?.status)),
      )
      .map((slice) => markerForProduct(brief, slice, active?.createdAt ?? state.createdAt)),
  );
}

/**
 * The feature's authorization when it was granted in an earlier host session. It still
 * records the slice's baseline, but permits no edits until `visp work` re-confirms it: a
 * later session usually carries a new request, which needs its own feature.
 */
export async function earlierSessionAuthorization(
  workspace: WorkspaceState,
  options: ScopeOptions = {},
): Promise<Result<ProductAuthorization | undefined>> {
  const record = await readProductRecord(workspace, options);
  if (!record.ok) return record.error.code === "NO_ACTIVE_FEATURE" ? ok(undefined) : record;
  const auth = await readProductAuthorization(workspace, record.value);
  if (!auth.ok) return auth;
  const earlier = await fromEarlierSession(workspace, auth.value, options.hostSession);
  if (!earlier.ok) return earlier;
  return ok(earlier.value ? auth.value : undefined);
}

/** Ignored secret-file changes that Git's staged and working-tree lists omit. */
export async function activeProtectedEnvChanges(
  workspace: WorkspaceState,
): Promise<Result<string[]>> {
  const record = await readProductRecord(workspace);
  if (!record.ok) return record.error.code === "NO_ACTIVE_FEATURE" ? ok([]) : record;
  const auth = await readProductAuthorization(workspace, record.value);
  if (!auth.ok) return auth;
  if (!auth.value) return ok([]);
  if (!auth.value.envBaseline)
    return err(
      vispError("STAGE_BLOCKED", "Re-authorize this slice to protect ignored environment files", {
        recovery: cliCommand("work", { task: auth.value.task }),
      }),
    );
  return changedProtectedEnvFiles(workspace.paths.root, auth.value.envBaseline);
}

/** Keep write-time blocked rules fixed to the config that granted the slice. */
export async function activeBlockedPaths(
  workspace: WorkspaceState,
): Promise<Result<readonly string[]>> {
  const record = await readProductRecord(workspace);
  if (!record.ok)
    return record.error.code === "NO_ACTIVE_FEATURE"
      ? ok(workspace.config.workflow.blockedPaths)
      : record;
  const auth = await readProductAuthorization(workspace, record.value);
  if (!auth.ok) return auth;
  return ok(auth.value?.blockedPaths ?? workspace.config.workflow.blockedPaths);
}

/** The feature's authorization, when it was granted in an earlier host session. */
export async function earlierSessionGrant(
  workspace: WorkspaceState,
  record: ProductRecord,
): Promise<Result<ProductAuthorization | undefined>> {
  const auth = await readProductAuthorization(workspace, record);
  if (!auth.ok) return auth;
  const earlier = await fromEarlierSession(workspace, auth.value);
  if (!earlier.ok) return earlier;
  return ok(earlier.value ? auth.value : undefined);
}

async function fromEarlierSession(
  workspace: WorkspaceState,
  auth: ProductAuthorization | undefined,
  asking?: string,
): Promise<Result<boolean>> {
  // Hosts without a session-reporting hook keep authorizations as before.
  if (!auth?.session) return ok(false);
  if (asking) return ok(asking !== auth.session);
  const current = await currentHostSession(workspace);
  if (!current.ok) return current;
  return ok(current.value !== undefined && current.value !== auth.session);
}

/** Enforce the active grant against content changes since authorization. */
export async function checkProductScope(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice,
): Promise<Result<{ committedChanges: string[]; changed: string[] }>> {
  const auth = await readProductAuthorization(workspace, record);
  if (!auth.ok) return auth;
  if (!auth.value || auth.value.task !== slice.id)
    return err(
      vispError("STAGE_BLOCKED", `No current authorization for ${slice.id}`, {
        recovery: cliCommand("work", { feature: record.brief.feature, task: slice.id }),
      }),
    );
  const current = await productSourceSnapshot(workspace, record.brief);
  if (!current.ok) return current;
  if (!auth.value.envBaseline)
    return err(
      vispError("STAGE_BLOCKED", "Re-authorize this slice to protect ignored environment files", {
        recovery: cliCommand("work", { task: slice.id }),
      }),
    );
  const changedEnv = await changedProtectedEnvFiles(workspace.paths.root, auth.value.envBaseline);
  if (!changedEnv.ok) return changedEnv;
  const committed = auth.value.headCommit
    ? await committedChangesSince(workspace.paths.root, auth.value.headCommit)
    : ok([]);
  if (!committed.ok) return committed;
  // Pinned acceptance files are VISP's, may be pinned mid-slice, and are hash-checked.
  const pinned = new Set(
    record.brief.acceptanceBaseline.flatMap((entry) => entry.files.map((file) => file.path)),
  );
  const changed = await productSourceChanges(
    workspace,
    auth.value.baseline,
    current.value,
    new Set([...committed.value, ...pinned]),
  );
  if (!changed.ok) return changed;
  const paths = changed.value;
  paths.push(...changedEnv.value.filter((path) => !paths.includes(path)));
  const context = ruleContextFor(workspace, {
    feature: record.brief.feature,
    task: slice.id,
    stage: "implement",
  });
  const allowedRule = resolveRule(
    "scope.allowed-files",
    workspace.policy,
    workspace.overrides,
    context,
  );
  const violations = checkPaths(paths, {
    markers: [markerForProduct(record.brief, slice, auth.value.createdAt)],
    blockedPaths: auth.value.blockedPaths ?? workspace.config.workflow.blockedPaths,
    enforceAllowedFiles: allowedRule.active,
  });
  const forbidden = violations
    .filter((entry) => entry.reason !== "outside-allowed-files")
    .map((entry) => entry.path);
  const outside = violations
    .filter((entry) => entry.reason === "outside-allowed-files")
    .map((entry) => entry.path);
  if (forbidden.length || outside.length)
    return err(
      // Workers never saw the details and deleted VISP state guessing which change it meant.
      vispError(
        "SCOPE_VIOLATION",
        `Changes exceed the authorized slice scope: ${scopeList(forbidden, outside)}`,
        {
          details: {
            forbidden,
            outside,
            committedChanges: committed.value,
            deleted: paths.filter((path) => current.value[path] === undefined),
          },
          recovery:
            "Inspect the named local changes against git diff HEAD. Preserve incoming committed content; undo only unintended local edits, or add intended ones to the slice scope with a reason and run visp work again. Never delete .visp/ or the pinned acceptance tests. Pass temporary brief input through --from - to avoid creating a product file.",
        },
      ),
    );
  const limit = workspace.policy.maxChangedFiles ?? workspace.config.workflow.maxChangedFiles;
  const limitRule = resolveRule("scope.max-changed-files", workspace.policy, workspace.overrides, {
    ...context,
    stage: "review",
  });
  if (limitRule.active && paths.length > limit)
    return err(
      vispError(
        "SCOPE_VIOLATION",
        `Changed-file count ${paths.length} exceeds configured limit ${limit}`,
        {
          details: { paths, committedChanges: committed.value },
          recovery:
            "Narrow the slice change or record a time-limited scope.max-changed-files override with a reason, then retry visp done. Preserve incoming committed content.",
        },
      ),
    );
  return ok({ committedChanges: committed.value, changed: paths });
}

function scopeList(forbidden: readonly string[], outside: readonly string[]): string {
  const named = [...new Set([...forbidden, ...outside])];
  const shown = named.slice(0, 8).join(", ");
  return named.length > 8 ? `${shown} and ${named.length - 8} more` : shown;
}

export function staleTaskNote(workspace: WorkspaceState, record: ProductRecord): string[] {
  const task =
    workspace.status?.activeFeature === record.brief.feature
      ? workspace.status.activeTask
      : undefined;
  return task && !record.brief.slices.some((slice) => slice.id === task)
    ? [
        `Ignored saved task ${task}, which is absent from this checkout's brief; selected the next available slice.`,
      ]
    : [];
}
