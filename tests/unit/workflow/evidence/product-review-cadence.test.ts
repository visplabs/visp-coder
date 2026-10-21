import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import {
  type CriticPacket,
  type ProductCriticHost,
  runProductCritic,
} from "../../../../src/workflow/product/critic/critic.js";
import { reviewerCapacity } from "../../../../src/workflow/product/critic/critic-capacity.js";
import { runProductAccept } from "../../../../src/workflow/product/evidence.js";
import { updateProductBrief } from "../../../../src/workflow/product/index.js";
import {
  inlineReview,
  runProductDoneReviewed,
} from "../../../../src/workflow/product/review/done-review.js";
import type { IndependentReview } from "../../../../src/workflow/product/review/independent-review.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";

/** Lean mode's `workflow.reviewCadence: feature`: one review at the end, two rounds unless required findings remain. */
const config = {
  model: "test-critic",
  reasoningEffort: "high" as const,
  harness: "codex" as const,
  transport: "native" as const,
  maxCalls: 3,
  timeoutMs: 5000,
  maxImageBytes: 4194304,
};
let setup: Awaited<ReturnType<typeof productWorkspace>>;
afterEach(async () => {
  await setup?.workspace.destroy();
});

async function feature(cadence: "slice" | "feature", slices: number) {
  setup = await productWorkspace({ critic: true });
  const raw = parse(await readFile(join(setup.workspace.root, "visp.yml"), "utf8"));
  raw.critic = { ...raw.critic, ...config, mode: "auto", launch: "codex-exec" };
  raw.workflow = { ...raw.workflow, reviewCadence: cadence };
  await setup.workspace.write("visp.yml", stringify(raw));
  setup.workspace.commit("configure launched reviewer");
  const outcomes = [setup.brief.outcomes[0], { ...setup.brief.outcomes[0], id: "O002" }].map(
    (outcome) => ({ ...outcome, reviewRequired: true }),
  );
  const updated = await updateProductBrief(await setup.workspace.state(), {
    brief: {
      ...setup.brief,
      outcomes,
      checks: setup.brief.checks.map((check) => ({
        ...check,
        outcomes: ["O001", "O002"],
        verifierFiles: ["test/value.test.mjs"],
      })),
      slices: ["T001", "T002", "T003"].slice(0, slices).map((id) => ({
        ...setup.brief.slices[0],
        id,
        outcomes: [id === "T002" ? "O002" : "O001"],
        checks: ["C001"],
      })),
    },
    reason: "Independently completed slices",
    intentChange: { reason: "Require independent review of each outcome", provenance: "test" },
  });
  expect(updated, JSON.stringify(updated)).toMatchObject({ ok: true });
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

/** One verdict per review: `required` reports a required finding, `clean` none. */
function host(verdicts: readonly ("required" | "clean")[] = ["clean"]): ProductCriticHost {
  let call = 0;
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
    review: vi.fn(async (packet: CriticPacket) => ({
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      context: "fresh" as const,
      response: answer(packet, verdicts[Math.min(call++, verdicts.length - 1)] ?? "clean"),
    })),
  };
}

function answer(packet: CriticPacket, verdict: "required" | "clean"): IndependentReview {
  const executions = packet.current.evidence
    .filter((entry) => entry.kind === "execution" && entry.status === "available")
    .map((entry) => entry.id);
  return {
    summary: "Checked the current value assertion",
    assessments: packet.current.outcomes.map((outcome) => ({
      outcome: outcome.id,
      status: verdict === "required" ? "failed" : "satisfied",
      summary: "The executed assertion shows the value",
      evidence: executions.slice(0, 1),
      expectations: [],
    })),
    findings:
      verdict === "required"
        ? [
            {
              problem: "The module has no default export",
              consequence: "Callers of the default export receive undefined",
              nextCheck: "Import the default export and compare it with two",
              evidence: executions.slice(0, 1),
              outcomes: packet.current.outcomes.map((outcome) => outcome.id),
              required: true,
            },
          ]
        : [],
    limitations: [],
    resolutions:
      verdict === "required"
        ? []
        : (packet.openFindings ?? []).map((finding) => ({
            id: finding.id,
            disposition: "repaired" as const,
            explanation: "The default export is two now.",
            evidence: executions.slice(0, 1),
            regression: { kind: "not-applicable" as const, explanation: "A constant export." },
          })),
    disputes: [],
  };
}

async function done(task: string, reviewer: ProductCriticHost, revision: number) {
  await setup.workspace.write("src/value.mjs", `export const value = 2; // revision ${revision}\n`);
  return runProductDoneReviewed(await setup.workspace.state(), { task }, inlineReview(reviewer));
}

it("reviews only the slice that completes the feature", async () => {
  await feature("feature", 3);
  const reviewer = host();
  for (const [index, task] of ["T001", "T002", "T003"].entries()) {
    if (index)
      expect(await runProductWork(await setup.workspace.state(), { task })).toMatchObject({
        ok: true,
      });
    const result = await done(task, reviewer, index);
    expect(result, `${task}: ${JSON.stringify(result)}`).toMatchObject({
      ok: true,
      value: {
        closed: true,
        critic:
          index < 2
            ? { reviewed: false, reason: expect.stringContaining("completes the feature") }
            : { reviewed: true },
      },
    });
  }
  expect(reviewer.review).toHaveBeenCalledTimes(1);
  expect(vi.mocked(reviewer.review).mock.calls[0]?.[0]).toMatchObject({
    selection: { task: undefined },
    current: { outcomes: [{ id: "O001" }, { id: "O002" }] },
  });
  expect(await runProductAccept(await setup.workspace.state(), {})).toMatchObject({
    ok: true,
    value: { passed: true },
  });
});

it.each([
  { cadence: "feature" as const, verdicts: ["required", "clean"] as const, available: false },
  { cadence: "feature" as const, verdicts: ["required", "required"] as const, available: true },
  { cadence: "slice" as const, verdicts: ["required", "clean"] as const, available: true },
])(
  "after two reviews ($verdicts) with $cadence cadence, another review available=$available",
  async ({ cadence, verdicts, available }) => {
    await feature(cadence, 1);
    const reviewer = host(verdicts);
    expect(await done("T001", reviewer, 1)).toMatchObject({
      ok: true,
      value: { critic: { reviewed: true } },
    });
    expect(await runProductWork(await setup.workspace.state(), { task: "T001" })).toMatchObject({
      ok: true,
    });
    const second = await done("T001", reviewer, 2);
    expect(second).toMatchObject({ ok: true, value: { critic: { reviewed: true } } });
    if (!second.ok) return;
    expect(reviewer.review).toHaveBeenCalledTimes(2);
    const third = await reviewerCapacity(
      await setup.workspace.state(),
      setup.brief.feature,
      second.value.subjectDigest,
    );
    expect(third).toMatchObject(
      available
        ? { available: true }
        : { available: false, reason: expect.stringContaining("Two independent reviews") },
    );
  },
);
