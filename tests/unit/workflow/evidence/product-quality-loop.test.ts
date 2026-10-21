import { afterEach, describe, expect, it, vi } from "vitest";
import { hashValue } from "../../../../src/core/hash.js";
import type { Result } from "../../../../src/core/result.js";
import {
  feedbackTemplate,
  outstandingFeedback,
} from "../../../../src/workflow/product/feedback.js";
import { runProductHostFeedback } from "../../../../src/workflow/product/host-feedback.js";
import {
  runProductAccept,
  runProductDone,
  runProductNext,
  runProductReview,
  runProductVerify,
  runProductWork,
  updateProductBrief,
} from "../../../../src/workflow/product/index.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { moduleFeedback } from "../../support/product-feedback.js";
import { productWorkspace } from "../../support/product-workspace.js";

const projects: Awaited<ReturnType<typeof productWorkspace>>[] = [];
afterEach(async () => {
  for (const project of projects.splice(0)) await project.workspace.destroy();
});
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
async function fixture() {
  const project = await productWorkspace();
  projects.push(project);
  return project;
}
async function implemented() {
  const project = await fixture();
  value(await runProductWork(await project.workspace.state()));
  await project.workspace.write("src/value.mjs", "export const value = 2;\n");
  expect(value(await runProductDone(await project.workspace.state())).closed).toBe(true);
  return project;
}
async function assess(project: Awaited<ReturnType<typeof fixture>>, finding = false) {
  const bundle = value(await runProductReview(await project.workspace.state()));
  const feedback = moduleFeedback(bundle);
  if (finding)
    feedback.findings.push({
      dimension: "functional",
      problem: "Repeated reads have not been checked",
      nextCheck: "Import twice and compare both public values",
      outcomes: ["O001"],
      required: true,
      evidence: [],
    });
  return value(
    await runProductReview(await project.workspace.state(), {
      subjectDigest: bundle.subjectDigest,
      reviewer: { context: "current" },
      feedback,
      assessments: [
        {
          outcome: "O001",
          status: "satisfied",
          summary: "Actual exported value is two",
          evidence: ["C001"],
        },
      ],
    }),
  );
}

describe("integrated quality feedback", () => {
  it("validates host configuration and malformed or substituted review results", async () => {
    const project = await fixture();
    const state = await project.workspace.state();
    for (const host of [
      { model: "" },
      { model: "configured", timeoutMs: 0 },
      { model: "configured", timeoutMs: Number.NaN },
      { model: "configured", timeoutMs: 600001 },
    ])
      expect(await runProductHostFeedback(state, host)).toMatchObject({
        ok: false,
        error: { code: "CONFIG_INVALID" },
      });
    expect(
      await runProductHostFeedback(state, { model: "configured", review: async () => ({}) }),
    ).toMatchObject({ ok: false, error: { code: "ARTIFACT_INVALID" } });
    expect(
      await runProductHostFeedback(state, {
        model: "configured",
        review: async () => ({ subjectDigest: "other-product", assessments: [] }),
      }),
    ).toMatchObject({ ok: false, error: { code: "EVIDENCE_FAILED" } });
  });

  it("does not consume missing, malformed, unrelated or stale research", async () => {
    const project = await fixture();
    value(
      await updateProductBrief(await project.workspace.state(), {
        brief: {
          ...project.brief,
          uncertainties: ["Which public value implementation is appropriate?"],
        },
        reason: "Resolve a real implementation choice",
      }),
    );
    const result = {
      conclusion: "Keep a constant",
      evidence: ["Inspected module"],
      implication: "Use the existing export",
      check: "C001",
    };
    const state = await project.workspace.state();
    expect(
      await runProductHostFeedback(state, {
        model: "configured",
        research: async () => {
          throw new Error("Research tool unavailable");
        },
      }),
    ).toMatchObject({ ok: false, error: { code: "COMMAND_FAILED" } });
    expect(
      await runProductHostFeedback(state, { model: "configured", research: async () => ({}) }),
    ).toMatchObject({ ok: false, error: { code: "ARTIFACT_INVALID" } });
    expect(
      await runProductHostFeedback(state, {
        model: "configured",
        research: async () => ({ ...result, check: "MISSING" }),
      }),
    ).toMatchObject({ ok: false, error: { code: "ARTIFACT_INVALID" } });
    expect(
      await runProductHostFeedback(state, {
        model: "configured",
        research: async () => {
          await project.workspace.write("src/value.mjs", "export const value = 3;");
          return result;
        },
      }),
    ).toMatchObject({ ok: false, error: { code: "STATE_BUSY" } });
    const record = value(await readProductRecord(await project.workspace.state()));
    expect(record.brief.decisions).toEqual([]);
    expect(record.brief.uncertainties).toHaveLength(1);
  });

  it("routes explicit dispatch through the shared operation and retains an unavailable CLI adapter", async () => {
    const project = await fixture();
    const { runProductReviewRequest, validateProductReviewRequest } = await import(
      "../../../../src/workflow/product/review/review-request.js"
    );
    expect(validateProductReviewRequest({ dispatch: true, handoff: true }).ok).toBe(false);
    expect(validateProductReviewRequest({ feedback: {}, assessments: undefined }).ok).toBe(false);
    const result = await runProductReviewRequest(await project.workspace.state(), {
      dispatch: true,
    });
    expect(result).toMatchObject({
      ok: true,
      value: { recorded: true, reviewer: { context: "unavailable" } },
    });
    const record = value(await readProductRecord(await project.workspace.state()));
    expect(
      record.state.reviews
        .at(-1)
        ?.feedback?.dimensions.every((entry) => entry.status === "unavailable"),
    ).toBe(true);
  });
  it("starts implementation without a mandatory understanding review", async () => {
    const { workspace } = await fixture();
    expect(value(await runProductNext(await workspace.state())).action).toBe("implement");
    const work = value(await runProductWork(await workspace.state()));
    expect(work.originalRequest).toBe("Return two from the public module");
  });

  it("accepts evidenced mandatory outcomes without a separate five-category form", async () => {
    const project = await implemented();
    const bundle = value(await runProductReview(await project.workspace.state()));
    expect(bundle.sources).toContainEqual(
      expect.objectContaining({
        reference: "test/value.test.mjs",
        excerpt: expect.stringContaining("assert.equal(value,2)"),
      }),
    );
    value(
      await runProductReview(await project.workspace.state(), {
        subjectDigest: bundle.subjectDigest,
        assessments: [
          { outcome: "O001", status: "satisfied", summary: "The test passed", evidence: ["C001"] },
        ],
      }),
    );
    const rejected = value(await runProductAccept(await project.workspace.state()));
    expect(rejected.passed).toBe(true);
    await assess(project);
    expect(value(await runProductAccept(await project.workspace.state())).passed).toBe(true);
  });

  it("retains a required finding until new executed counterevidence is explicitly assessed as disproof", async () => {
    const project = await implemented();
    const first = await assess(project, true);
    const id = first.feedbackPlan.findings[0]?.id;
    expect(id).toMatch(/^FB-/);
    await assess(project);
    expect(value(await runProductAccept(await project.workspace.state())).passed).toBe(false);
    const record = value(await readProductRecord(await project.workspace.state()));
    value(
      await updateProductBrief(await project.workspace.state(), {
        brief: {
          ...record.brief,
          goal: "A clearer title",
          checks: record.brief.checks.map((check) => ({
            ...check,
            verifierFiles: ["test/value.test.mjs"],
          })),
        },
        reason: "Identify the verifier for the requested repeated-read counterexample",
      }),
    );
    expect(
      outstandingFeedback(value(await readProductRecord(await project.workspace.state())))[0]?.id,
    ).toBe(id);
    await project.workspace.write(
      "test/value.test.mjs",
      `import assert from 'node:assert/strict';
const first = await import('../src/value.mjs');
const second = await import('../src/value.mjs');
assert.equal(first.value, 2);
assert.equal(second.value, 2);
`,
    );
    value(await runProductVerify(await project.workspace.state()));
    const bundle = value(await runProductReview(await project.workspace.state()));
    const feedback = moduleFeedback(bundle);
    feedback.resolutions = [
      {
        id: id as string,
        disposition: "disproved",
        explanation:
          "The new executed check imports twice and asserts both values equal two, disproving the outstanding concern about unchecked repeated reads.",
        evidence: ["C001"],
      },
    ];
    const resolved = value(
      await runProductReview(await project.workspace.state(), {
        subjectDigest: bundle.subjectDigest,
        feedback,
        assessments: [],
      }),
    );
    expect(resolved.feedbackPlan.findings).toEqual([]);
  });

  it("rejects unknown resolutions and fake references while allowing omitted category declarations", async () => {
    const project = await implemented();
    const bundle = value(await runProductReview(await project.workspace.state()));
    const feedback = moduleFeedback(bundle);
    feedback.resolutions = [{ id: "invented", explanation: "Fixed", evidence: ["C001"] }];
    expect(
      await runProductReview(await project.workspace.state(), {
        subjectDigest: bundle.subjectDigest,
        feedback,
        assessments: [],
      }),
    ).toMatchObject({ ok: false, error: { code: "ARTIFACT_INVALID" } });
    feedback.resolutions = [];
    const dimension = feedback.dimensions[0];
    if (!dimension) throw new Error("Missing fixture dimension");
    dimension.evidence = ["fake"];
    expect(
      await runProductReview(await project.workspace.state(), {
        subjectDigest: bundle.subjectDigest,
        feedback,
        assessments: [],
      }),
    ).toMatchObject({ ok: false, error: { code: "EVIDENCE_FAILED" } });
    const skipped = feedbackTemplate("product");
    skipped.dimensions = skipped.dimensions.map((entry) => ({
      ...entry,
      status: "not-applicable",
      reason: "Skip everything",
    }));
    const result = value(
      await runProductReview(await project.workspace.state(), {
        subjectDigest: bundle.subjectDigest,
        feedback: skipped,
        assessments: [],
      }),
    );
    expect(result.feedbackPlan.gaps.some((entry) => entry.startsWith("functional:"))).toBe(false);
    expect(value(await runProductAccept(await project.workspace.state())).passed).toBe(false);
  });

  it("executes an actual host callback with configured model and consumes its review", async () => {
    const project = await implemented();
    const bundle = value(await runProductReview(await project.workspace.state()));
    const review = vi.fn(async () => ({
      subjectDigest: bundle.subjectDigest,
      assessments: [],
      reviewer: { context: "fresh" },
      feedback: moduleFeedback(bundle),
    }));
    expect(
      (
        await runProductHostFeedback(await project.workspace.state(), {
          model: "configured-small-model",
          review,
        })
      ).ok,
    ).toBe(true);
    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({
        originalRequest: project.brief.originalRequest,
        sources: expect.arrayContaining([expect.objectContaining({ kind: "implementation-file" })]),
      }),
      expect.objectContaining({ model: "configured-small-model", context: "fresh-preferred" }),
    );
    const record = value(await readProductRecord(await project.workspace.state()));
    expect(record.state.reviews.at(-1)?.reviewer?.model).toBe("configured-small-model");
  });

  it("consumes focused research into the existing decision and check instead of a research ledger", async () => {
    const project = await fixture();
    value(
      await updateProductBrief(await project.workspace.state(), {
        brief: {
          ...project.brief,
          uncertainties: ["Should the public value be computed on every import?"],
        },
        reason: "Resolve implementation choice",
      }),
    );
    const research = vi.fn(async () => ({
      conclusion: "A constant export supplies the promised result",
      evidence: ["Inspected src/value.mjs and the public import test"],
      implication: "Keep one immutable public constant",
      check: "C001",
    }));
    const result = await runProductHostFeedback(await project.workspace.state(), {
      model: "configured",
      research,
    });
    expect(result).toMatchObject({
      ok: true,
      value: { research: "consumed", action: "implement", check: "C001" },
    });
    const record = value(await readProductRecord(await project.workspace.state()));
    expect(record.brief.uncertainties).toEqual([]);
    expect(record.brief.decisions.at(-1)?.implications).toContain("Validate with C001");
    expect(record.brief.outcomes).toEqual(project.brief.outcomes);
  });

  it("records unavailable and timed-out review without accepting it or applying late output", async () => {
    const project = await implemented();
    await runProductHostFeedback(await project.workspace.state(), { model: "configured" });
    const result = value(await runProductAccept(await project.workspace.state()));
    expect(result.passed).toBe(false);
    expect(result.gaps.join(" ")).toContain("No host reviewer adapter");
    const unavailable = value(
      await readProductRecord(await project.workspace.state()),
    ).state.reviews.at(-1)?.reviewer;
    expect(unavailable?.context).toBe("unavailable");
    expect(unavailable?.reason).toContain("Retrying --dispatch cannot start a reviewer");
    expect(unavailable?.reason).toContain("perform a current-context review");
    expect(unavailable?.reason).toContain("keep missing evidence unresolved");
    let signal: AbortSignal | undefined;
    await runProductHostFeedback(await project.workspace.state(), {
      model: "configured",
      timeoutMs: 5,
      review: async (_request, options) => {
        signal = options.signal;
        return new Promise(() => {});
      },
    });
    expect(signal?.aborted).toBe(true);
    expect(
      value(await readProductRecord(await project.workspace.state())).state.reviews.at(-1)?.reviewer
        ?.reason,
    ).toContain("timed out");
  });

  it("rejects invalid task selection before dispatch and stale research before mutation", async () => {
    const project = await fixture();
    const review = vi.fn();
    expect(
      await runProductHostFeedback(
        await project.workspace.state(),
        { model: "configured", review },
        { task: "T999" },
      ),
    ).toMatchObject({ ok: false, error: { code: "TASK_NOT_FOUND" } });
    expect(review).not.toHaveBeenCalled();
    const digest = hashValue(project.brief);
    value(
      await updateProductBrief(await project.workspace.state(), {
        brief: { ...project.brief, goal: "Changed concurrently" },
        reason: "Concurrent edit",
      }),
    );
    expect(
      await updateProductBrief(await project.workspace.state(), {
        brief: project.brief,
        reason: "Stale callback",
        expectedBriefDigest: digest,
      }),
    ).toMatchObject({ ok: false, error: { code: "STATE_BUSY" } });
  });
});
