import type { WorkspaceState } from "../../state.js";
import { outstandingFeedback } from "../findings.js";
import type { ProductSlice } from "../model.js";
import type { ProductRecord } from "../store.js";
import { completesFeature } from "./review-selection.js";

/**
 * Lean mode's review cadence (`workflow.reviewCadence: feature`). In October code runs 47% of
 * reviews were empty and 7 of 20 required findings named slices not yet built; with Haiku 4.5
 * workers, review rounds 3 and later raised the hidden-check score in 14 of 48 and 2 of 12 rounds
 * against 45 of 54 and 32 of 53 for rounds 1 and 2. So only the slice that completes the feature
 * is reviewed, and a review after the second runs only while a required finding is open.
 */
const LEAN_REVIEW_ROUNDS = 2;

export function featureReviewCadence(workspace: WorkspaceState): boolean {
  return workspace.config.workflow.reviewCadence === "feature";
}

export const LEAN_MIDDLE_SLICE_REASON =
  "Lean review cadence: the independent review runs once the slice that completes the feature is done; no call spent";

/** Why another product review may not run, under the lean cadence; undefined when it may. */
export function reviewRoundGap(
  workspace: WorkspaceState,
  record: ProductRecord | undefined,
  budget: { readonly entries: readonly { phase: string; noResponse?: boolean }[] },
): string | undefined {
  if (!featureReviewCadence(workspace)) return undefined;
  const reviews = budget.entries.filter(
    (entry) => entry.phase === "product" && !entry.noResponse,
  ).length;
  if (reviews < LEAN_REVIEW_ROUNDS) return undefined;
  if (
    record &&
    outstandingFeedback(record).some((finding) => finding.required && finding.phase === "product")
  )
    return undefined;
  return "Two independent reviews ran and no required finding is open; the lean review cadence reviews again only for required findings.";
}

/** A slice before the one that completes the feature closes on its checks; the feature review assesses its outcomes. */
export function deferredOutcomeReview(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice | undefined,
): boolean {
  return !!slice && featureReviewCadence(workspace) && !completesFeature(record, slice.id);
}
