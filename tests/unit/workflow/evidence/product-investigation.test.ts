import { afterEach, expect, it } from "vitest";
import { productFeedbackPlan } from "../../../../src/workflow/product/feedback.js";
import {
  runProductVerify,
  runProductWork,
  updateProductBrief,
} from "../../../../src/workflow/product/index.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

const workspaces: TestWorkspace[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.destroy()));
});

it("repeated execution failures take priority over an unrelated research uncertainty", async () => {
  const setup = await productWorkspace();
  workspaces.push(setup.workspace);
  const updated = await updateProductBrief(await setup.workspace.state(), {
    brief: { ...setup.brief, uncertainties: ["Which optional color palette should be used?"] },
    reason: "Keep an optional design question visible",
  });
  if (!updated.ok) throw new Error(updated.error.message);
  const work = await runProductWork(await setup.workspace.state(), { task: "T001" });
  if (!work.ok) throw new Error(work.error.message);
  await runProductVerify(await setup.workspace.state(), { task: "T001" });
  const repeated = await runProductVerify(await setup.workspace.state(), { task: "T001" });
  if (!repeated.ok) throw new Error(repeated.error.message);
  expect(repeated.value.feedbackPlan?.research).toMatchObject({
    question: expect.stringContaining("C001"),
    required: false,
  });
  const correction = await runProductWork(await setup.workspace.state(), { task: "T001" });
  if (!correction.ok) throw new Error(correction.error.message);
  expect(correction.value.uncertainties).toContain("Which optional color palette should be used?");
  expect(correction.value.feedbackPlan?.trace.question).toContain("C001");
  expect(correction.value.files.some((file) => file.path === "src/value.mjs")).toBe(true);
});

it("current behavioral failures and required findings precede repeated optional styling feedback", async () => {
  const setup = await productWorkspace();
  workspaces.push(setup.workspace);
  const state = await setup.workspace.state();
  const work = await runProductWork(state, { task: "T001" });
  if (!work.ok) throw new Error(work.error.message);
  const verified = await runProductVerify(await setup.workspace.state(), { task: "T001" });
  if (!verified.ok) throw new Error(verified.error.message);
  const loaded = await readProductRecord(await setup.workspace.state(), { task: "T001" });
  if (!loaded.ok) throw new Error(loaded.error.message);
  const record = loaded.value;
  const execution = record.state.executions.at(-1);
  if (!execution) throw new Error("Missing failed behavior execution");
  const optional = {
    dimension: "experience" as const,
    problem: "Prefer a rounder score badge",
    nextCheck: "Compare score badge corner treatments",
    outcomes: ["O001"],
    required: false,
    evidence: [],
  };
  const review = {
    policyVersion: 4 as const,
    subjectDigest: verified.value.subjectDigest,
    contractDigest: execution.contractDigest,
    createdAt: "now",
    assessments: [],
    captures: [],
    feedback: { phase: "product" as const, dimensions: [], findings: [optional], resolutions: [] },
  };
  record.state.reviews.push(review, review);
  const inspect = () =>
    productFeedbackPlan(record, verified.value.subjectDigest, record.brief.slices[0]);
  for (const repeated of [false, true]) {
    if (repeated) record.state.executions.push({ ...execution, id: "second-recorded-failure" });
    const plan = inspect();
    expect(plan.research).toMatchObject({
      question: expect.stringContaining("C001"),
      required: false,
    });
    expect(plan.trace.question).toContain("C001");
    expect(plan.nextCheck).toContain("C001");
    expect(plan.findings[0]?.problem).toBe(optional.problem);
  }
  const required = {
    ...optional,
    dimension: "functional" as const,
    problem: "Restart preserves the old score",
    nextCheck: "Restart and inspect score zero",
    required: true,
  };
  record.state.reviews.push({ ...review, feedback: { ...review.feedback, findings: [required] } });
  expect(inspect().research?.question).toContain(required.problem);
  expect(inspect().trace.question).toContain(required.problem);

  // Optional advice stays available after behavior failures and required findings are gone.
  record.state.reviews.pop();
  record.state.executions.push({ ...execution, id: "corrected-run", status: "passed" });
  expect(inspect().research?.question).toContain(optional.problem);
  expect(inspect().trace.question).toContain(optional.problem);
});
