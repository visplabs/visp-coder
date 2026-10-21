import { afterEach, describe, expect, it } from "vitest";
import { ok, type Result } from "../../../../src/core/result.js";
import { productReply } from "../../../../src/mcp/tools/workflow.js";
import {
  estimateProductContextTokens,
  fitProductContext,
} from "../../../../src/workflow/product/context-budget.js";
import type { ProductContextContent } from "../../../../src/workflow/product/context-types.js";
import { runProductContext, runProductWork } from "../../../../src/workflow/product/index.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const context: ProductContextContent = {
  feature: "001-budget",
  task: "T001",
  originalRequest: "Preserve my exact request",
  objective: "Deliver the complete behavior",
  outcomes: [
    {
      id: "O001",
      kind: "functional",
      statement: "Preserve the promised behavior",
      priority: "must",
      provenance: "user-stated",
      reviewRequired: false,
      expectations: [
        { id: "AC1", statement: "Independent expectation", provenance: "independent" },
      ],
    },
  ],
  examples: [],
  decisions: [],
  uncertainties: ["Unknown behavior must stay visible"],
  scope: { allowed: ["src/value.ts"], expected: ["src/value.ts"], forbidden: ["secret/**"] },
  checks: [
    {
      id: "C001",
      command: ["node", "--test"],
      outcomes: ["O001"],
      files: ["src/value.ts"],
      environment: "node",
    },
  ],
  files: [],
  skills: [],
  notes: [],
  mayEdit: true,
  subjectDigest: "a".repeat(64),
  reviewFeedback: [],
  feedback: [],
};

describe("complete product context budgeting", () => {
  it("accounts for the actual CLI and MCP envelopes and optional data", () => {
    const full: ProductContextContent = {
      ...context,
      files: Array.from({ length: 20 }, (_, i) => ({
        path: `src/${i}.ts`,
        content: '"\\\n'.repeat(800),
        truncated: false,
      })),
      skills: [
        {
          path: "skill.md",
          content: "advice".repeat(500),
          truncated: false,
          reason: "skill" as const,
          advisory: true as const,
        },
      ],
    };
    const fitted = fitProductContext(full, 2500, ["brief.yaml", "product-state.json"]);
    expect(fitted.budget.status).toBe("within-budget");
    expect(fitted.budget.estimatedTokens).toBeLessThanOrEqual(2500);
    expect(fitted.budget.omitted.files).toBeGreaterThan(0);
    // An admitted skill outranks source excerpts the worker can read itself.
    expect(fitted.budget.omitted.skills).toBe(0);
    expect(fitted.skills).toHaveLength(1);
    const cli = `${JSON.stringify({ command: "work", ok: true, data: fitted }, null, 2)}\n`;
    const mcp = JSON.stringify(productReply("visp_work", ok(fitted)));
    expect(Math.ceil(Math.max(cli.length, mcp.length) / 4)).toBeLessThanOrEqual(
      fitted.budget.estimatedTokens,
    );
    expect(fitted.budget.estimatedTokens).toBe(estimateProductContextTokens(fitted));
    expect(full.files).toHaveLength(20);
  });

  it("keeps intent, independent expectations and safety boundaries intact on essential overflow", () => {
    const input = {
      ...context,
      originalRequest: "literal original wording ".repeat(500),
      decisions: [
        {
          id: "D001",
          statement: "Research conclusion",
          rationale: "why",
          evidence: ["source"],
          implications: ["Do the safer thing"],
          outcomes: ["O001"],
        },
      ],
    };
    const fitted = fitProductContext(input, 100, ["brief.yaml"]);
    expect(fitted.budget.status).toBe("essential-overflow");
    for (const key of [
      "originalRequest",
      "outcomes",
      "scope",
      "checks",
      "uncertainties",
      "decisions",
    ] as const)
      expect(fitted[key]).toEqual(input[key]);
    expect(fitted.budget.estimatedTokens).toBeGreaterThan(100);
  });

  it("bounds large execution output explicitly while retaining failure identity and review findings", () => {
    const input = {
      ...context,
      feedback: [{ check: "C001", status: "failed", output: "x".repeat(15000), current: true }],
      reviewFeedback: [
        {
          subjectDigest: "a".repeat(64),
          current: true,
          assessments: [
            {
              outcome: "O001",
              status: "failed" as const,
              provenance: "agent-reported" as const,
              expectations: [],
              summary: "Collision passes through the left wall",
              evidence: [],
            },
          ],
        },
      ],
    };
    const fitted = fitProductContext(input, 6000, ["product-state.json"]);
    expect(fitted.feedback[0]).toMatchObject({ check: "C001", current: true, truncated: true });
    expect(fitted.budget.omitted.feedbackCharacters).toBe(13000);
    expect(fitted.reviewFeedback).toEqual(input.reviewFeedback);
    expect(fitted.budget.sources).toContain("product-state.json");
  });

  let workspace: TestWorkspace;
  afterEach(async () => workspace?.destroy());
  it("uses one fitted bundle for read-only context and authorized work", async () => {
    ({ workspace } = await productWorkspace());
    const state = await workspace.state();
    const configured = {
      ...state,
      config: { ...state.config, context: { ...state.config.context, tokenBudget: 2000 } },
    };
    const read = value(await runProductContext(configured));
    expect(read.mayEdit).toBe(false);

    const work = value(await runProductWork(configured));
    expect(work.mayEdit).toBe(true);
    expect(work.outcomes).toEqual(read.outcomes);
    expect(work.budget.estimatedTokens).toBeLessThanOrEqual(work.budget.tokenBudget);
    expect(read.budget.estimatedTokens).toBeLessThanOrEqual(read.budget.tokenBudget);
    if (!read.feedbackPlan) throw new Error("Missing feedback plan");
    const oversizedGuidance = fitProductContext(
      {
        ...read,
        feedbackPlan: {
          ...read.feedbackPlan,
          observationPlan: {
            ...read.feedbackPlan.observationPlan,
            sequence: ["Observe the actual result. ".repeat(1000)],
          },
        },
      },
      2000,
      [],
    );
    expect(oversizedGuidance.budget.omitted.observationGuidance).toBe(true);
    expect(oversizedGuidance.feedbackPlan?.observationPlan.probes).toEqual(
      read.feedbackPlan.observationPlan.probes,
    );
    expect(read.feedbackPlan.observationPlan.probes.map((probe) => probe.kind)).toContain(
      "independent-result",
    );
    const input = {
      ...read,
      files: [{ path: "src/value.ts", content: "export const value = 1;", truncated: false }],
      feedbackPlan: {
        ...read.feedbackPlan,
        nextProbe: {
          id: "PROBE-large",
          kind: "independent-result",
          when: "Invoke the behavior",
          expected: ["Correct result"],
          outcomes: ["O001"],
          question: "Extra advisory context ".repeat(500),
        },
      },
    };
    const essential = fitProductContext(
      { ...input, feedbackPlan: { ...input.feedbackPlan, nextProbe: undefined } },
      10000,
      [],
    );
    const bounded = fitProductContext(input, essential.budget.estimatedTokens + 30, []);
    expect(bounded.budget.omitted.probes).toBe(1);
    expect(bounded.feedbackPlan?.nextProbe).toBeUndefined();
    expect(bounded.files).toEqual(input.files);
    expect(bounded.budget.status).toBe("within-budget");
  });
});
