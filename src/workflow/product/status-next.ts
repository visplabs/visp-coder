import { ok, type Result } from "../../core/result.js";
import { cliCommand } from "../next-action.js";
import type { WorkspaceState } from "../state.js";
import { finalProductAssessmentGaps, productEvidenceGaps } from "./assessment.js";
import { currentProductFailures } from "./corrections.js";
import {
  draftCheckCommand,
  draftFirstApplies,
  draftObjective,
  draftSlice,
  draftStartCommand,
} from "./draft-first.js";
import { environmentNext, needsBrowser } from "./environment.js";
import { browserCapabilityApplies } from "./environment-model.js";
import { closedSlice, type ProductSlice } from "./model.js";
import { withNotObservedAdvice } from "./not-observed-advice.js";
import {
  withRegressionScopeAdvice,
  withRegressionScopeAdviceResult,
} from "./regression-scope-advice.js";
import { readProductAuthorization, selectProductSlice } from "./scopes.js";
import type { ProductNext } from "./status.js";
import { historicalAcceptanceNext, type ProductIdentity } from "./status-history.js";
import { nextClosedProduct } from "./status-next-closed.js";
import { nextOpenSlice } from "./status-next-open.js";
import type { ProductRecord, ProductSelection } from "./store.js";
import { reviewerRules } from "./tester/pinned-dispute-model.js";

export async function nextFromRecord(
  workspace: WorkspaceState,
  record: ProductRecord,
  options: ProductSelection,
  getIdentity: () => Promise<Result<ProductIdentity>>,
): Promise<Result<ProductNext>> {
  const selection = selectProductSlice(workspace, record, options, true);
  if (!selection.ok) return selection;
  const slice = selection.value;
  const base = { feature: record.brief.feature, ...(slice ? { task: slice.id } : {}) };
  if (record.state.status === "historical-complete")
    return ok({
      ...base,
      action: "complete",
      objective: "Historically completed feature; original evidence is preserved",
      evidence: ["This is historical completion, not fresh product verification"],
      mayEdit: false,
    });
  if (record.brief.incomplete || (record.brief.slices.length > 0 && !record.brief.outcomes.length))
    return ok({
      ...base,
      action: "understand",
      objective: "Complete the brief: declare outcomes and set incomplete:false before working",
      command: cliCommand("brief", { feature: record.brief.feature }),
      evidence: record.brief.uncertainties,
      mayEdit: false,
    });
  if (draftFirstApplies(workspace, record.brief))
    return ok({
      ...base,
      action: "understand",
      objective: `${draftObjective()}. Start with visp work: it authorizes the whole request as one slice`,
      command: draftStartCommand(record.brief.feature),
      evidence: record.brief.uncertainties,
      mayEdit: false,
    });
  if (!record.brief.slices.length)
    return ok({
      ...base,
      action: "understand",
      objective:
        "Work the whole request as one slice with your test command, or, for several independently usable parts, describe outcomes and slices in the brief",
      command: cliCommand("work", {
        feature: record.brief.feature,
        check: { quoted: "<command that runs your tests>" },
      }),
      evidence: record.brief.uncertainties,
      mayEdit: false,
    });
  const environment = await unavailableEnvironmentNext(workspace, record, slice);
  if (environment) return ok(environment);
  const identity = await getIdentity();
  if (!identity.ok) return identity;
  const subject = ok(identity.value.subject);
  const historical = historicalAcceptanceNext(
    record,
    identity.value,
    base,
    reviewerRules(workspace),
  );
  if (historical) return ok(historical);
  if (await hasCurrentAcceptance(workspace, record, subject.value))
    return ok({
      ...base,
      action: "complete",
      objective: "Required product outcomes have current acceptance evidence",
      evidence: [],
      mayEdit: false,
    });
  const allClosed = record.brief.slices.every((entry) =>
    closedSlice(record.state.slices[entry.id]?.status),
  );
  if (allClosed)
    return withRegressionScopeAdviceResult(
      workspace,
      record,
      await nextClosedProduct(workspace, record, subject.value),
      identity.value.sourceSnapshot,
      subject.value,
    );
  if (!slice)
    return ok({
      ...base,
      action: "understand",
      objective: "Resolve the remaining slice dependencies",
      command: cliCommand("brief", { feature: record.brief.feature }),
      evidence: [],
      mayEdit: false,
    });
  if (
    draftSlice(workspace, record.brief, slice) &&
    record.state.slices[slice.id]?.status === "in-progress"
  )
    return ok({
      ...base,
      action: "implement",
      objective: draftObjective(),
      command: draftCheckCommand(record.brief.feature),
      evidence: [],
      mayEdit: true,
    });
  const next = await nextOpenSlice(workspace, record, slice, subject.value);
  return next.ok && next.value.action === "implement"
    ? ok(
        await withRegressionScopeAdvice(
          workspace,
          record,
          withNotObservedAdvice(next.value, record, subject.value),
          slice,
          identity.value.sourceSnapshot,
          subject.value,
        ),
      )
    : next;
}

async function hasCurrentAcceptance(
  workspace: WorkspaceState,
  record: ProductRecord,
  subject: string,
) {
  return (
    record.state.status === "accepted" &&
    record.state.acceptedSubject === subject &&
    currentProductFailures(record, subject).length === 0 &&
    (await productEvidenceGaps(workspace, record, subject)).length === 0 &&
    finalProductAssessmentGaps(record, subject).length === 0
  );
}

async function unavailableEnvironmentNext(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice?: ProductSlice,
) {
  const capability = record.state.browserCapability;
  if (
    !needsBrowser(record.brief, slice) ||
    capability?.status !== "unavailable" ||
    !(await browserCapabilityApplies(workspace.paths.root, capability))
  )
    return undefined;
  const rerun =
    record.state.executions.some(
      (entry) => entry.status === "environment-failed" || entry.status === "timed-out",
    ) || record.brief.slices.every((entry) => closedSlice(record.state.slices[entry.id]?.status));
  const next = environmentNext(
    record.brief.feature,
    slice?.id,
    [capability.detail],
    rerun ? "verify" : "work",
  );
  if (slice && !closedSlice(record.state.slices[slice.id]?.status)) {
    const authorization = await readProductAuthorization(workspace, record);
    if (!authorization.ok || authorization.value?.task !== slice.id) return undefined;
    return {
      ...next,
      mayEdit: true,
      objective: "Continue within authorized scope; recover the browser before acceptance",
    };
  }
  return next;
}
