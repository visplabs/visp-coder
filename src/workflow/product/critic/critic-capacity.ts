import { CRITIC_CALL_TIMEOUT_MS, CRITIC_MAX_CALLS } from "../../../config/critic.js";
import { cliCommand } from "../../next-action.js";
import type { WorkspaceState } from "../../state.js";
import { reviewRoundGap } from "../review/review-cadence.js";
import { reviewerRules } from "../tester/pinned-dispute-model.js";
import {
  featureCriticBudgetGap,
  featureCriticCapacity,
  readFeatureCriticBudget,
} from "./critic-budget.js";
import { relaunchBlocked } from "./critic-status.js";
import { criticSelection, readCriticState } from "./critic-store.js";

/** Whether VISP's own reviewer can still run on this source; `reason` is a sentence for the worker. */
export interface ReviewerCapacity {
  readonly available: boolean;
  readonly reason?: string;
  readonly callsRemaining?: number;
  readonly reservableCalls?: number;
  /** An optional slice dispatch would leave no call or timeout for the assembled review. */
  readonly reserveCompletingReview?: boolean;
}

const AVAILABLE: ReviewerCapacity = { available: true };

/**
 * The one predicate for "VISP's reviewer cannot run again": the feature's call budget or time
 * budget is spent, or the reviewer already failed twice on this source. Positive evidence only:
 * anything unreadable, unconfigured or not launched by VISP counts as available, so a handoff
 * happens only when the recorded budget or attempts prove it.
 */
export async function reviewerCapacity(
  workspace: WorkspaceState,
  feature: string,
  subject: string,
  task?: string,
): Promise<ReviewerCapacity> {
  if (!reviewerRules(workspace)) return AVAILABLE;
  try {
    return await recordedCapacity(workspace, feature, subject, task);
  } catch {
    return AVAILABLE;
  }
}

async function recordedCapacity(
  workspace: WorkspaceState,
  feature: string,
  subject: string,
  task?: string,
): Promise<ReviewerCapacity> {
  const selected = await criticSelection(workspace, { feature, task });
  if (!selected.ok) return AVAILABLE;
  const stored = await readCriticState(workspace, selected.value);
  if (!stored.ok) return AVAILABLE;
  const state = stored.value.state;
  const timeoutMs =
    state?.config.timeoutMs ?? workspace.config.critic?.timeoutMs ?? CRITIC_CALL_TIMEOUT_MS;
  const budget = await readFeatureCriticBudget(workspace, feature, {
    maxCalls: workspace.config.critic?.maxCalls ?? CRITIC_MAX_CALLS,
  });
  if (!budget.ok) return AVAILABLE;
  const capacity = featureCriticCapacity(budget.value.budget, timeoutMs);
  const { callsRemaining, reservableCalls } = capacity;
  if (featureCriticBudgetGap(budget.value.budget, timeoutMs))
    return {
      available: false,
      callsRemaining,
      reservableCalls,
      reason: "The independent review budget is spent.",
    };
  const rounds = reviewRoundGap(workspace, selected.value.record, budget.value.budget);
  if (rounds) return { available: false, callsRemaining, reservableCalls, reason: rounds };
  if (state && relaunchBlocked(state, subject, selected.value.phase))
    return {
      available: false,
      callsRemaining,
      reservableCalls,
      reason: "VISP's independent reviewer failed twice on this source.",
    };
  const completing = await criticSelection(workspace, { feature }, true);
  if (!completing.ok) return { available: true, callsRemaining, reservableCalls };
  const completingState = await readCriticState(workspace, completing.value);
  if (!completingState.ok) return { available: true, callsRemaining, reservableCalls };
  const completingTimeoutMs =
    completingState.value.state?.config.timeoutMs ??
    workspace.config.critic?.timeoutMs ??
    CRITIC_CALL_TIMEOUT_MS;
  return {
    available: true,
    callsRemaining,
    reservableCalls,
    reserveCompletingReview:
      reservableCalls > 0 &&
      (callsRemaining < 2 || capacity.remainingMs < timeoutMs + completingTimeoutMs),
  };
}

/** The step when VISP's reviewer cannot run again: hand what remains to the human reviewer. */
export function reviewerHandoff(
  feature: string,
  capacity: ReviewerCapacity,
  remaining: "findings" | "assessment",
) {
  return {
    action: "fix" as const,
    completion: "handoff" as const,
    command: cliCommand("pr", { feature }),
    objective: `${capacity.reason ?? "VISP's independent reviewer cannot run again."} Run visp pr; the remaining ${remaining} go to a human reviewer`,
  };
}

/**
 * Where the worker's images go: to the host's reviewer, to VISP's own reviewer (`visp done`), or,
 * once that reviewer cannot run again, to the human reviewer through `visp pr`.
 */
export async function reviewerPointer(
  workspace: WorkspaceState,
  feature: string,
  subject: string,
  task?: string,
): Promise<"host" | "visp" | "gone"> {
  if (!reviewerRules(workspace)) return "host";
  return (await reviewerCapacity(workspace, feature, subject, task)).available ? "visp" : "gone";
}
