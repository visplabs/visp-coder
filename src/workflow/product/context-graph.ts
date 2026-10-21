import { checkCurrency, type GraphSnapshot } from "../../graph/index.js";

import type { WorkspaceState } from "../state.js";

const OBSERVED_CURRENCY = new WeakMap<WorkspaceState, Map<string, { gap?: string }>>();

/** Advice may reuse a reply's observation; gates still perform their own currency checks. */
export function observedProductGraphCurrency(workspace: WorkspaceState, snapshotId: string) {
  return OBSERVED_CURRENCY.get(workspace)?.get(snapshotId);
}

/** Skill selection requires facts from this checkout's current inputs. */
export async function productGraphCurrencyGap(
  workspace: WorkspaceState,
  snapshot: GraphSnapshot,
): Promise<string | undefined> {
  if (snapshot.root !== workspace.paths.root) return "index belongs to another checkout";
  const currency = await checkCurrency(workspace.paths.root, snapshot, workspace.config.graph);
  const gap = !currency.ok
    ? currency.error.message
    : currency.value.state !== "current"
      ? `index is ${currency.value.state}`
      : undefined;
  const observations = OBSERVED_CURRENCY.get(workspace) ?? new Map();
  observations.set(snapshot.id, { gap });
  OBSERVED_CURRENCY.set(workspace, observations);
  return gap;
}
