import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import {
  type CriticPacket,
  type ProductCriticHost,
  runProductCritic,
} from "../../../../src/workflow/product/critic/critic.js";
import {
  inlineReview,
  runProductDoneReviewed,
} from "../../../../src/workflow/product/review/done-review.js";
import {
  type IndependentReview,
  independentJudgments,
} from "../../../../src/workflow/product/review/independent-review.js";
import {
  productReviewInstructions,
  REQUEST_GAP_INSTRUCTIONS,
} from "../../../../src/workflow/product/review/review-instructions.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";

/** Lean mode's `workflow.requestGaps: required`: gaps against the request are required, the rest are notes. */
const config = {
  model: "test-critic",
  reasoningEffort: "high" as const,
  harness: "codex" as const,
  transport: "native" as const,
  maxCalls: 3,
  timeoutMs: 5000,
  maxImageBytes: 4194304,
};
const GAP = "Request gap: the request names a default export, and the module has none";
const NOTE = "The constant could carry a comment explaining why it is two";

let setup: Awaited<ReturnType<typeof productWorkspace>>;
afterEach(async () => {
  await setup?.workspace.destroy();
});

function review(gapRequired: boolean): IndependentReview {
  return {
    summary: "Checked the module",
    assessments: [],
    findings: [
      {
        problem: GAP,
        consequence: "Callers of the default export receive undefined",
        nextCheck: "Import the default export",
        evidence: [],
        outcomes: [],
        required: gapRequired,
      },
      {
        problem: NOTE,
        consequence: "A reader may wonder",
        nextCheck: "Read the module",
        evidence: [],
        outcomes: [],
        required: false,
      },
    ],
    limitations: [],
    resolutions: [],
  };
}

it("adds the request-gap rule to reviewer instructions only when asked", () => {
  expect(productReviewInstructions({ requestGaps: true })).toContain(REQUEST_GAP_INSTRUCTIONS);
  expect(productReviewInstructions({ visual: true })).not.toContain("Request gap:");
});

it.each([
  { requestGaps: true, required: [true, false] },
  { requestGaps: false, required: [false, false] },
])("makes a tagged gap required when requestGaps=$requestGaps", ({ requestGaps, required }) => {
  const judged = independentJudgments(review(false), "product", [], { requestGaps });
  expect(judged.feedback.findings.map((finding) => finding.required)).toEqual(required);
});

async function feature(requestGaps: "reviewer" | "required") {
  setup = await productWorkspace({ critic: true });
  const raw = parse(await readFile(join(setup.workspace.root, "visp.yml"), "utf8"));
  raw.critic = { ...raw.critic, ...config, mode: "auto", launch: "codex-exec" };
  raw.workflow = { ...raw.workflow, requestGaps };
  await setup.workspace.write("visp.yml", stringify(raw));
  setup.workspace.commit("configure launched reviewer");
  expect(
    await runProductCritic(await setup.workspace.state(), {
      operation: "set-policy",
      enabled: true,
      harness: "codex",
    }),
  ).toMatchObject({ ok: true });
  expect(await runProductWork(await setup.workspace.state(), { task: "T001" })).toMatchObject({
    ok: true,
  });
  expect(
    await runProductCritic(await setup.workspace.state(), {
      operation: "configure",
      task: "T001",
      config,
    }),
  ).toMatchObject({ ok: true });
}

function host(): ProductCriticHost {
  return {
    inspect: async () => ({
      harness: "codex",
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      freshContext: true,
      images: true,
      readOnly: true,
      delegationAllowed: true,
    }),
    review: vi.fn(async (packet: CriticPacket) => {
      const executions = packet.current.evidence
        .filter((entry) => entry.kind === "execution" && entry.status === "available")
        .map((entry) => entry.id);
      const answer = review(false);
      return {
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        context: "fresh" as const,
        response: {
          ...answer,
          assessments: packet.current.outcomes.map((outcome) => ({
            outcome: outcome.id,
            status: "satisfied" as const,
            summary: "The executed assertion shows the value",
            evidence: executions.slice(0, 1),
            expectations: [],
          })),
          findings: answer.findings.map((finding) => ({
            ...finding,
            evidence: executions.slice(0, 1),
          })),
        },
      };
    }),
  };
}

async function done(reviewer: ProductCriticHost) {
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  return runProductDoneReviewed(
    await setup.workspace.state(),
    { task: "T001" },
    inlineReview(reviewer),
  );
}

it("reports a tagged gap as a required finding and other findings as notes", async () => {
  await feature("required");
  const reviewer = host();
  const result = await done(reviewer);
  expect(vi.mocked(reviewer.review).mock.calls[0]?.[0].instructions).toContain(
    REQUEST_GAP_INSTRUCTIONS,
  );
  expect(result, JSON.stringify(result)).toMatchObject({
    ok: true,
    value: {
      closed: false,
      critic: {
        reviewed: true,
        findings: [{ problem: expect.stringContaining(GAP), required: true }],
        notes: [expect.stringContaining(NOTE)],
      },
    },
  });
  if (result.ok) expect(result.value.critic?.findings).toHaveLength(1);
});

it("leaves the reviewer's own labels and the reply alone by default", async () => {
  await feature("reviewer");
  const reviewer = host();
  const result = await done(reviewer);
  expect(vi.mocked(reviewer.review).mock.calls[0]?.[0].instructions).not.toContain("Request gap:");
  expect(result, JSON.stringify(result)).toMatchObject({
    ok: true,
    value: { critic: { reviewed: true } },
  });
  if (!result.ok) return;
  expect(result.value.critic?.findings.map((finding) => finding.required)).toEqual([false, false]);
  expect(result.value.critic).not.toHaveProperty("notes");
});
