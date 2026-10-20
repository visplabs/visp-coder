import { vispError } from "../../core/errors.js";
import type { FileMutation } from "../../core/file-transaction.js";
import { filePrecondition } from "../../core/file-transaction.js";
import { currentBranch, headCommit } from "../../core/git.js";
import { hashValue } from "../../core/hash.js";
import { err, ok, type Result } from "../../core/result.js";
import { requireImplementationFoundation } from "../gates/readiness.js";
import type { WorkspaceState } from "../state.js";
import { updateProductBrief } from "./brief.js";
import { validateProductCheckCommand } from "./check/check-command.js";
import { uninstalledAlias } from "./check/check-executable.js";
import { buildProductContext } from "./context.js";
import { planContext } from "./context-delivery.js";
import type { ProductWorkContext } from "./context-types.js";
import { correctionReasons } from "./corrections.js";
import { requireNoPendingCriticReview } from "./critic/critic-policy.js";
import { criticUnderstanding } from "./critic/critic-understanding.js";
import { DRAFT_SLICE_GOAL, draftFirstApplies, draftSlice } from "./draft-first.js";
import { prepareWorkEnvironment } from "./environment.js";
import { firstDoneAdvice, withFirstDoneAdvice } from "./first-done-advice.js";
import { currentHostSession } from "./host-prompts.js";
import {
  checksFor,
  closedSlice,
  type ProductSlice,
  type ProductState,
  sliceDigest,
} from "./model.js";
import { protectedEnvSnapshot } from "./protected-env.js";
import { retainRegressionScopeBaseline } from "./regression-scope-advice.js";
import { withProductMutation } from "./runtime.js";
import {
  type ProductAuthorization,
  productAuthorizationSchema,
  readProductAuthorization,
  selectProductSlice,
  staleTaskNote,
} from "./scopes.js";
import { featureStartingNext, newSessionRequestNext, runProductNext } from "./status.js";
import {
  authorizationPath,
  json,
  type ProductRecord,
  type ProductSelection,
  readProductRecord,
  saveProductState,
  statusMutation,
} from "./store.js";
import { productSourceDigest, productSourceSnapshot } from "./subject.js";
import { independentTestsBeforeWork } from "./tester/independent-tests.js";
import type { TestsStarter } from "./tester/independent-tests-model.js";

export type { ProductWorkContext } from "./context-types.js";

export async function runProductContext(
  workspace: WorkspaceState,
  options: ProductSelection = {},
): Promise<Result<ProductWorkContext>> {
  const record = await readProductRecord(workspace, options);
  if (!record.ok) return record;
  const selected = selectProductSlice(workspace, record.value, options, true);
  if (!selected.ok) return selected;
  if (!selected.value)
    return err(
      vispError("NO_ACTIVE_TASK", "Start the request as one slice with a check", {
        recovery: 'visp work --check "<command that runs your tests>"',
      }),
    );
  const snapshot = await productSourceSnapshot(workspace, record.value.brief);
  if (!snapshot.ok) return snapshot;
  const auth = await readProductAuthorization(workspace, record.value);
  if (!auth.ok) return auth;
  return buildProductContext(
    workspace,
    record.value,
    selected.value,
    snapshot.value,
    auth.value?.task === selected.value.id,
    false,
  );
}

export interface ProductWorkOptions extends ProductSelection {
  /** A check command: on a feature without slices, work the whole request as one slice. */
  readonly check?: string;
  /** The contextId of an earlier reply still in the worker's view: unchanged sections are left out. */
  readonly known?: string;
}

export async function runProductWork(
  workspace: WorkspaceState,
  options: ProductWorkOptions = {},
  tests?: TestsStarter,
  testsWaitMs = 0,
): Promise<Result<ProductWorkContext>> {
  if (!options.feature && !options.task) {
    const starting = await featureStartingNext(workspace, options);
    if (starting) return err(vispError("STAGE_BLOCKED", starting.objective));
    const routing = await withProductMutation(workspace, async () => {
      const record = await readProductRecord(workspace, options);
      if (!record.ok) return record;
      const next = await newSessionRequestNext(workspace, record.value, options);
      if (!next.ok) return next;
      return next.value
        ? err(
            vispError("STAGE_BLOCKED", next.value.objective, {
              recovery: next.value.evidence.join("\n"),
            }),
          )
        : ok(undefined);
    });
    if (!routing.ok) return routing;
  }
  if (options.check?.trim()) {
    const quick = await singleSliceBrief(workspace, options.feature, options.check.trim());
    if (!quick.ok) return quick;
  } else {
    const draft = await draftSliceBrief(workspace, options.feature);
    if (!draft.ok) return draft;
  }
  const independent = await independentTestsBeforeWork(
    workspace,
    options.feature,
    tests,
    testsWaitMs,
  );
  if (!independent.ok) return independent;
  const worked = await runWorkAndReviewRoute(workspace, options);
  return worked.ok && independent.value
    ? ok({ ...worked.value, independentTests: independent.value })
    : worked;
}

/**
 * The light path. Weak workers spent about six minutes reading the planning guide and
 * authoring multi-slice briefs before their first check, while the same small change
 * took bare coding two to three minutes. One slice covering the request, with the
 * worker's own test command, keeps the tester, reviewer, scope and hooks.
 */
async function singleSliceBrief(
  workspace: WorkspaceState,
  feature: string | undefined,
  check: string,
): Promise<Result<void>> {
  const record = await readProductRecord(workspace, feature ? { feature } : {});
  if (!record.ok) return record;
  const { brief } = record.value;
  if (brief.incomplete || (brief.slices.length > 0 && !brief.outcomes.length))
    return err(
      vispError("ARTIFACT_INVALID", "Complete the brief before working", {
        recovery: `visp brief --feature ${brief.feature}; set incomplete:false and declare outcomes`,
      }),
    );
  if (brief.slices.length) {
    const open = brief.slices.find((slice) => !slice.checks.length);
    if (!open) return ok(undefined);
    const id = unusedId(
      brief.checks.map((entry) => entry.id),
      `${open.id}-C`,
    );
    const added = await updateProductBrief(workspace, {
      feature: brief.feature,
      reason: "Declare the slice check",
      patch: {
        checks: [{ id, command: check, outcomes: open.outcomes }],
        slices: [{ id: open.id, checks: [id] }],
      },
    });
    return added.ok ? ok(undefined) : added;
  }
  const outcomes = brief.outcomes.length
    ? brief.outcomes.filter((outcome) => outcome.priority === "must").map((outcome) => outcome.id)
    : [unusedId([], "O")];
  const linkedOutcomes = outcomes.length ? outcomes : brief.outcomes.map((outcome) => outcome.id);
  const checkId = unusedId(
    brief.checks.map((entry) => entry.id),
    "C",
  );
  const taskId = unusedId(
    brief.slices.map((entry) => entry.id),
    "T",
  );
  const created = await updateProductBrief(workspace, {
    feature: brief.feature,
    reason: "Work the whole request as one slice",
    patch: {
      ...(!brief.outcomes.length
        ? {
            outcomes: [
              {
                id: linkedOutcomes[0],
                kind: "functional",
                statement: `The original request is fulfilled: ${brief.goal}`,
                priority: "must",
                provenance: "user-stated",
              },
            ],
          }
        : {}),
      checks: [{ id: checkId, command: check, outcomes: linkedOutcomes }],
      slices: [
        {
          id: taskId,
          goal: "Deliver the original request",
          outcomes: linkedOutcomes,
          scope: { allowed: ["**"] },
          checks: [checkId],
        },
      ],
    },
  });
  return created.ok ? ok(undefined) : created;
}

/** Lean mode: a picture request becomes one whole-request slice whose check comes after the draft. */
async function draftSliceBrief(
  workspace: WorkspaceState,
  feature: string | undefined,
): Promise<Result<void>> {
  const record = await readProductRecord(workspace, feature ? { feature } : {});
  if (
    !record.ok ||
    record.value.brief.incomplete ||
    !draftFirstApplies(workspace, record.value.brief)
  )
    return ok(undefined);
  const { brief } = record.value;
  const outcome = brief.outcomes.find((entry) => entry.priority === "must")?.id ?? "O001";
  const created = await updateProductBrief(workspace, {
    feature: brief.feature,
    reason: "Draft the whole picture request first",
    patch: {
      ...(!brief.outcomes.length
        ? {
            outcomes: [
              {
                id: outcome,
                kind: "functional",
                statement: `The original request is fulfilled: ${brief.goal}`,
                priority: "must",
                provenance: "user-stated",
              },
            ],
          }
        : {}),
      slices: [
        {
          id: "T001",
          goal: DRAFT_SLICE_GOAL,
          outcomes: [outcome],
          scope: { allowed: ["**"] },
          checks: [],
        },
      ],
    },
  });
  return created.ok ? ok(undefined) : created;
}

function unusedId(existing: readonly string[], prefix: string): string {
  const used = new Set(existing);
  let ordinal = 1;
  while (used.has(`${prefix}${String(ordinal).padStart(3, "0")}`)) ordinal++;
  return `${prefix}${String(ordinal).padStart(3, "0")}`;
}

/**
 * Work authorization mutates state; review routing must read the committed
 * state afterwards so a critic checkpoint cannot re-enter the state lock.
 */
async function runWorkAndReviewRoute(
  workspace: WorkspaceState,
  options: ProductWorkOptions,
): Promise<Result<ProductWorkContext>> {
  const worked = await withProductMutation(workspace, () =>
    runProductWorkLocked(workspace, options),
  );
  if (!worked.ok) return worked;
  const next = await runProductNext(workspace, {
    feature: worked.value.context.feature,
    task: worked.value.context.task,
  });
  return ok({
    ...worked.value.context,
    ...(next.ok
      ? {
          next: withFirstDoneAdvice(next.value, worked.value.advice),
          ...(next.value.criticAdvice ? { criticAdvice: next.value.criticAdvice } : {}),
        }
      : {}),
  });
}

async function runProductWorkLocked(
  workspace: WorkspaceState,
  options: ProductWorkOptions,
): Promise<Result<{ context: ProductWorkContext; advice?: string }>> {
  const record = await readProductRecord(workspace, options);
  if (!record.ok) return record;
  const selected = readyProductSlice(workspace, record.value, options);
  if (!selected.ok) return selected;
  const slice = selected.value;
  const editable = await requireNoPendingCriticReview(
    workspace,
    record.value.brief.feature,
    "Submit the pending reviewer result or wait for its deadline before retrying",
  );
  if (!editable.ok) return editable;
  const foundation = await requireImplementationFoundation(
    workspace,
    `visp work --task ${slice.id}`,
  );
  if (!foundation.ok) return foundation;
  const snapshot = await productSourceSnapshot(workspace, record.value.brief);
  if (!snapshot.ok) return snapshot;
  const subject = await productSourceDigest(workspace, record.value.brief, snapshot.value);
  if (!subject.ok) return subject;
  const reopen = closedSlice(record.value.state.slices[slice.id]?.status);
  const findings = correctionReasons(record.value, slice, subject.value);
  const reopenError = reopeningGap(slice, reopen, options.task, findings);
  if (reopenError) return err(vispError("STAGE_BLOCKED", reopenError));
  const prepared = await prepareWorkEnvironment(
    workspace,
    record.value,
    slice,
    options.retryEnvironment,
  );
  if (!prepared.ok) return prepared;
  const current = prepared.value;
  const understanding = await workUnderstanding(workspace, record.value, current, slice);
  if (!understanding.ok) return understanding;
  const context = await buildProductContext(workspace, current, slice, snapshot.value, true, true);
  if (!context.ok) return context;
  const timestamp = new Date().toISOString();
  const granted = await grantWrites(workspace, record.value, slice, snapshot.value, timestamp);
  if (!granted.ok) return granted;
  const auth = granted.value.authorization;
  const next = workingState(current, slice, auth, timestamp, reopen, subject.value, findings);
  const delivery = await planContext(workspace, context.value, auth.contractDigest, options.known);
  if (!delivery.ok) return delivery;
  const saved = await saveProductState(workspace, record.value, next, [
    ...granted.value.mutations,
    delivery.value.mutation,
  ]);
  await retainRegressionScopeBaseline(workspace, auth, saved.ok);
  return saved.ok
    ? ok({
        context: {
          ...delivery.value.context,
          notes: [...delivery.value.context.notes, ...staleTaskNote(workspace, record.value)],
          criticUnderstanding: understanding.value,
        },
        advice: firstDoneAdvice(record.value, slice, granted.value.prior, subject.value),
      })
    : saved;
}

/** The grant and the writes that record it: the work branch, the authorization and the status. */
async function grantWrites(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice,
  snapshot: Record<string, string>,
  timestamp: string,
): Promise<
  Result<{
    authorization: ProductAuthorization;
    prior?: ProductAuthorization;
    mutations: FileMutation[];
  }>
> {
  const path = authorizationPath(workspace, record.brief.feature);
  const before = await workspace.files.readTextIfExists(path);
  if (!before.ok) return before;
  const granted = await grantAuthorization(workspace, record, slice, snapshot, timestamp);
  if (!granted.ok) return granted;
  const status = await statusMutation(workspace, record.brief.feature, slice.id, "work");
  if (!status.ok) return status;
  const branch = await workBranchMutation(workspace, record);
  if (!branch.ok) return branch;
  const { authorization } = granted.value;
  return ok({
    ...granted.value,
    mutations: [
      ...branch.value,
      {
        kind: "write",
        path,
        content: json(authorization),
        expectedBefore: filePrecondition(before.value),
      },
      status.value,
    ],
  });
}

/**
 * Re-authorizing the same slice keeps its baseline, so edits made under an earlier grant
 * still count as the slice's own. The grant records the host session that asked for it.
 */
async function grantAuthorization(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice,
  snapshot: Record<string, string>,
  createdAt: string,
): Promise<Result<{ authorization: ProductAuthorization; prior?: ProductAuthorization }>> {
  const prior = await readProductAuthorization(workspace, record);
  if (!prior.ok) return prior;
  const retained = await workspace.files.readTextIfExists(
    authorizationPath(workspace, record.brief.feature),
  );
  if (!retained.ok) return retained;
  let grant = prior.value?.task === slice.id ? prior.value : undefined;
  if (!prior.value && retained.value) {
    try {
      const stale = productAuthorizationSchema.safeParse(JSON.parse(retained.value));
      if (
        stale.success &&
        stale.data.feature === record.brief.feature &&
        stale.data.task === slice.id &&
        stale.data.root === hashValue(workspace.paths.root)
      )
        grant = stale.data;
    } catch {
      // A malformed old grant cannot supply a baseline.
    }
  }
  const session = await currentHostSession(workspace, true);
  if (!session.ok) return session;
  const protectedEnv = await protectedEnvSnapshot(workspace.paths.root);
  if (!protectedEnv.ok) return protectedEnv;
  const head = await headCommit(workspace.paths.root);
  if (!head.ok) return head;
  return ok({
    prior: prior.value,
    authorization: {
      version: 2,
      feature: record.brief.feature,
      task: slice.id,
      createdAt,
      root: hashValue(workspace.paths.root),
      contractDigest: sliceDigest(record.brief, slice),
      baseline: grant?.baseline ?? snapshot,
      blockedPaths: grant?.blockedPaths ?? workspace.config.workflow.blockedPaths,
      envBaseline: grant?.envBaseline ?? protectedEnv.value,
      headCommit: grant?.headCommit ?? head.value,
      ...(session.value ? { session: session.value } : {}),
    },
  });
}

async function workUnderstanding(
  workspace: WorkspaceState,
  before: ProductRecord,
  current: ProductRecord,
  slice: ProductSlice,
) {
  const understanding = await criticUnderstanding(workspace, {
    feature: before.brief.feature,
    task: slice.id,
  });
  if (understanding.ok || current.state === before.state) return understanding;
  // Retain a recovered browser capability if stored critic state cannot be read.
  const saved = await saveProductState(workspace, before, current.state);
  return saved.ok ? understanding : saved;
}

function reopeningGap(
  slice: ProductSlice,
  reopen: boolean,
  task: string | undefined,
  findings: string[],
) {
  return reopeningBlocked(reopen, task, findings)
    ? `${slice.id} is already closed; reopening requires an explicit slice with a current product failure attributed to this slice`
    : undefined;
}

function readyProductSlice(
  workspace: WorkspaceState,
  record: ProductRecord,
  options: ProductSelection,
): Result<ProductSlice> {
  const selected = selectProductSlice(workspace, record, options, true);
  if (!selected.ok) return selected;
  const slice = selected.value;
  if (record.brief.incomplete)
    return err(
      vispError("STAGE_BLOCKED", "Complete the migrated draft brief before authorization", {
        recovery: "visp brief",
      }),
    );
  if (!slice)
    return err(
      vispError("NO_ACTIVE_TASK", "No ready slice; define the next usable behavior in the brief", {
        recovery: "visp brief",
      }),
    );
  const ready = validateReadySlice(record, slice, draftSlice(workspace, record.brief, slice));
  if (!ready.ok) return ready;
  const missing = uninstalledInterpreter(record, slice);
  return missing ? err(missing) : ok(slice);
}

/**
 * A check that runs `python` where only `python3` exists fails at its first `done` as an
 * environment failure. Say so before edits begin, with the patch that fixes it; never
 * rewrite the check here.
 */
function uninstalledInterpreter(record: ProductRecord, slice: ProductSlice) {
  for (const check of checksFor(record.brief, slice)) {
    const found = uninstalledAlias(check);
    if (found)
      return vispError(
        "STAGE_BLOCKED",
        `Check ${check.id} runs "${found.argv0}", which is not installed here; "${found.alias}" is. ${found.fix}`,
      );
  }
  return undefined;
}

function workingState(
  record: ProductRecord,
  slice: ProductSlice,
  auth: ProductAuthorization,
  timestamp: string,
  reopen: boolean,
  subject: string,
  findings: string[],
): ProductState {
  return {
    ...record.state,
    updatedAt: timestamp,
    ...(reopen
      ? {
          status: "active" as const,
          acceptedSubject: undefined,
          sliceHistory: [
            ...record.state.sliceHistory,
            {
              task: slice.id,
              from: record.state.slices[slice.id]?.status ?? "closed",
              to: "in-progress",
              createdAt: timestamp,
              subjectDigest: subject,
              reason: `Reopened to correct current mandatory findings: ${findings.join(", ")}`,
            },
          ],
        }
      : {}),
    slices: {
      ...record.state.slices,
      [slice.id]: { status: "in-progress" as const, contractDigest: auth.contractDigest },
    },
  };
}

/**
 * Functional outcomes need executed evidence; quality and experience can rest on review.
 * An outcome another slice's check already exercises is covered.
 */
function promisesBehavior(record: ProductRecord, slice: ProductSlice): boolean {
  const checked = new Set(record.brief.checks.flatMap((check) => check.outcomes));
  return record.brief.outcomes.some(
    (outcome) =>
      slice.outcomes.includes(outcome.id) &&
      outcome.kind === "functional" &&
      !checked.has(outcome.id),
  );
}

/** Without a runnable check, `done` has nothing to execute and the critic has no evidence. */
function missingCheck(slice: ProductSlice) {
  const id = `${slice.id}-C1`;
  const patch = {
    checks: [{ id, command: ["<test runner>", "<test file>"], outcomes: slice.outcomes }],
    slices: [{ id: slice.id, checks: [id] }],
  };
  return vispError(
    "STAGE_BLOCKED",
    `${slice.id} has no runnable check. Declare the command that exercises this slice (your test runner or a browser journey) before editing.`,
    {
      recovery: `visp brief --patch - --reason "Add the slice check" with ${JSON.stringify(patch)}, then run visp work again`,
    },
  );
}

function validateReadySlice(
  record: ProductRecord,
  slice: ProductSlice,
  draft: boolean,
): Result<void> {
  if (!slice.scope.allowed.length || !slice.outcomes.length)
    return err(
      vispError("STAGE_BLOCKED", "A slice needs an observable outcome and bounded write scope", {
        recovery: "visp brief",
      }),
    );
  const checks = checksFor(record.brief, slice);
  if (!checks.length && !draft && promisesBehavior(record, slice)) return err(missingCheck(slice));
  for (const check of checks) {
    const valid = validateProductCheckCommand(check);
    if (!valid.ok) return valid;
  }
  const dependencies = slice.dependsOn.filter(
    (id) => !closedSlice(record.state.slices[id]?.status),
  );
  return dependencies.length
    ? err(vispError("STAGE_BLOCKED", `${slice.id} depends on ${dependencies.join(", ")}`))
    : ok(undefined);
}

function reopeningBlocked(
  reopen: boolean,
  explicitTask: string | undefined,
  findings: string[],
): boolean {
  return reopen && (explicitTask === undefined || findings.length === 0);
}

async function workBranchMutation(
  workspace: WorkspaceState,
  record: ProductRecord,
): Promise<Result<FileMutation[]>> {
  const branch = await currentBranch(workspace.paths.root);
  if (!branch.ok) return branch;
  const intent = await workspace.store.readIntent(record.brief.feature);
  if (!intent.ok) return intent;
  if (branch.value === "HEAD" || intent.value.branch === branch.value) return ok([]);
  const path = workspace.paths.featureFile(record.brief.feature, "intent.json");
  const before = await workspace.files.readText(path);
  if (!before.ok) return before;
  return ok([
    {
      kind: "write",
      path,
      content: json({ ...intent.value, branch: branch.value }),
      expectedBefore: filePrecondition(before.value),
    },
  ]);
}
