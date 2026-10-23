import type { CriticConfig } from "../../config/critic.js";
import { resolveCriticPolicyDetails } from "../../config/critic-defaults.js";
import { vispError } from "../../core/errors.js";
import {
  applyFileTransaction,
  type FileMutation,
  filePrecondition,
} from "../../core/file-transaction.js";
import { createBranch, currentBranch } from "../../core/git.js";
import { sha256 } from "../../core/hash.js";
import { redactRequest } from "../../core/redaction.js";
import { err, ok, type Result } from "../../core/result.js";
import type { AcceptanceBaseline } from "../artifacts/acceptance.js";
import type { Intent } from "../artifacts/feature.js";
import { captureAcceptanceBaseline } from "../evidence/acceptance.js";
import { requireFeatureFoundation, requireImplementationFoundation } from "../gates/readiness.js";
import type { WorkspaceState } from "../state.js";
import { acceptedWorkOwner } from "./accepted-work.js";
import { draftFirstApplies, draftStartCommand, draftStartNote } from "./draft-first.js";
import { allocateFeatureId } from "./feature-id.js";
import { memoryFileMutations } from "./feature-memory.js";
import type { ProductFeatureOptions, ProductFeatureOutcome } from "./feature-model.js";
import {
  type DuplicateTerms,
  duplicateTerms,
  type FeatureRequest,
  featureRequest,
  recentDuplicate,
} from "./feature-request.js";
import {
  beginFeatureStart,
  codexHooksWarning,
  endFeatureStart,
  type HostRequest,
  hostRequest,
} from "./host-prompts.js";
import { captureInheritedChanges } from "./inherited-changes.js";
import { inheritedChangesContent, inheritedChangesPath } from "./inherited-record.js";
import {
  initialProductState,
  type ProductBrief,
  type ProductState,
  parseProductBrief,
} from "./model.js";
import { type FeatureProfile, featureProfile, leanCriticConfig } from "./profile.js";
import {
  mergeProjectRules,
  type ProjectRule,
  projectRulesMutation,
  readProjectRules,
} from "./project-rules.js";
import { accountedRequirements } from "./requirements.js";
import { withProductMutation } from "./runtime.js";
import { json, recordMutations, statusMutation } from "./store.js";

export async function createProductFeature(
  workspace: WorkspaceState,
  options: ProductFeatureOptions,
): Promise<Result<ProductFeatureOutcome>> {
  if (!options.goal.trim())
    return err(vispError("ARTIFACT_INVALID", "Feature goal cannot be empty"));
  // Rule and memory checks take up to 30 s; a worker whose tool returned early asked `next`,
  // was told to start a feature, and started a second one.
  await beginFeatureStart(workspace);
  try {
    return await startProductFeature(workspace, options);
  } finally {
    await endFeatureStart(workspace);
  }
}

async function startProductFeature(
  workspace: WorkspaceState,
  options: ProductFeatureOptions,
): Promise<Result<ProductFeatureOutcome>> {
  // Before the cleanliness check: the earlier feature's tester may have written its files.
  const host = await hostRequest(workspace, options.sourceBrief);
  if (!host.ok) return host;
  const raw = host.value?.request ?? options.sourceBrief ?? options.goal;
  const text = redactRequest(raw, workspace.paths.root);
  const earlier = await recentDuplicate(workspace, text, duplicateTerms(workspace, options));
  if (!earlier.ok) return earlier;
  if (earlier.value) return ok(earlier.value);
  const start = await withProductMutation(workspace, async () => {
    const foundation = await requireFeatureFoundation(workspace, "visp feature <goal>", (changed) =>
      acceptedWorkOwner(workspace, changed),
    );
    if (!foundation.ok) return foundation;
    const baseline = await captureAcceptanceBaseline(workspace);
    if (!baseline.ok) return baseline;
    const inherited = await captureInheritedChanges(workspace, foundation.value.inherited);
    if (!inherited.ok) return inherited;
    const { acceptedFeature } = foundation.value;
    return ok({
      baseline: baseline.value,
      inherited: inherited.value,
      ...(acceptedFeature ? { acceptedFeature } : {}),
    });
  });
  if (!start.ok) return start;
  const request = await featureRequest(workspace, host.value, raw, text);
  if (!request.ok) return request;
  const created = await withProductMutation(workspace, () =>
    createProductFeatureLocked(workspace, options, request.value, start.value),
  );
  if (!created.ok || !draftFirstApplies(workspace, created.value.brief)) return created;
  const { feature } = created.value.brief;
  return ok({
    ...created.value,
    draftCommand: draftStartCommand(feature),
    draftNote: draftStartNote(feature),
  });
}

interface FeatureStart {
  readonly baseline: AcceptanceBaseline;
  readonly inherited: Record<string, string>;
  /** The accepted feature the inherited changes are the uncommitted work of. */
  readonly acceptedFeature?: string;
}

/** The active-feature status, and the inherited record, which is written with the feature or not at all. */
async function localStateMutations(
  workspace: WorkspaceState,
  feature: string,
  inherited: Record<string, string>,
): Promise<Result<FileMutation[]>> {
  const status = await statusMutation(workspace, feature, undefined, "feature");
  if (!status.ok) return status;
  if (Object.keys(inherited).length === 0) return ok([status.value]);
  const path = inheritedChangesPath(workspace, feature);
  const existing = await workspace.files.readTextIfExists(path);
  if (!existing.ok) return existing;
  return ok([
    status.value,
    {
      kind: "write",
      path,
      content: inheritedChangesContent(inherited),
      expectedBefore: filePrecondition(existing.value),
    },
  ]);
}

function inheritedOutcome(inherited: Record<string, string>, acceptedFeature?: string) {
  const paths = Object.keys(inherited);
  return paths.length
    ? { inheritedChanges: paths, inheritedChangesNote: inheritedNote(paths, acceptedFeature) }
    : {};
}

function inheritedNote(paths: readonly string[], acceptedFeature?: string): string {
  const shown = paths.slice(0, 20).join(", ");
  const more = paths.length > 20 ? ` and ${paths.length - 20} more` : "";
  const cause = acceptedFeature
    ? `${paths.length} uncommitted change(s) are the accepted work of ${acceptedFeature}, so they stay uncommitted until the user commits them`
    : `Git cannot be written here, so ${paths.length} uncommitted change(s) from earlier work stay uncommitted`;
  return `${cause}: ${shown}${more}. Keep them: they are recorded as this feature's starting point and are not attributed to it unless you change those files further. Never discard them with git checkout, restore, reset or rm. Continue with visp work.`;
}

async function createProductFeatureLocked(
  workspace: WorkspaceState,
  options: ProductFeatureOptions,
  request: FeatureRequest,
  start: FeatureStart,
): Promise<Result<ProductFeatureOutcome>> {
  const { baseline, inherited, acceptedFeature } = start;
  if (!options.goal.trim())
    return err(vispError("ARTIFACT_INVALID", "Feature goal cannot be empty"));
  // Cleanliness was checked before model/service calls, which may write their own logs.
  const foundation = await requireImplementationFoundation(workspace, "visp feature <goal>");
  if (!foundation.ok) return foundation;
  const goal = redactRequest(options.goal, workspace.paths.root);
  const allocated = await newFeatureId(
    workspace,
    request.request,
    goal,
    duplicateTerms(workspace, options),
  );
  if (!allocated.ok) return allocated;
  if ("duplicate" in allocated.value) return ok(allocated.value.duplicate);
  const feature = allocated.value.feature;
  const timestamp = new Date().toISOString();
  const { host, memory } = request;
  const rules = await featureProjectRules(workspace, request.stated, feature, timestamp);
  if (!rules.ok) return rules;
  const parsed = parseProductBrief({
    version: 2,
    feature,
    goal,
    originalRequest: request.originalRequest,
    acceptanceBaseline: baseline,
  });
  if (!parsed.ok) return parsed;
  const brief = parsed.value;
  const resolved = await resolveCriticPolicyDetails(
    workspace.config.harness,
    workspace.config.critic,
  );
  if (!resolved.ok) return resolved;
  const profile = featureProfile(workspace, { brief });
  const critic = featureCritic(profile, resolved.value, workspace);
  const featureMetadata = await createFeatureMetadata(workspace, brief, options, timestamp);
  const { intent, branchCreated, branchWarning } = featureMetadata;
  const local = await localStateMutations(workspace, feature, inherited);
  if (!local.ok) return local;
  const saved = await applyFileTransaction(workspace.paths.root, "create-product-feature", [
    ...recordMutations(workspace, undefined, brief, {
      ...initialProductState(brief, timestamp),
      ...criticStateFields(critic),
    }),
    {
      kind: "write",
      path: workspace.paths.featureFile(feature, "intent.json"),
      content: json(intent),
      expectedBefore: { existed: false },
    },
    ...local.value,
    ...(host?.mutation ? [host.mutation] : []),
    ...rules.value.mutations,
    ...memory.mutations,
    ...memoryFileMutations(workspace, feature, memory),
  ]);
  return saved.ok
    ? ok({
        brief,
        intent,
        profile,
        ...requirementsOutcome(brief),
        ...rules.value.reported,
        ...memory.reported,
        redactionNotice: featureRedactionNotice(request.redacted, goal, options.goal),
        ...(branchCreated ? { branchCreated } : {}),
        ...(branchWarning ? { branchWarning } : {}),
        ...inheritedOutcome(inherited, acceptedFeature),
        ...hooksWarning(workspace, host),
      })
    : saved;
}

/** The requirements the request states, which the worker accounts for at `visp done`. */
function requirementsOutcome(brief: ProductBrief) {
  const listed = accountedRequirements(brief.originalRequest);
  if (!listed.length) return {};
  return {
    requirements: listed.map((entry) => `${entry.id}: ${entry.statement}`),
    requirementsNote: `The request states ${listed.length} requirement${listed.length === 1 ? "" : "s"} (${listed[0]?.id}${listed.length > 1 ? `–${listed.at(-1)?.id}` : ""}), parallel branches listed separately. Deliver every one. The visp done that completes the feature asks for an account of each, all in that one command: --account "${listed[0]?.id}=<passing check id> <test name>" "${listed[1]?.id}=…", or "${listed[0]?.id}=not done: <reason>". Name the tests exactly as the check prints them; VISP looks them up in its output. visp work prints the full command.`,
  };
}

/** A new feature id, or the earlier feature a concurrent create of this request already made. */
async function newFeatureId(
  workspace: WorkspaceState,
  request: string,
  goal: string,
  terms: DuplicateTerms | undefined,
): Promise<Result<{ feature: string } | { duplicate: ProductFeatureOutcome }>> {
  const listed = await workspace.store.listFeatures();
  if (!listed.ok) return listed;
  // Authoritative under the lock: the check before it could not see a create in flight.
  const duplicate = await recentDuplicate(workspace, request, terms, listed.value);
  if (!duplicate.ok) return duplicate;
  if (duplicate.value) return ok({ duplicate: duplicate.value });
  const allocated = await allocateFeatureId(workspace.paths.root, listed.value, goal);
  return allocated.ok ? ok({ feature: allocated.value }) : allocated;
}

/**
 * Rules the user stated for later work in the prompts this feature consumes are recorded.
 * Work replies, the tester and the reviewer read the current rules. Only recorded user
 * prompts count, never a worker's text.
 */
async function featureProjectRules(
  workspace: WorkspaceState,
  stated: readonly string[],
  feature: string,
  capturedAt: string,
): Promise<
  Result<{
    mutations: FileMutation[];
    reported: { projectRules?: ProjectRule[] };
  }>
> {
  const recorded = await readProjectRules(workspace);
  if (!recorded.ok) return recorded;
  const merged = mergeProjectRules(recorded.value.rules, stated, feature, capturedAt);
  return ok({
    mutations: merged.added.length
      ? [projectRulesMutation(workspace, recorded.value.before, merged.rules)]
      : [],
    reported: merged.rules.length ? { projectRules: merged.rules } : {},
  });
}

interface FeatureCriticPolicy {
  readonly enabled: boolean;
  readonly manual?: boolean;
  readonly config?: CriticConfig;
}

/**
 * The reviewer a new feature pins. A lean feature reviews with the lean model, and runs no
 * reviewer at all unless a critic mode was set (D13): in batch B2 lean with and without VISP's
 * reviewer scored the same hidden checks and probes, and the reviewer cost more. It keeps the
 * full reviewer's configuration, which an escalation to the full profile turns on.
 */
function featureCritic(
  profile: FeatureProfile,
  resolved: { policy: FeatureCriticPolicy; sources: { mode: { source: string } } },
  workspace: WorkspaceState,
): FeatureCriticPolicy & { leanOff?: true } {
  const { policy } = resolved;
  if (profile.name !== "lean" || !policy.config) return policy;
  if (resolved.sources.mode.source === "built-in" && policy.enabled)
    return { ...policy, enabled: false, leanOff: true };
  return { ...policy, config: leanCriticConfig(workspace, policy.config) };
}

function criticStateFields(critic: {
  enabled: boolean;
  manual?: boolean;
  config?: ProductState["criticDefault"];
  leanOff?: true;
}) {
  return {
    criticEnabled: critic.enabled,
    ...(critic.leanOff ? { criticLeanOff: true } : {}),
    ...(critic.manual ? { criticManual: true } : {}),
    ...(critic.config ? { criticDefault: critic.config } : {}),
  };
}

async function createFeatureMetadata(
  workspace: WorkspaceState,
  brief: ProductBrief,
  options: ProductFeatureOptions,
  timestamp: string,
): Promise<Omit<ProductFeatureOutcome, "brief">> {
  let branchCreated: string | undefined;
  let branchWarning: string | undefined;
  if (options.branch) {
    const name = `feature/${brief.feature}`;
    const created = await createBranch(workspace.paths.root, name);
    if (created.ok) branchCreated = name;
    else branchWarning = created.error.message;
  }
  const branch = await currentBranch(workspace.paths.root);
  const intent: Intent = {
    kind: "intent",
    createdAt: timestamp,
    id: brief.feature,
    goal: brief.goal,
    sourceBrief: brief.originalRequest,
    sourceBriefHash: sha256(brief.originalRequest),
    riskLevel: options.riskLevel ?? "low",
    acceptanceBaseline: brief.acceptanceBaseline,
    ...(branch.ok && branch.value.trim() !== "HEAD" ? { branch: branch.value.trim() } : {}),
  };
  return { intent, branchCreated, branchWarning };
}

function hooksWarning(workspace: WorkspaceState, host: HostRequest | undefined) {
  const warning = codexHooksWarning(workspace.config.harness, host);
  return warning ? { hostHooksWarning: warning } : {};
}

function featureRedactionNotice(requestChanged: boolean, goal: string, originalGoal: string) {
  return requestChanged || goal !== originalGoal
    ? "Credentials and local paths were masked before saving the request to the committed feature trail and PR text."
    : undefined;
}
