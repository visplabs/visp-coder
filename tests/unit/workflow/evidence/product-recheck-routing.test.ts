import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { hashValue } from "../../../../src/core/hash.js";
import { registerWorkflowTools } from "../../../../src/mcp/tools/workflow.js";
import { productJourneyKey } from "../../../../src/workflow/evidence/product-journey.js";
import { productCaptureRunSchema } from "../../../../src/workflow/product/capture-run-model.js";
import { describeProductCheck } from "../../../../src/workflow/product/check/check-command.js";
import { runProductAccept, runProductDone } from "../../../../src/workflow/product/evidence.js";
import { currentJourneyFeedback } from "../../../../src/workflow/product/evidence-references.js";
import { outstandingFeedback } from "../../../../src/workflow/product/feedback.js";
import { findFunctionalRepair } from "../../../../src/workflow/product/functional-resolution.js";
import { closedSlice } from "../../../../src/workflow/product/model.js";
import { runProductReview } from "../../../../src/workflow/product/review/review.js";
import { runProductNext, runProductStatus } from "../../../../src/workflow/product/status.js";
import { readProductRecord, saveProductState } from "../../../../src/workflow/product/store.js";
import {
  productContractDigest,
  productSourceDigest,
} from "../../../../src/workflow/product/subject.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { runJson } from "../../cli/support/cli.js";
import { productWorkspace } from "../../support/product-workspace.js";

let setup: Awaited<ReturnType<typeof productWorkspace>>;
beforeEach(async () => {
  setup = await productWorkspace();
});
afterEach(async () => {
  await setup.workspace.destroy();
});

/** Exercise the registered adapters over the same saved state, without test-only routing. */
async function nextAcrossInterfaces(...args: Parameters<typeof runProductNext>) {
  const statePath = join(
    setup.workspace.root,
    ".visp/features",
    setup.brief.feature,
    "product-state.json",
  );
  const before = await readFile(statePath, "utf8");
  const next = await runProductNext(...args);
  if (!next.ok) throw new Error(next.error.message);
  const options = args[1] ?? {};
  const selection = [
    ...(options.feature ? ["--feature", options.feature] : []),
    ...(options.task ? ["--task", options.task] : []),
  ];
  const cli = await runJson(setup.workspace.root, "next", ...selection);
  expect(cli.exitCode).toBe(0);
  expect(cli.envelope.data).toEqual(next.value);
  type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;
  const handlers = new Map<string, Handler>();
  registerWorkflowTools(
    {
      registerTool(name: string, _config: unknown, handler: Handler) {
        handlers.set(name, handler);
      },
    } as unknown as McpServer,
    setup.workspace.root,
  );
  const call = async (name: string) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`Missing tool ${name}`);
    const response = await handler({ ...options, detail: true });
    expect(response.isError).not.toBe(true);
    return (response.structuredContent as { data: unknown }).data;
  };
  expect(await call("visp_next")).toEqual(next.value);
  const status = await runJson<{ next: unknown }>(setup.workspace.root, "status", ...selection);
  expect(status.exitCode).toBe(0);
  expect(status.envelope.data?.next).toEqual(next.value);
  expect(await call("visp_status")).toMatchObject({ next: next.value });
  expect(await readFile(statePath, "utf8")).toBe(before);
  return next;
}

const journey = {
  url: "http://127.0.0.1:3000/",
  actions: [{ kind: "click" as const, selector: "#add", capture: false }],
};

async function arrange(
  options: {
    readonly currentRun?: "completed" | "failed" | "shallow";
    readonly findingSubject?: "old" | "current";
    readonly invalidWitness?: "unknown-environment" | "changed-environment" | "missing-journey-key";
  } = {},
) {
  const workspace = await setup.workspace.state();
  const worked = await runProductWork(workspace, { task: "T001" });
  if (!worked.ok) throw new Error(worked.error.message);
  const before = await readProductRecord(await setup.workspace.state(), { task: "T001" });
  if (!before.ok) throw new Error(before.error.message);
  const oldSubject = await productSourceDigest(await setup.workspace.state(), before.value.brief);
  if (!oldSubject.ok) throw new Error(oldSubject.error.message);
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  const current = await readProductRecord(await setup.workspace.state(), { task: "T001" });
  if (!current.ok) throw new Error(current.error.message);
  const currentSubject = await productSourceDigest(
    await setup.workspace.state(),
    current.value.brief,
  );
  if (!currentSubject.ok) throw new Error(currentSubject.error.message);
  const slice = current.value.brief.slices[0];
  if (!slice) throw new Error("Missing fixture slice");
  const contract = productContractDigest(current.value.brief, slice);
  const run = (
    id: string,
    subjectDigest: string,
    status: "completed" | "timed-out",
    selectedJourney = journey,
  ) => ({
    id,
    version: 2 as const,
    provenance: "runner-executed" as const,
    outcomeDigest: current.value.state.outcomeDigest,
    subjectDigest,
    contractDigest: contract,
    task: "T001",
    journeyDigest: hashValue(selectedJourney),
    journeyKey:
      options.invalidWitness === "missing-journey-key"
        ? undefined
        : productJourneyKey(selectedJourney, "T001"),
    comparisonEnvironment:
      options.invalidWitness === "unknown-environment"
        ? undefined
        : options.invalidWitness === "changed-environment" && id === "RUN-current"
          ? "browser-2"
          : "browser-1",
    journey: selectedJourney,
    status,
    ...(status === "timed-out"
      ? { failure: { kind: "behavior", message: "The observed behavior failed" } }
      : {}),
    captures: [],
    operations: [],
  });
  const oldRun = run("RUN-old", oldSubject.value, "timed-out");
  const runs = [oldRun];
  if (options.currentRun === "completed")
    runs.push(run("RUN-current", currentSubject.value, "completed"));
  if (options.currentRun === "failed")
    runs.push(run("RUN-current", currentSubject.value, "timed-out"));
  if (options.currentRun === "shallow")
    runs.push(
      run("RUN-shallow", currentSubject.value, "completed", {
        ...journey,
        actions: [{ kind: "click", selector: "#reset", capture: false }],
      }),
    );
  const finding = {
    dimension: "functional" as const,
    problem: "Repeated Add presses do not increment",
    nextCheck: "Replay Add and Reset",
    outcomes: ["O001"],
    required: true,
    evidence: ["RUN-old"],
  };
  const review = {
    policyVersion: 5 as const,
    subjectDigest: options.findingSubject === "current" ? currentSubject.value : oldSubject.value,
    contractDigest: contract,
    task: "T001",
    createdAt: new Date().toISOString(),
    assessments: [
      {
        outcome: "O001",
        status: "failed" as const,
        provenance: "agent-reported" as const,
        summary: "The repeated Add behavior failed",
        evidence: ["RUN-old"],
        expectations: [],
      },
    ],
    feedback: {
      phase: "product" as const,
      dimensions: [],
      findings: [finding],
      resolutions: [],
    },
    captures: [],
  };
  const execution = {
    id: "EXEC-current",
    check: "C001",
    task: "T001",
    subjectDigest: currentSubject.value,
    contractDigest: contract,
    createdAt: new Date().toISOString(),
    command: "node --test test/value.test.mjs",
    status: "passed" as const,
    exitCode: 0,
    durationMs: 1,
    output: "passed",
    provenance: "supervisor-executed" as const,
    assertions: "runner-observed" as const,
  };
  const saved = await saveProductState(await setup.workspace.state(), current.value, {
    ...current.value.state,
    executions: [execution],
    captureRuns: runs,
    reviews: [review],
  });
  if (!saved.ok) throw new Error(saved.error.message);
}

it("routes an exact successful recheck to fresh review without clearing the finding", async () => {
  await arrange({ currentRun: "completed" });
  const next = await nextAcrossInterfaces(await setup.workspace.state(), { task: "T001" });
  expect(next).toMatchObject({
    ok: true,
    value: {
      action: "refine",
      command: expect.stringContaining("visp review --handoff --feature"),
      mayEdit: true,
      completion: "unresolved-product",
      objective: expect.stringContaining("Reassess"),
    },
  });
  expect(next.value.evidence.join("\n")).toContain(
    "Functional repair requires an adjacent regression check or an assessed reason it does not apply",
  );
  const record = await readProductRecord(await setup.workspace.state(), { task: "T001" });
  if (!record.ok) throw new Error(record.error.message);
  expect(outstandingFeedback(record.value)).toHaveLength(1);
});

it.each([
  ["missing", undefined],
  ["shallow", "shallow"],
  ["failed", "failed"],
] as const)("keeps a %s recheck on repair", async (_label, currentRun) => {
  await arrange({ currentRun });
  const next = await nextAcrossInterfaces(await setup.workspace.state(), { task: "T001" });
  expect(next).toMatchObject({
    ok: true,
    value: { action: "fix", mayEdit: true, completion: "unresolved-product" },
  });
});

it("keeps a current unresolved finding on repair even after a successful replay", async () => {
  await arrange({ currentRun: "completed", findingSubject: "current" });
  const next = await nextAcrossInterfaces(await setup.workspace.state(), { task: "T001" });
  expect(next).toMatchObject({
    ok: true,
    value: { action: "fix", mayEdit: true, completion: "unresolved-product" },
  });
});

it.each(["unknown-environment", "missing-journey-key"] as const)(
  "does not claim an exact repair is ready for assessment with %s",
  async (invalidWitness) => {
    await arrange({ currentRun: "completed", invalidWitness });
    const record = await readProductRecord(await setup.workspace.state(), { task: "T001" });
    if (!record.ok) throw new Error(record.error.message);
    const finding = outstandingFeedback(record.value)[0];
    if (!finding) throw new Error("Missing finding");
    expect(findFunctionalRepair(record.value, finding, ["RUN-current"])).toBeUndefined();
    const next = await nextAcrossInterfaces(await setup.workspace.state(), { task: "T001" });
    expect(next).toMatchObject({
      ok: true,
      value: { action: "fix", completion: "unresolved-product" },
    });
    expect(next.ok && next.value.objective).not.toContain("Reassess the repaired product");
  },
);

it.each(["same", "changed", "unknown"] as const)(
  "routes command repair using the same validator with %s verifier identity",
  async (identity) => {
    await arrange({ currentRun: "completed" });
    const loaded = await readProductRecord(await setup.workspace.state(), { task: "T001" });
    if (!loaded.ok) throw new Error(loaded.error.message);
    const record = loaded.value;
    const review = record.state.reviews[0];
    const current = record.state.executions[0];
    const check = record.brief.checks[0];
    const reported = review?.feedback?.findings[0];
    if (!review || !current || !check || !reported) throw new Error("Missing fixture");
    const after = {
      ...current,
      command: describeProductCheck(check),
      comparisonEnvironment: "command-host",
      verifierDigest: identity === "unknown" ? undefined : "a".repeat(64),
    };
    const before = {
      ...after,
      id: "EXEC-old",
      subjectDigest: review.subjectDigest,
      status: "failed" as const,
      exitCode: 1,
      verifierDigest: identity === "changed" ? "b".repeat(64) : "a".repeat(64),
    };
    reported.evidence = [before.id];
    const saved = await saveProductState(await setup.workspace.state(), record, {
      ...record.state,
      executions: [before, after],
    });
    if (!saved.ok) throw new Error(saved.error.message);
    const next = await nextAcrossInterfaces(await setup.workspace.state(), { task: "T001" });
    expect(next).toMatchObject({
      ok: true,
      value: { action: identity === "same" ? "refine" : "fix", completion: "unresolved-product" },
    });
  },
);

it("routes a qualified environment change to explicit assessment without claiming repair", async () => {
  await arrange({ currentRun: "completed", invalidWitness: "changed-environment" });
  const next = await nextAcrossInterfaces(await setup.workspace.state(), { task: "T001" });
  expect(next).toMatchObject({
    ok: true,
    value: {
      action: "refine",
      objective: expect.stringContaining("Assess the observed environment change"),
      completion: "unresolved-product",
    },
  });
  const record = await readProductRecord(await setup.workspace.state(), { task: "T001" });
  if (!record.ok) throw new Error(record.error.message);
  expect(outstandingFeedback(record.value)).toHaveLength(1);
});

it.each([false, true])(
  "routes a witnessed repair among mixed citations (environment change: %s)",
  async (changedEnvironment) => {
    await arrange({
      currentRun: "completed",
      ...(changedEnvironment ? { invalidWitness: "changed-environment" as const } : {}),
    });
    const loaded = await readProductRecord(await setup.workspace.state(), { task: "T001" });
    if (!loaded.ok) throw new Error(loaded.error.message);
    const record = loaded.value;
    const original = record.state.captureRuns[0];
    const finding = record.state.reviews[0]?.feedback?.findings[0];
    if (!original || !finding) throw new Error("Missing fixture");
    const otherJourney = {
      ...journey,
      actions: [{ kind: "click" as const, selector: "#reset", capture: false }],
    };
    record.state.captureRuns.unshift({
      ...original,
      id: "RUN-context",
      status: "completed",
      failure: undefined,
      journey: otherJourney,
      journeyDigest: hashValue(otherJourney),
      journeyKey: productJourneyKey(otherJourney, "T001"),
    });
    finding.evidence = ["RUN-context", "RUN-old"];
    const saved = await saveProductState(await setup.workspace.state(), record, record.state);
    if (!saved.ok) throw new Error(saved.error.message);
    const retained = outstandingFeedback(record)[0];
    if (!retained) throw new Error("Missing retained finding");
    expect(
      findFunctionalRepair(
        record,
        retained,
        ["RUN-current"],
        changedEnvironment ? { from: "browser-1", to: "browser-2" } : undefined,
      )?.recheckId,
    ).toBe("RUN-current");
    const next = await nextAcrossInterfaces(await setup.workspace.state(), { task: "T001" });
    expect(next).toMatchObject({
      ok: true,
      value: { action: "refine", completion: "unresolved-product" },
    });
    expect(next.ok && next.value.objective).toContain(
      changedEnvironment
        ? "Assess the observed environment change"
        : "Reassess the repaired product",
    );
    const after = await readProductRecord(await setup.workspace.state(), { task: "T001" });
    if (!after.ok) throw new Error(after.error.message);
    expect(outstandingFeedback(after.value)).toHaveLength(1);
  },
);

it.each([undefined, "shallow"] as const)(
  "directs a missing matching replay to the recorded input (current run: %s)",
  async (currentRun) => {
    await arrange({ currentRun });
    const workspace = await setup.workspace.state();
    const next = await nextAcrossInterfaces(workspace, { task: "T001" });
    expect(next).toMatchObject({
      ok: true,
      value: {
        action: "fix",
        command: expect.stringContaining("--replay-batch=RUN-old"),
        objective: expect.stringContaining("Replay the recorded input"),
        mayEdit: true,
        completion: "unresolved-product",
      },
    });
    const status = await runProductStatus(workspace, { task: "T001" });
    expect(status.ok && status.value.next.command).toBe(next.ok && next.value.command);
    const record = await readProductRecord(workspace, { task: "T001" });
    if (!record.ok) throw new Error(record.error.message);
    expect(outstandingFeedback(record.value)).toHaveLength(1);
  },
);

it("does not suggest replaying a retained journey with a changed payload", async () => {
  await arrange();
  const workspace = await setup.workspace.state();
  const loaded = await readProductRecord(workspace, { task: "T001" });
  if (!loaded.ok) throw new Error(loaded.error.message);
  const run = productCaptureRunSchema.parse(loaded.value.state.captureRuns[0]);
  loaded.value.state.captureRuns[0] = {
    ...run,
    journey: { ...journey, url: "http://127.0.0.1:3000/changed" },
  };
  const saved = await saveProductState(workspace, loaded.value, loaded.value.state);
  if (!saved.ok) throw new Error(saved.error.message);
  const next = await nextAcrossInterfaces(workspace, { task: "T001" });
  expect(next.ok && next.value.command).not.toContain("--replay=");
  expect(next.ok && next.value.action).not.toBe("complete");
});

it("keeps a current failed replay on inspection rather than repeating an old input", async () => {
  await arrange({ currentRun: "failed" });
  const next = await nextAcrossInterfaces(await setup.workspace.state(), { task: "T001" });
  expect(next).toMatchObject({
    ok: true,
    value: {
      action: "fix",
      command: expect.stringContaining("visp review --handoff"),
      completion: "unresolved-product",
    },
  });
});

it.each([true, false])(
  "routes a standalone browser environment failure to recovery (intact replay: %s)",
  async (intactReplay) => {
    await arrange();
    const workspace = await setup.workspace.state();
    const loaded = await readProductRecord(workspace, { task: "T001" });
    if (!loaded.ok) throw new Error(loaded.error.message);
    const record = loaded.value;
    const old = productCaptureRunSchema.parse(record.state.captureRuns[0]);
    const current = record.state.executions[0];
    if (!current) throw new Error("Missing current execution");
    const environmentRun = {
      ...old,
      id: "RUN-environment",
      subjectDigest: current.subjectDigest,
      status: "failed",
      failure: { kind: "environment", message: "Browser disconnected during capture" },
      ...(intactReplay ? {} : { journeyDigest: "not-the-recorded-journey" }),
    };
    const saved = await saveProductState(workspace, record, {
      ...record.state,
      captureRuns: [environmentRun],
      reviews: [],
    });
    if (!saved.ok) throw new Error(saved.error.message);

    const next = await nextAcrossInterfaces(workspace, { task: "T001" });
    expect(next).toMatchObject({
      ok: true,
      value: {
        action: "understand",
        command: expect.stringContaining("visp capture --feature"),
        completion: "unresolved-environment",
        mayEdit: false,
      },
    });
    expect(next.ok && next.value.command).toContain(
      intactReplay ? "--replay=RUN-environment" : "--from -",
    );
    // A browser that closed mid-capture gets its own recovery: rerun once, then treat as a crash.
    expect(next.ok && next.value.objective).toContain("browser-disconnected:");
    expect(next.ok && next.value.objective).toContain("Rerun the same journey once");
    expect(next.ok && next.value.evidence.join("\n")).toContain("Browser disconnected");
    if (!intactReplay)
      expect(next.ok && next.value.evidence.join("\n")).toContain("No intact saved replay");
    const done = await runProductDone(await setup.workspace.state(), { task: "T001" });
    expect(done).toMatchObject({
      ok: true,
      value: {
        closed: false,
        gaps: expect.arrayContaining([expect.stringContaining("Browser disconnected")]),
      },
    });
  },
);

it.each([true, false])(
  "routes a later standalone browser environment failure after slice closure to replay (scoped: %s)",
  async (scoped) => {
    await arrange();
    const workspace = await setup.workspace.state();
    const loaded = await readProductRecord(workspace, { task: "T001" });
    if (!loaded.ok) throw new Error(loaded.error.message);
    const record = loaded.value;
    const old = productCaptureRunSchema.parse(record.state.captureRuns[0]);
    const current = record.state.executions[0];
    const slice = record.brief.slices[0];
    if (!current || !slice || !old.journey) throw new Error("Missing fixture identity");
    const task = scoped ? slice.id : undefined;
    const saved = await saveProductState(workspace, record, {
      ...record.state,
      slices: {
        ...record.state.slices,
        [slice.id]: {
          status: "closed",
          contractDigest: productContractDigest(record.brief, slice),
        },
      },
      captureRuns: [
        {
          ...old,
          id: "RUN-after-close",
          task,
          subjectDigest: current.subjectDigest,
          contractDigest: productContractDigest(record.brief, scoped ? slice : undefined),
          journeyKey: productJourneyKey(old.journey, task),
          status: "failed",
          failure: { kind: "environment", message: "Browser disconnected after closure" },
        },
      ],
      reviews: [],
    });
    if (!saved.ok) throw new Error(saved.error.message);

    const next = await nextAcrossInterfaces(workspace);
    expect(next).toMatchObject({
      ok: true,
      value: {
        action: "understand",
        command: expect.stringContaining("--replay=RUN-after-close"),
        completion: "unresolved-environment",
        mayEdit: false,
      },
    });
    if (scoped) expect(next.ok && next.value.command).toContain("--task T001");
    else expect(next.ok && next.value.command).not.toContain("--task");
    const accepted = await runProductAccept(await setup.workspace.state());
    expect(accepted).toMatchObject({
      ok: true,
      value: {
        passed: false,
        gaps: expect.arrayContaining([
          expect.stringContaining("Browser disconnected after closure"),
        ]),
      },
    });
  },
);

it("rejects a review resolution citing a pass superseded by a later matching browser failure", async () => {
  await arrange({ currentRun: "completed" });
  const workspace = await setup.workspace.state();
  const loaded = await readProductRecord(workspace, { task: "T001" });
  if (!loaded.ok) throw new Error(loaded.error.message);
  const record = loaded.value;
  const pass = productCaptureRunSchema.parse(record.state.captureRuns[1]);
  const finding = outstandingFeedback(record)[0];
  if (!finding) throw new Error("Missing retained finding");
  record.state.captureRuns[1] = {
    ...pass,
    operations: [{ id: "OP-passed", kind: "pointer", description: "Click Add" }],
  };
  record.state.captureRuns.push({
    ...pass,
    id: "RUN-later-failed",
    status: "timed-out",
    failure: { kind: "behavior", message: "Add failed again" },
    operations: [{ id: "OP-later", kind: "pointer", description: "Click Add again" }],
  });
  const saved = await saveProductState(workspace, record, record.state);
  if (!saved.ok) throw new Error(saved.error.message);
  const reviewed = await runProductReview(workspace, {
    task: "T001",
    subjectDigest: pass.subjectDigest,
    assessments: [],
    reviewer: { context: "current" },
    feedback: {
      phase: "product",
      dimensions: [],
      findings: [],
      resolutions: [
        {
          id: finding.id,
          explanation: "The earlier replay passed",
          evidence: ["OP-passed"],
          regression: {
            kind: "not-applicable",
            explanation: "The complete behavior is covered by this single interaction",
          },
        },
      ],
    },
  });
  expect(reviewed.ok).toBe(true);
  if (reviewed.ok)
    expect(reviewed.value.evidence.find((entry) => entry.id === "OP-passed")).toMatchObject({
      status: "available",
    });
  const after = await readProductRecord(workspace, { task: "T001" });
  if (!after.ok) throw new Error(after.error.message);
  expect(after.value.state.reviews.at(-1)?.feedback?.resolutions).toEqual([]);
  expect(outstandingFeedback(after.value)).toHaveLength(1);
});

it.each([undefined, "completed", "failed", "shallow"] as const)(
  "keeps closure blocked until assessment (current run: %s)",
  async (currentRun) => {
    await arrange({ currentRun });
    const next = await nextAcrossInterfaces(await setup.workspace.state(), { task: "T001" });
    expect(next.value.action).toBe(currentRun === "completed" ? "refine" : "fix");
    const done = await runJson<{ passed: boolean; gaps: string[] }>(
      setup.workspace.root,
      "done",
      "--task",
      "T001",
    );
    expect(done.envelope.ok).toBe(true);
    expect(done.envelope.data?.passed).toBe(false);
    expect(done.envelope.data?.gaps.join("\n")).toContain("Repeated Add presses do not increment");
    const record = await readProductRecord(await setup.workspace.state(), { task: "T001" });
    if (!record.ok) throw new Error(record.error.message);
    expect(outstandingFeedback(record.value)).toHaveLength(1);
    expect(closedSlice(record.value.state.slices.T001?.status)).toBe(false);
  },
);

it.each([false, true])(
  "asks for executable evidence without a replay target (other execution: %s)",
  async (hasExecution) => {
    await arrange();
    const workspace = await setup.workspace.state();
    const loaded = await readProductRecord(workspace, { task: "T001" });
    if (!loaded.ok) throw new Error(loaded.error.message);
    const saved = await saveProductState(workspace, loaded.value, {
      ...loaded.value.state,
      captureRuns: [],
      executions: hasExecution ? loaded.value.state.executions : [],
    });
    if (!saved.ok) throw new Error(saved.error.message);
    const next = await nextAcrossInterfaces(workspace, { task: "T001" });
    expect(next.value).toMatchObject({
      action: "fix",
      objective: expect.stringContaining("Record a failing reproduction"),
      completion: "unresolved-product",
    });
    expect(next.value.evidence.join("\n")).toContain("executed counterevidence");
    const record = await readProductRecord(workspace, { task: "T001" });
    if (!record.ok) throw new Error(record.error.message);
    expect(outstandingFeedback(record.value)).toHaveLength(1);
  },
);

it.each([
  "stale-subject",
  "stale-contract",
  "wrong-slice",
  "duplicate",
  "malformed",
  "later-failure",
] as const)(
  "keeps unsafe replay evidence out of repair readiness and closure: %s",
  async (condition) => {
    await arrange({ currentRun: "completed" });
    const workspace = await setup.workspace.state();
    const loaded = await readProductRecord(workspace, { task: "T001" });
    if (!loaded.ok) throw new Error(loaded.error.message);
    const record = loaded.value;
    const replay = productCaptureRunSchema.parse(record.state.captureRuns[1]);
    const changes = {
      "stale-subject": { subjectDigest: "another-implementation" },
      "stale-contract": { contractDigest: "another-contract" },
      "wrong-slice": { task: "T002" },
      malformed: { journey: null },
      duplicate: {},
      "later-failure": {},
    };
    record.state.captureRuns[1] = { ...replay, ...changes[condition] };
    if (condition === "duplicate") record.state.captureRuns.push({ ...replay });
    if (condition === "later-failure")
      record.state.captureRuns.push({
        ...replay,
        id: "RUN-later-failure",
        status: "timed-out",
        failure: { kind: "behavior", message: "Add failed again after the earlier pass" },
      });
    const saved = await saveProductState(workspace, record, record.state);
    if (!saved.ok) throw new Error(saved.error.message);
    const next = await nextAcrossInterfaces(workspace, { task: "T001" });
    expect(next.value).toMatchObject({ action: "fix", completion: "unresolved-product" });
    expect(next.value.objective).not.toContain("Reassess the repaired product");
    const done = await runJson<{ passed: boolean; gaps: string[] }>(
      setup.workspace.root,
      "done",
      "--task",
      "T001",
    );
    expect(done.envelope.ok).toBe(true);
    expect(done.envelope.data?.passed).toBe(false);
    expect(done.envelope.data?.gaps.join("\n")).toContain("Repeated Add presses do not increment");
    const after = await readProductRecord(workspace, { task: "T001" });
    if (!after.ok) throw new Error(after.error.message);
    expect(outstandingFeedback(after.value)).toHaveLength(1);
    expect(closedSlice(after.value.state.slices.T001?.status)).toBe(false);
  },
);

it("carries the keep-the-normal-call-passing line on the reviewer-finding fix step", async () => {
  await arrange();
  const workspace = await setup.workspace.state();
  const loaded = await readProductRecord(workspace, { task: "T001" });
  if (!loaded.ok) throw new Error(loaded.error.message);
  const saved = await saveProductState(workspace, loaded.value, {
    ...loaded.value.state,
    captureRuns: [],
  });
  if (!saved.ok) throw new Error(saved.error.message);
  const config = parse(await readFile(join(setup.workspace.root, "visp.yml"), "utf8"));
  config.critic = { ...config.critic, harness: "codex", launch: "codex-exec", mode: "auto" };
  await setup.workspace.write("visp.yml", stringify(config));
  const next = await nextAcrossInterfaces(await setup.workspace.state(), { task: "T001" });
  expect(next.value.action).toBe("fix");
  expect(next.value.objective).toContain("the independent reviewer re-checks these findings");
  expect(next.value.objective).toContain(
    "first add a test that the request's normal call still succeeds",
  );
  expect(next.value.objective).toContain("do not apply it; say so in your done note");
});

/** VISP launches the reviewer: routes point at `visp done`, never at a review the worker runs. */
async function launched() {
  const raw = parse(await readFile(join(setup.workspace.root, "visp.yml"), "utf8"));
  raw.critic = { ...raw.critic, harness: "codex", mode: "auto", launch: "codex-exec" };
  await setup.workspace.write("visp.yml", stringify(raw));
  setup.workspace.commit("VISP launches the reviewer");
}

it("routes a successful recheck to visp done when VISP launches the reviewer", async () => {
  await launched();
  await arrange({ currentRun: "completed" });
  const next = await nextAcrossInterfaces(await setup.workspace.state(), { task: "T001" });
  expect(next).toMatchObject({
    ok: true,
    value: {
      action: "refine",
      command: expect.stringMatching(/^visp done --feature \S+ --task T001$/),
      mayEdit: true,
      completion: "unresolved-product",
      objective: expect.stringContaining("VISP's independent reviewer reassesses the repaired"),
    },
  });
  expect(next.ok && next.value.evidence.join("\n")).toContain("adjacent regression check");
  const record = await readProductRecord(await setup.workspace.state(), { task: "T001" });
  if (!record.ok) throw new Error(record.error.message);
  expect(outstandingFeedback(record.value)).toHaveLength(1);
});

it("keeps the worker on repair after a failed journey and says VISP starts the reviewer", async () => {
  await launched();
  await arrange({ currentRun: "failed" });
  const next = await nextAcrossInterfaces(await setup.workspace.state(), { task: "T001" });
  expect(next).toMatchObject({
    ok: true,
    value: {
      action: "fix",
      command: expect.stringMatching(/^visp work --feature \S+ --task T001$/),
      completion: "unresolved-product",
      mayEdit: true,
      objective: expect.stringContaining("Then run visp done; VISP starts the reviewer."),
    },
  });
  expect(next.ok && next.value.command).not.toContain("review");
});

it("tells the worker to delegate nothing while findings are repaired", async () => {
  await launched();
  await arrange({ currentRun: "completed", findingSubject: "current" });
  const next = await nextAcrossInterfaces(await setup.workspace.state(), { task: "T001" });
  expect(next).toMatchObject({
    ok: true,
    value: { action: "fix", completion: "unresolved-product", mayEdit: true },
  });
  const objective = next.ok ? next.value.objective : "";
  expect(objective).toContain(
    "then run visp done. VISP starts the reviewer itself and you delegate nothing",
  );
  expect(objective).toContain("If a fix rejects inputs");
});

it("hands a successful recheck to the human reviewer when VISP's reviewer has no calls left", async () => {
  await launched();
  await arrange({ currentRun: "completed" });
  const ledger = join(
    setup.workspace.root,
    ".visp/features",
    setup.brief.feature,
    "critic-budget.json",
  );
  await writeFile(
    ledger,
    JSON.stringify({
      version: 1,
      root: hashValue(setup.workspace.root),
      feature: setup.brief.feature,
      maxCalls: 1,
      maxReservedMs: 1_080_000,
      entries: [{ key: "spent", phase: "product", reservedMs: 5000 }],
    }),
  );
  const next = await nextAcrossInterfaces(await setup.workspace.state(), { task: "T001" });
  expect(next).toMatchObject({
    ok: true,
    value: {
      action: "fix",
      completion: "handoff",
      objective: expect.stringContaining("review budget is spent"),
    },
  });
  // Handoff is disclosure: the finding stays outstanding.
  const record = await readProductRecord(await setup.workspace.state(), { task: "T001" });
  if (!record.ok) throw new Error(record.error.message);
  expect(outstandingFeedback(record.value)).toHaveLength(1);
});

it("stops promising VISP's reviewer after a failed journey when it cannot run again", async () => {
  await launched();
  await arrange({ currentRun: "failed" });
  const ledger = join(
    setup.workspace.root,
    ".visp/features",
    setup.brief.feature,
    "critic-budget.json",
  );
  await writeFile(
    ledger,
    JSON.stringify({
      version: 1,
      root: hashValue(setup.workspace.root),
      feature: setup.brief.feature,
      maxCalls: 1,
      maxReservedMs: 1_080_000,
      entries: [{ key: "spent", phase: "product", reservedMs: 5000 }],
    }),
  );
  const next = await nextAcrossInterfaces(await setup.workspace.state(), { task: "T001" });
  expect(next).toMatchObject({
    ok: true,
    value: { action: "fix", command: expect.stringContaining("visp work") },
  });
  const objective = next.ok ? next.value.objective : "";
  expect(objective).toContain("Then run visp done.");
  expect(objective).not.toContain("VISP starts the reviewer");
});

it("keeps the counterevidence-review advice out of a launched worker's journey feedback", async () => {
  await arrange({ currentRun: "failed" });
  const loaded = await readProductRecord(await setup.workspace.state(), { task: "T001" });
  if (!loaded.ok) throw new Error(loaded.error.message);
  const subject = await productSourceDigest(await setup.workspace.state(), loaded.value.brief);
  if (!subject.ok) throw new Error(subject.error.message);
  const recovery = (launchedRun: boolean) =>
    currentJourneyFeedback(loaded.value, subject.value, "T001", launchedRun).runs.map(
      (run) => run.recovery,
    );
  expect(recovery(false).join("\n")).toContain("review");
  expect(recovery(false).join("\n")).toContain("--prepare");
  const text = recovery(true).join("\n");
  expect(text).not.toContain("--prepare");
  expect(text).not.toContain("counterevidence");
  expect(text).toContain("execute that control and observe the actual result");
});
