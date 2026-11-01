import { ok, type Result } from "../../../core/result.js";
import { cliCommand } from "../../next-action.js";
import type { WorkspaceState } from "../../state.js";
import type { ProductNext } from "../status.js";
import { reviewerRules } from "../tester/pinned-dispute-model.js";
import { criticStatus } from "./critic-status.js";

/** Criticism supplements baseline navigation; availability never becomes a product gate. */
export async function criticNext(
  workspace: WorkspaceState,
  next: ProductNext,
): Promise<Result<ProductNext>> {
  if (!next.feature) return ok(next);
  const status = await criticStatus(workspace, { feature: next.feature, task: next.task });
  if (!status.ok)
    return ok({
      ...next,
      criticAdvice: {
        status: "unavailable",
        guidance: `Critic status unavailable: ${status.error.message}. Continue the baseline build–observe–fix loop; report this review limitation.`,
      },
    });
  return ok(withCriticAdvice(next, status.value, reviewerRules(workspace)));
}

/** The command a caller should execute when the current product is reviewable. */
export function criticRouteCommand(next: ProductNext): string | undefined {
  return next.criticAdvice?.status === "suggested" ? next.criticAdvice.command : undefined;
}

type Status = Extract<Awaited<ReturnType<typeof criticStatus>>, { ok: true }>["value"];
function withCriticAdvice(next: ProductNext, critic: Status, launched: boolean): ProductNext {
  if (!critic.enabled || !("next" in critic)) return next;
  if (critic.next === "normal-acceptance") return next;
  if (critic.stopped || critic.next === "worker")
    return { ...next, criticAdvice: retainedAdvice(critic, launched) };
  const environmentGap = next.completion === "unresolved-environment";
  if (critic.renderedEvidence.relevant && (environmentGap || !critic.renderedEvidence.recorded))
    return { ...next, criticAdvice: renderedEvidenceAdvice(next, launched) };
  const reviewable =
    environmentGap ||
    ["refine", "accept", "complete"].includes(next.action) ||
    (["implement", "fix"].includes(next.action) && critic.hasObservedProduct);
  // VISP starts the reviewer inside `visp done`; the worker has no review command to run.
  if (!reviewable || launched) return next;
  const command = cliCommand("critic", { feature: next.feature, task: next.task });
  return {
    ...next,
    criticAdvice: {
      status: "suggested",
      command: `${command} ${critic.transport === "native" ? "--preflight" : "--dispatch"}`,
      guidance:
        "Ask the independent critic for useful feedback on this candidate. If unavailable, use the baseline host review of actual behavior and images; disclose the missing independent review.",
    },
  };
}

function renderedEvidenceAdvice(next: ProductNext, launched: boolean) {
  return {
    status: "suggested" as const,
    command: next.command,
    guidance: launched
      ? "Observe the rendered product before review: recover the browser through the supported host path and capture a usable interaction. VISP's reviewer needs it; continue scoped implementation meanwhile."
      : "Keep critic capacity for the rendered product. Recover the browser through the supported host path and observe a usable interaction before product critique. Continue scoped implementation meanwhile. Source-only advice is an explicit option for a concrete code question, not an automatic substitute for visual feedback; it spends the same call budget.",
  };
}

type ActiveStatus = Extract<Status, { next: string }>;
function retainedAdvice(
  critic: ActiveStatus,
  launched: boolean,
): NonNullable<ProductNext["criticAdvice"]> {
  return {
    status: critic.stopped ? "unavailable" : "feedback",
    guidance: launched
      ? launchedGuidance(critic.stopped, "findings" in critic && critic.findings.length > 0)
      : baselineGuidance(critic.stopped),
    command: launched ? undefined : critic.recovery?.command,
    findings: "findings" in critic ? critic.findings : [],
    evidenceRequest: critic.evidenceRequest,
    limitations: "advice" in critic ? critic.advice?.limitations : undefined,
    comparisons: "comparisons" in critic ? critic.comparisons : [],
  };
}

function baselineGuidance(stopped: string | undefined) {
  return `${stopped ?? "Use the recorded findings to choose the next correction."} Continue the baseline build–observe–fix loop. Actual failures and missing product evidence remain unresolved; missing critic service alone does not block delivery.`;
}

/** VISP runs its own reviewer: the worker delegates nothing and reviews nothing itself. */
function launchedGuidance(stopped: string | undefined, hasFindings: boolean) {
  if (!stopped)
    return "Use the recorded findings to choose the next correction. VISP re-runs its reviewer inside visp done; delegate nothing and run no review command. Actual failures and missing product evidence remain unresolved.";
  if (stopped.startsWith("review-in-progress"))
    return "VISP's reviewer is still running. Wait: run visp next.";
  const head = stopped.split(". No new invocation")[0];
  const route =
    "Follow `visp next`: it says when to run visp done again and when the rest goes to a human reviewer.";
  // Findings exist: the reviewer did review an earlier version, so it is only unable to run now.
  if (hasFindings)
    return `Use the recorded findings to choose the next correction; delegate nothing and run no review command. VISP's reviewer cannot review a new version now: ${head}. ${route}`;
  return `VISP's reviewer has not reviewed this version: ${head}. Do not review your own work instead; if it stays unavailable, say so in your final message. ${route}`;
}
