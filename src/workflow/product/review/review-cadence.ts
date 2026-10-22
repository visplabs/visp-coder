import type { WorkspaceState } from "../../state.js";
import { outstandingFeedback } from "../findings.js";
import type { ProductSlice } from "../model.js";
import { profileSettings } from "../profile.js";
import type { ProductRecord } from "../store.js";
import { completesFeature } from "./review-selection.js";

/**
 * The lean profile's review cadence (`workflow.reviewCadence: feature`). In October code runs
 * 47% of reviews were empty and 7 of 20 required findings named slices not yet built; with
 * Haiku 4.5 workers, review rounds 3 and later raised the hidden-check score in 14 of 48 and 2
 * of 12 rounds against 45 of 54 and 32 of 53 for rounds 1 and 2, and an extra repair round
 * gained nothing (Q5, pm1). So only the slice that completes the feature is reviewed, at most
 * twice, and the second time only while a required finding is open.
 */
const LEAN_REVIEW_ROUNDS = 2;

export function featureReviewCadence(workspace: WorkspaceState, record: ProductRecord): boolean {
  return profileSettings(workspace, record).reviewCadence === "feature";
}

export const LEAN_MIDDLE_SLICE_REASON =
  "Lean review cadence: the independent review runs once the slice that completes the feature is done; no call spent";

/**
 * Why another product review may not run, under the lean cadence; undefined when it may. A round
 * is a review VISP recorded: an attempt that ended unavailable (no answer, or an answer VISP
 * rejected) spends a call from the budget but not a round. In batch leandef2 a rejected review
 * counted as the round, so the repaired product was never re-reviewed.
 */
export function reviewRoundGap(
  workspace: WorkspaceState,
  record: ProductRecord,
  spending: {
    readonly budget: {
      readonly entries: readonly { key: string; phase: string; noResponse?: boolean }[];
    };
    readonly unreviewed: ReadonlySet<string>;
  },
): string | undefined {
  if (!featureReviewCadence(workspace, record)) return undefined;
  const reviews = spending.budget.entries.filter(
    (entry) =>
      entry.phase === "product" && !entry.noResponse && !spending.unreviewed.has(entry.key),
  ).length;
  if (reviews === 0) return undefined;
  if (reviews >= LEAN_REVIEW_ROUNDS)
    return "Two independent reviews ran; the lean review cadence reviews at most twice. Set workflow.profile: full for more.";
  if (
    outstandingFeedback(record).some((finding) => finding.required && finding.phase === "product")
  )
    return undefined;
  return "One independent review ran and no required finding is open; the lean review cadence reviews again only for required findings.";
}

/** A slice before the one that completes the feature closes on its checks; the feature review assesses its outcomes. */
export function deferredOutcomeReview(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice | undefined,
): boolean {
  return !!slice && featureReviewCadence(workspace, record) && !completesFeature(record, slice.id);
}
