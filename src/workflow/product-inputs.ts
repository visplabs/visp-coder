import { ok, type Result } from "../core/result.js";
import { feedbackTemplate } from "./product/feedback.js";
import { assessmentSchema, type ProductBrief } from "./product/model.js";
import { type ProductReviewBundle, runProductReview } from "./product/review/review.js";
import { type ProductSelection, readProductBrief } from "./product/store.js";
import { CHECK_OUTPUT_GUIDANCE } from "./product-output-guidance.js";
import type { WorkspaceState } from "./state.js";

/** Field examples are advice, never authored outcomes or passing evidence. */
export const PRODUCT_BRIEF_ENTRY_GUIDE = `Empty template arrays need objects, not strings. Keep the template's version,
feature, originalRequest and acceptanceBaseline. Adapt these entries to the task;
this example is neither a completed brief nor evidence that the product works:

\`\`\`yaml
outcomes:
  - {id: O001, kind: functional, statement: Valid input returns the expected result, priority: must}
examples:
  - {id: E001, title: Valid request, given: [Server is ready], when: Submit valid input, expected: [Expected result is returned], outcomes: [O001]}
decisions:
  - {id: D001, statement: Use the existing server entry point, rationale: Keep the change focused}
checks:
  - {id: C001, command: [node, --test, test/api.test.mjs], outcomes: [O001], files: [server.mjs, test/api.test.mjs]}
slices:
  - id: T001
    goal: Implement and exercise the first complete request
    outcomes: [O001]
    scope: {allowed: [server.mjs, test/api.test.mjs]}
    checks: [C001]
\`\`\`

Use one slice unless the request has parts a user could use independently; each extra slice
adds a check-and-review cycle. Close each slice with visp done before starting the next.
Scope entries are repository-relative file paths/globs, not descriptions of behavior.
Prefer patch for changes: arrays merge entries by id, omitted entries are preserved, and new entries may omit id.
Do not include version, feature, originalRequest or acceptanceBaseline in a patch.
Checks must assert actual expected results. ${CHECK_OUTPUT_GUIDANCE}
`;

/** Editable input is derived from the current brief, never a prefilled passing judgment. */
export async function productInputTemplate(
  workspace: WorkspaceState,
  kind: "brief" | "review",
  selection: ProductSelection = {},
): Promise<Result<ProductBrief | ReturnType<typeof reviewInputTemplate>>> {
  if (kind === "brief") return readProductBrief(workspace, selection);
  const bundle = await runProductReview(workspace, selection);
  if (!bundle.ok) return bundle;
  return ok(reviewInputTemplate(bundle.value));
}

export function reviewInputTemplate(bundle: ProductReviewBundle) {
  return {
    subjectDigest: bundle.subjectDigest,
    selection: bundle.selection,
    ...reviewJudgmentsTemplate(bundle),
  };
}

/** Prepared sessions own subject and selection identity; reviewers author only these judgments. */
function reviewJudgmentsTemplate(bundle: ProductReviewBundle) {
  return {
    experimentResolutions: [],
    feedback: {
      ...feedbackTemplate("product"),
      probes: bundle.agenda.behavioralProbes.probes
        .filter(
          (probe) =>
            bundle.gaps.length > 0 ||
            !bundle.feedbackPlan.probeResponses.some(
              (response) =>
                response.kind === probe.kind &&
                ["satisfied", "not-applicable"].includes(response.status),
            ),
        )
        .map((probe) => ({
          kind: probe.kind as "independent-result" | "repeat-and-recover" | "rendered-usability",
          expected: probe.expected.join("; "),
          basis:
            probe.kind === "rendered-usability"
              ? "Identify the retained expectation or explain this agent-proposed expectation independently of the implementation. For a satisfied result, cite at least one current image ID and one matching operation or execution ID from evidence; image-only evidence remains unclear."
              : "Identify the retained expectation or explain this agent-proposed expectation independently of the implementation.",
          exercise: probe.when,
          observed: "Not yet exercised and assessed; record a concrete result or coverage gap.",
          status: "unclear" as const,
          evidence: [] as string[],
        })),
    },
    reviewer: { context: "unspecified" as const },
    coverage: [],
    assessments: bundle.outcomes
      .filter(
        (outcome) =>
          bundle.gaps.length > 0 ||
          !bundle.assessments.some(
            (entry) => entry.outcome === outcome.id && entry.status === "satisfied",
          ),
      )
      .map((outcome) =>
        assessmentSchema.parse({
          outcome: outcome.id,
          status: "unclear",
          summary: `Expected: ${outcome.statement}. Observations have not been assessed.`,
          evidence: [],
          expectations: outcome.expectations.map((expectation) => ({
            id: expectation.id,
            status: "unclear",
            reason: `Expected: ${expectation.statement}. Observations have not been assessed.`,
            evidence: [],
          })),
        }),
      ),
  };
}
