import { basename, join } from "node:path";
import { z } from "zod";
import {
  CRITIC_CALL_TIMEOUT_MS,
  CRITIC_FEATURE_TIMEOUT_MS,
  CRITIC_MAX_CALLS,
  type CriticConfig,
} from "../../../config/critic.js";
import { PRODUCT_STATE_VERSION } from "../../../core/constants.js";
import { vispError } from "../../../core/errors.js";
import { type FileMutation, filePrecondition } from "../../../core/file-transaction.js";
import { hashValue } from "../../../core/hash.js";
import { err, ok } from "../../../core/result.js";
import type { WorkspaceState } from "../../state.js";
import { productStateSchema } from "../model.js";
import { productStatePath } from "../store.js";
import { readCriticBudgetHistory } from "./critic-budget-history.js";
import type { CriticState } from "./critic-model.js";

// Spending inspection must remain available while explicit state migration is pending.
const budgetSourceStateSchema = productStateSchema.extend({
  version: z.union([z.literal(2), z.literal(PRODUCT_STATE_VERSION)]),
});

const budgetSchema = z
  .object({
    version: z.literal(1),
    root: z.string(),
    feature: z.string(),
    maxCalls: z.number().int().positive(),
    maxReservedMs: z.number().int().positive(),
    entries: z.array(
      z
        .object({
          key: z.string(),
          phase: z.enum(["understanding", "product"]),
          reservedMs: z.number().int().positive(),
          /** The attempt ended without a reviewer response; it keeps its time but not a call. */
          noResponse: z.boolean().optional(),
        })
        .strict(),
    ),
  })
  .strict();
type Budget = z.infer<typeof budgetSchema>;

/** Unknown invocation outcomes retain the full allocation; this is not measured billing. */
export async function readFeatureCriticBudget(
  workspace: WorkspaceState,
  feature: string,
  config: Pick<CriticConfig, "maxCalls">,
) {
  const path = join(workspace.paths.featureDir(feature), "critic-budget.json");
  const read = await workspace.files.readTextIfExists(path);
  if (!read.ok) return read;
  if (read.value === undefined) {
    const legacy = await requireLegacyBudgetState(workspace, feature);
    if (!legacy.ok) return legacy;
  }
  const parsed = parseBudget(read.value, feature, hashValue(workspace.paths.root), config.maxCalls);
  if (!parsed.ok) return parsed;
  let budget = parsed.value;
  const directory = join(workspace.paths.featureDir(feature), "critic");
  const entries = await workspace.files.listEntries(directory);
  if (!entries.ok) return entries;
  if (read.value === undefined && entries.value.some((entry) => entry.name.endsWith(".json")))
    budget.maxCalls = Number.MAX_SAFE_INTEGER;
  const historyGuards: FileMutation[] = [];
  const unreviewed: string[] = [];
  for (const entry of entries.value) {
    if (!entry.name.endsWith(".json")) continue;
    const loaded = await readCriticBudgetHistory(workspace, join(directory, entry.name));
    if (!loaded.ok) return loaded;
    const merged = mergeHistory(budget, entry.name, loaded.value.state, read.value === undefined);
    if (!merged.ok) return merged;
    budget = merged.value;
    historyGuards.push(loaded.value.guard);
    unreviewed.push(...unreviewedAttempts(entry.name, loaded.value.state));
  }
  return ok({
    path,
    text: read.value,
    budget,
    unreviewed: new Set(unreviewed),
    historyCount: historyGuards.length,
    historyGuards,
  });
}

/** Attempts that recorded no review: no answer, or an answer VISP rejected. */
function unreviewedAttempts(scope: string, state: CriticState): string[] {
  return state.attempts
    .filter((attempt) => attempt.status === "unavailable")
    .map((attempt) => attemptKey(scope, attempt.id));
}

/** One budget entry per critic attempt: the history file it is recorded in and its id. */
function attemptKey(scope: string, id: string): string {
  return hashValue({ scope, id });
}

function parseBudget(content: string | undefined, feature: string, root: string, maxCalls: number) {
  let budget: Budget;
  try {
    budget =
      content === undefined
        ? {
            version: 1,
            root,
            feature,
            maxCalls,
            maxReservedMs: CRITIC_FEATURE_TIMEOUT_MS,
            entries: [],
          }
        : budgetSchema.parse(JSON.parse(content));
  } catch {
    return err(
      vispError(
        "ARTIFACT_INVALID",
        "Invalid feature critic budget; preserve history before migration",
      ),
    );
  }
  // Root records where accounting began. Spending travels with the feature; review
  // authority remains bound to the checkout in critic-store's separate state records.
  if (budget.feature !== feature)
    return err(vispError("ARTIFACT_INVALID", "Feature critic budget belongs to another feature"));
  if (new Set(budget.entries.map((entry) => entry.key)).size !== budget.entries.length)
    return err(vispError("ARTIFACT_INVALID", "Duplicate feature critic budget entries"));
  return ok(budget);
}

function mergeHistory(budget: Budget, scope: string, state: CriticState, adoptLimits: boolean) {
  if (state.feature !== budget.feature)
    return err(vispError("ARTIFACT_INVALID", "Critic history belongs to another feature"));
  if (new Set(state.attempts.map((attempt) => attempt.id)).size !== state.attempts.length)
    return err(vispError("ARTIFACT_INVALID", "Duplicate critic attempts; spending is ambiguous"));
  const entries = new Map(budget.entries.map((entry) => [entry.key, entry]));
  for (const attempt of state.attempts) {
    const key = attemptKey(scope, attempt.id);
    const previous = entries.get(key);
    entries.set(key, {
      key,
      phase: attempt.phase ?? "product",
      reservedMs: Math.max(previous?.reservedMs ?? 0, state.config.timeoutMs),
      ...(attempt.launcher === "visp" &&
      attempt.status === "unavailable" &&
      attempt.execution?.returned !== true &&
      !attempt.response &&
      !attempt.advisoryResponse
        ? { noResponse: true }
        : {}),
    });
  }
  return ok({
    ...budget,
    maxCalls: adoptLimits ? Math.min(budget.maxCalls, state.config.maxCalls) : budget.maxCalls,
    entries: [...entries.values()],
  });
}

/** No-response VISP retries keep their full time reservation, so interruptions cannot reset spending. */
export function featureCriticCapacity(budget: Budget, timeoutMs = CRITIC_CALL_TIMEOUT_MS) {
  const reservedMs = budget.entries.reduce((sum, entry) => sum + entry.reservedMs, 0);
  const callsUsed = budget.entries.filter((entry) => !entry.noResponse).length;
  return {
    scope: "feature" as const,
    limit: budget.maxCalls,
    callsUsed,
    callsRemaining: Math.max(0, budget.maxCalls - callsUsed),
    reservableCalls: Math.max(
      0,
      Math.min(
        budget.maxCalls - callsUsed,
        Math.floor((budget.maxReservedMs - reservedMs) / timeoutMs),
      ),
    ),
    reservedMs,
    remainingMs: Math.max(0, budget.maxReservedMs - reservedMs),
    maxReservedMs: budget.maxReservedMs,
    understandingCalls: budget.entries.filter((entry) => entry.phase === "understanding").length,
    productCalls: budget.entries.filter((entry) => entry.phase === "product").length,
    accounting:
      "Full timeout reserved per attempt, including uncertain or interrupted calls; unavailable VISP attempts without a response spend time only; not measured provider time or cost",
  };
}
export function featureCriticBudgetGap(budget: Budget, timeoutMs: number) {
  const capacity = featureCriticCapacity(budget, timeoutMs);
  if (!capacity.callsRemaining) return "Feature critic call budget exhausted; unresolved";
  if (capacity.remainingMs < timeoutMs) return "Feature critic time budget exhausted; unresolved";
  return undefined;
}

/** The caller owns the workspace writer lock; ledger and attempt commit together. */
export async function planCriticBudgetMutation(
  workspace: WorkspaceState,
  path: string,
  next: CriticState,
) {
  const current = await readFeatureCriticBudget(workspace, next.feature, next.config);
  if (!current.ok) return current;
  if (current.value.text === undefined && current.value.historyCount > 0)
    return err(
      vispError(
        "MIGRATION_REQUIRED",
        "Historical critic spending requires a backed-up feature budget upgrade",
        {
          recovery:
            "Run visp-migrate --project <project> preview, then apply; preserve existing attempts and explicit limits",
        },
      ),
    );
  const merged = mergeHistory(
    current.value.budget,
    basename(path),
    next,
    current.value.text === undefined,
  );
  if (!merged.ok) return merged;
  if (merged.value.entries.length > current.value.budget.entries.length) {
    const capacity = featureCriticCapacity(merged.value);
    if (capacity.callsUsed > capacity.limit || capacity.reservedMs > capacity.maxReservedMs)
      return err(
        vispError("STAGE_BLOCKED", "Feature critic budget exhausted; reservation refused"),
      );
  }
  return ok({
    kind: "write",
    path: current.value.path,
    content: `${JSON.stringify(merged.value, null, 2)}\n`,
    expectedBefore: filePrecondition(current.value.text),
  } satisfies FileMutation);
}

async function requireLegacyBudgetState(workspace: WorkspaceState, feature: string) {
  const state = await workspace.files.readJson(productStatePath(workspace, feature), (input) => {
    const parsed = budgetSourceStateSchema.safeParse(input);
    return parsed.success
      ? ok(parsed.data)
      : err(
          vispError(
            "ARTIFACT_INVALID",
            "Invalid feature state; critic spending cannot be established",
          ),
        );
  });
  if (!state.ok) return state;
  return state.value.criticBudgetVersion === undefined
    ? ok(undefined)
    : err(
        vispError(
          "ARTIFACT_MISSING",
          "Feature critic budget is missing; capacity cannot be reconstructed safely after upgrade",
          {
            recovery:
              "Restore the feature budget from its backed-up history; do not clear the upgrade marker or reset spent attempts",
          },
        ),
      );
}

/** Spending remains inspectable even when this selection has no reviewer configured. */
export async function unconfiguredCriticSpending(workspace: WorkspaceState, feature: string) {
  const loaded = await readFeatureCriticBudget(workspace, feature, { maxCalls: CRITIC_MAX_CALLS });
  if (!loaded.ok) return loaded;
  if (loaded.value.text === undefined && !loaded.value.budget.entries.length) return ok({});
  const capacity = featureCriticCapacity(loaded.value.budget);
  return ok({
    callsUsed: capacity.callsUsed,
    callsRemaining: capacity.callsRemaining,
    featureBudget: capacity,
  });
}
