import { cliCommand } from "../next-action.js";
import { validCaptureRuns } from "./capture-run-model.js";
import { needsBrowser } from "./environment.js";
import { evidenceApplies } from "./evidence-references.js";
import type { ProductSlice } from "./model.js";
import type { ProductRecord } from "./store.js";
import { productContractDigest } from "./subject.js";

/** Schedule a judgment of the first rendered slice; captures alone never close it. */
export function visualCheckpoint(
  record: ProductRecord,
  subject: string,
  slice?: ProductSlice,
  reviewer: ReviewerPointer = "host",
) {
  if (!needsBrowser(record.brief, slice)) return undefined;
  const outcomes = record.brief.outcomes.filter(
    (outcome) => outcome.kind === "experience" && (!slice || slice.outcomes.includes(outcome.id)),
  );
  if (!outcomes.length) return undefined;
  const runs = validCaptureRuns(record).filter(
    (run) =>
      evidenceApplies(record, subject, run) && (!slice || !run.task || run.task === slice.id),
  );
  const review = record.state.reviews.findLast(
    (entry) =>
      entry.subjectDigest === subject &&
      (!slice || !entry.task || entry.task === slice.id) &&
      entry.contractDigest ===
        productContractDigest(
          record.brief,
          record.brief.slices.find((owner) => owner.id === entry.task),
        ) &&
      entry.feedback?.phase === "product" &&
      (entry.feedback.dimensions.some((dimension) => dimension.dimension === "experience") ||
        entry.assessments.some((assessment) =>
          outcomes.some((outcome) => outcome.id === assessment.outcome),
        )),
  );
  const assessment = review?.feedback?.dimensions.find((entry) => entry.dimension === "experience");
  const direct =
    review?.assessments.filter((entry) =>
      outcomes.some((outcome) => outcome.id === entry.outcome),
    ) ?? [];
  const satisfied = direct.length
    ? outcomes.every((outcome) =>
        direct.some(
          (entry) =>
            entry.outcome === outcome.id &&
            entry.status === "satisfied" &&
            entry.expectations.every((expectation) => expectation.status === "satisfied"),
        ),
      )
    : assessment?.status === "satisfied";
  const captures = runs.flatMap((run) => run.captures);
  const repeated = runs.length >= 3 && !satisfied;
  return {
    status: !captures.length ? "awaiting-render" : satisfied ? "assessed" : "review-rendered-slice",
    originalRequest: record.brief.originalRequest,
    outcomes: outcomes.map(({ id, statement }) => ({ id, statement })),
    timing:
      "Inspect the first usable rendered slice before expanding content. Revisit after consequential visual changes; no forced cosmetic edits or extra critic calls.",
    images: [
      ...new Map(
        captures.map((capture) => [
          `${capture.viewport.width}x${capture.viewport.height}`,
          capture,
        ]),
      ).values(),
    ]
      .slice(0, 4)
      .map(({ id, path, viewport }) => ({ id, path, viewport })),
    ...reviewPointer(record.brief.feature, slice, reviewer),
    assess:
      "Judge the actual primary activity at each viewport: usable scale, scene composition, hierarchy, contrast, expressive assets/materials and intermediate feedback. Matching the worker's palette or theme is not aesthetic success. A UI can be readable yet visually weak. Give zero to three consequential findings with a concrete visible change and next observation, or explain why the requested experience is already achieved. Use the existing feedback fields.",
    ...(repeated
      ? {
          recovery:
            "Repeated captures of this source have not produced a satisfied visual assessment. Diagnose any evidence/host gap once; then inspect the rendered product and address the most consequential visible mismatch. Editing observation attributes or check descriptions is not visual refinement. If no reviewer is available, report that gap instead of repeating capture or inventing approval.",
        }
      : {}),
  };
}

/** Who reads the images: the host's reviewer, VISP's own, or the human once VISP's is gone. */
export type ReviewerPointer = "host" | "visp" | "gone";

function reviewPointer(
  feature: string,
  slice: ProductSlice | undefined,
  reviewer: ReviewerPointer,
) {
  const task = slice?.id;
  if (reviewer === "visp")
    return {
      imageStatus:
        "Recorded references only; VISP's independent reviewer receives the actual image bytes when you run visp done. Missing, stale or unviewed images cannot establish quality.",
      command: cliCommand("done", { feature, task }),
    };
  if (reviewer === "gone")
    return {
      imageStatus:
        "Recorded references only; VISP's independent reviewer cannot run again (its review budget is spent or it is unavailable), so the human reviewer receives the images: run visp pr. Missing, stale or unviewed images cannot establish quality.",
      command: cliCommand("pr", { feature }),
    };
  return {
    imageStatus:
      "Recorded references only; review handoff verifies and delivers the actual image bytes. Missing, stale or unviewed images cannot establish quality.",
    command: cliCommand("review", { feature, task, handoff: true }),
  };
}
