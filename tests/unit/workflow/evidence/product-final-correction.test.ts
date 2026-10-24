import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { hashValue } from "../../../../src/core/hash.js";
import type { Result } from "../../../../src/core/result.js";
import { applicableExecutions } from "../../../../src/workflow/product/assessment.js";
import { buildProductContext } from "../../../../src/workflow/product/context.js";
import {
  correctionChecks,
  correctionReasons,
  currentProductFailures,
  failedCheckOwners,
  reviewCorrectionOutcomes,
} from "../../../../src/workflow/product/corrections.js";
import { productFeedbackPlan } from "../../../../src/workflow/product/feedback.js";
import {
  runProductAccept,
  runProductDone,
  runProductNext,
  runProductReview,
  runProductVerify,
  runProductWork,
  updateProductBrief,
} from "../../../../src/workflow/product/index.js";
import type { ProductBrief, ProductCheck } from "../../../../src/workflow/product/model.js";
import { productRefinement } from "../../../../src/workflow/product/refinement.js";
import { checkProductScope } from "../../../../src/workflow/product/scopes.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import {
  productContractDigest,
  productSourceSnapshot,
} from "../../../../src/workflow/product/subject.js";
import type { WorkspaceState } from "../../../../src/workflow/state.js";
import { moduleFeedback } from "../../support/product-feedback.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace | undefined;
afterEach(async () => {
  if (workspace) await rm(`${workspace.root}.final-check-fails`, { force: true });
  await workspace?.destroy();
});
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
function required<T>(entry: T | undefined): T {
  if (entry === undefined) throw new Error("Expected fixture value");
  return entry;
}
async function closedProduct(checkOptions: Partial<ProductCheck> = {}) {
  const fixture = await productWorkspace();
  workspace = fixture.workspace;
  const brief = value(
    await updateProductBrief(await workspace.state(), {
      brief: {
        ...fixture.brief,
        outcomes: [
          ...fixture.brief.outcomes,
          {
            id: "O002",
            kind: "quality",
            priority: "should",
            statement: "Explain the exported value",
          },
        ],
        checks: [
          ...fixture.brief.checks,
          {
            id: "C002",
            command: [
              process.execPath,
              "-e",
              "import('./src/value.mjs').then(m=>require('node:assert/strict').equal(m.ready,true,'assembled product must be ready'))",
            ],
            outcomes: ["O001"],
            files: ["src/value.mjs"],
            environment: "node",
            ...checkOptions,
          },
        ],
        slices: [
          ...fixture.brief.slices,
          {
            id: "T002",
            goal: "Explain the value",
            outcomes: ["O002"],
            scope: { allowed: ["README.md"] },
            checks: [],
          },
        ],
      },
      reason: "Check assembled readiness after the independently usable slices",
    }),
  );
  value(await runProductWork(await workspace.state(), { task: "T001" }));
  await workspace.write("src/value.mjs", "export const value = 2;\n");
  expect(value(await runProductDone(await workspace.state(), { task: "T001" })).closed).toBe(true);
  value(await runProductWork(await workspace.state(), { task: "T002" }));
  expect(value(await runProductDone(await workspace.state(), { task: "T002" })).closed).toBe(true);
  const review = value(await runProductReview(await workspace.state()));
  value(
    await runProductReview(await workspace.state(), {
      subjectDigest: review.subjectDigest,
      feedback: moduleFeedback(review),
      assessments: [
        {
          outcome: "O001",
          status: "satisfied",
          summary: "The public value is two; its executable assertion passes",
          evidence: ["C001"],
        },
      ],
    }),
  );
  return { workspace, brief };
}

describe("final executable correction", () => {
  it("routes an unassessed mandatory docs outcome to review without inventing a check", async () => {
    const fixture = await productWorkspace();
    workspace = fixture.workspace;
    value(
      await updateProductBrief(await workspace.state(), {
        brief: {
          ...fixture.brief,
          outcomes: [
            ...fixture.brief.outcomes,
            {
              id: "O002",
              kind: "quality",
              priority: "must",
              statement: "The public README explains the API for a new user",
            },
          ],
          slices: [
            ...fixture.brief.slices,
            {
              id: "T002",
              goal: "Explain the public API",
              outcomes: ["O001", "O002"],
              scope: { allowed: ["README.md"] },
              checks: [],
            },
            {
              id: "T003",
              goal: "Keep the API documentation self-contained",
              outcomes: ["O002"],
              scope: { allowed: ["README.md"] },
              checks: [],
            },
          ],
        },
        reason: "Add the documentation slice without an executable check",
      }),
    );
    value(await runProductWork(await workspace.state(), { task: "T001" }));
    await workspace.write("src/value.mjs", "export const value = 2;\n");
    expect(value(await runProductVerify(await workspace.state(), { task: "T001" })).passed).toBe(
      true,
    );
    value(await runProductWork(await workspace.state(), { task: "T002" }));

    const next = value(await runProductNext(await workspace.state(), { task: "T002" }));
    expect(next).toMatchObject({
      action: "refine",
      task: "T002",
      command: expect.stringContaining("visp review --handoff"),
      mayEdit: true,
      completion: "unresolved-product",
    });
    expect(next.evidence.join()).toContain("O002");
    expect(next.evidence.join()).not.toContain("C001");

    value(await runProductWork(await workspace.state(), { task: "T003" }));
    expect(value(await runProductNext(await workspace.state(), { task: "T003" }))).toMatchObject({
      action: "refine",
      task: "T003",
      command: expect.stringContaining("visp review --handoff"),
    });
  });

  /** A launched project at T002: an unassessed mandatory documentation outcome, no mapped check. */
  async function launchedDocs(cycles?: number) {
    const fixture = await productWorkspace();
    workspace = fixture.workspace;
    const raw = parse(await readFile(join(workspace.root, "visp.yml"), "utf8"));
    raw.critic = { ...raw.critic, harness: "codex", mode: "auto", launch: "codex-exec" };
    await workspace.write("visp.yml", stringify(raw));
    workspace.commit("VISP launches the reviewer");
    value(
      await updateProductBrief(await workspace.state(), {
        brief: {
          ...fixture.brief,
          ...(cycles === undefined
            ? {}
            : { design: { description: "Plain", references: [], refinementCycles: cycles } }),
          outcomes: [
            ...fixture.brief.outcomes,
            {
              id: "O002",
              kind: "quality",
              priority: "must",
              statement: "The public README explains the API for a new user",
            },
          ],
          slices: [
            ...fixture.brief.slices,
            {
              id: "T002",
              goal: "Explain the public API",
              outcomes: ["O001", "O002"],
              scope: { allowed: ["README.md"] },
              checks: [],
            },
            {
              id: "T003",
              goal: "Keep the API documentation self-contained",
              outcomes: ["O002"],
              scope: { allowed: ["README.md"] },
              checks: [],
            },
          ],
        },
        reason: "Add the documentation slice without an executable check",
      }),
    );
    value(await runProductWork(await workspace.state(), { task: "T001" }));
    await workspace.write("src/value.mjs", "export const value = 2;\n");
    value(await runProductVerify(await workspace.state(), { task: "T001" }));
    value(await runProductWork(await workspace.state(), { task: "T002" }));
    return { ...fixture, workspace };
  }

  it("routes an unassessed mandatory outcome to visp done when VISP launches the reviewer", async () => {
    const { workspace: launched } = await launchedDocs();
    const next = value(await runProductNext(await launched.state(), { task: "T002" }));
    expect(next).toMatchObject({
      action: "refine",
      task: "T002",
      command: expect.stringMatching(/^visp done --feature \S+ --task T002$/),
      objective: "Run visp done: VISP's independent reviewer assesses this slice's outcomes.",
      mayEdit: true,
      completion: "unresolved-product",
    });
    expect(next.command).not.toContain("review");
    expect(next.evidence.join()).toContain("O002");
  });

  it("still routes a launched worker to visp done, never to a review handoff, when refinement is exhausted", async () => {
    const { workspace: launched } = await launchedDocs(0);
    const next = value(await runProductNext(await launched.state(), { task: "T002" }));
    expect(next).toMatchObject({
      action: "understand",
      task: "T002",
      command: expect.stringMatching(/^visp done --feature \S+ --task T002$/),
      objective: expect.stringContaining("Refinement budget exhausted"),
      mayEdit: false,
    });
    expect(next.command).not.toContain("review");
  });

  it("hands the slice's assessment to the human reviewer when VISP's reviewer has no calls left", async () => {
    const fixture = await launchedDocs();
    const { workspace: launched } = fixture;
    await writeFile(
      join(launched.root, ".visp/features", fixture.brief.feature, "critic-budget.json"),
      JSON.stringify({
        version: 1,
        root: hashValue(launched.root),
        feature: fixture.brief.feature,
        maxCalls: 1,
        maxReservedMs: 1_080_000,
        entries: [{ key: "spent", phase: "product", reservedMs: 5000 }],
      }),
    );
    const next = value(await runProductNext(await launched.state(), { task: "T002" }));
    expect(next).toMatchObject({
      action: "fix",
      completion: "handoff",
      objective: expect.stringContaining("remaining assessment"),
    });
  });

  it("keeps a mandatory quality outcome with a passing mapped check on the done path", async () => {
    const fixture = await productWorkspace();
    workspace = fixture.workspace;
    value(
      await updateProductBrief(await workspace.state(), {
        brief: {
          ...fixture.brief,
          outcomes: [
            ...fixture.brief.outcomes,
            {
              id: "O002",
              kind: "quality",
              priority: "must",
              statement: "The public README explains the API for a new user",
            },
          ],
          checks: [
            ...fixture.brief.checks,
            {
              id: "C002",
              command: [process.execPath, "-e", "process.exit(0)"],
              outcomes: ["O002"],
              files: ["README.md"],
              environment: "node",
            },
          ],
          slices: [
            ...fixture.brief.slices,
            {
              id: "T002",
              goal: "Explain the public API",
              outcomes: ["O002"],
              scope: { allowed: ["README.md"] },
              checks: ["C002"],
            },
          ],
        },
        reason: "Add a documentation check with explicit outcome ownership",
      }),
    );
    value(await runProductWork(await workspace.state(), { task: "T002" }));
    expect(value(await runProductVerify(await workspace.state(), { task: "T002" })).passed).toBe(
      true,
    );

    expect(value(await runProductNext(await workspace.state(), { task: "T002" }))).toMatchObject({
      action: "implement",
      task: "T002",
      command: expect.stringContaining("visp done"),
      mayEdit: true,
    });
  });

  it("does not send an independent open slice into another slice's failing check loop", async () => {
    const fixture = await productWorkspace();
    workspace = fixture.workspace;
    value(
      await updateProductBrief(await workspace.state(), {
        brief: {
          ...fixture.brief,
          checks: [
            ...fixture.brief.checks,
            {
              id: "C002",
              command: [process.execPath, "-e", "process.exit(0)"],
              outcomes: ["O002"],
              environment: "node",
            },
          ],
          outcomes: [
            ...fixture.brief.outcomes,
            {
              id: "O002",
              kind: "functional",
              statement: "The independent operation exits successfully",
            },
          ],
          slices: [
            ...fixture.brief.slices,
            {
              id: "T002",
              goal: "Independent operation",
              outcomes: ["O002"],
              checks: ["C002"],
              scope: { allowed: ["README.md"] },
            },
          ],
        },
        reason: "Plan an independent second operation",
      }),
    );
    value(await runProductWork(await workspace.state(), { task: "T001" }));
    expect(value(await runProductVerify(await workspace.state(), { task: "T001" })).passed).toBe(
      false,
    );
    value(await runProductWork(await workspace.state(), { task: "T002" }));
    expect(value(await runProductVerify(await workspace.state(), { task: "T002" })).passed).toBe(
      true,
    );
    const next = value(await runProductNext(await workspace.state(), { task: "T002" }));
    expect(next).toMatchObject({
      action: "implement",
      task: "T002",
      command: expect.stringContaining("visp done"),
      mayEdit: true,
    });
    expect(next.evidence.join()).not.toContain("C001");
    value(await runProductWork(await workspace.state(), { task: "T001" }));
    expect(value(await runProductNext(await workspace.state(), { task: "T001" }))).toMatchObject({
      action: "fix",
      task: "T001",
      command: expect.stringContaining("visp work"),
    });
    const state = await workspace.state();
    const configured: WorkspaceState = {
      ...state,
      config: {
        ...state.config,
        workflow: {
          ...state.config.workflow,
          validationCommands: [[process.execPath, "-e", "process.exit(1)"]],
        },
      },
    };
    value(await runProductWork(configured, { task: "T002" }));
    expect(value(await runProductVerify(configured, { task: "T002" })).passed).toBe(false);
    const configFailure = value(await runProductNext(configured, { task: "T002" }));
    expect(configFailure).toMatchObject({ action: "fix", task: "T002" });
    expect(configFailure.evidence.join()).toContain("CONFIG_1");
  });

  it("reopens only the implicated closed slice after actual assembled checks contradict a satisfied review", async () => {
    const { workspace } = await closedProduct();
    const failed = value(await runProductAccept(await workspace.state()));
    expect(failed.passed).toBe(false);
    expect(failed.executions).toContainEqual(
      expect.objectContaining({ check: "C002", status: "failed" }),
    );
    const before = value(await readProductRecord(await workspace.state()));
    const next = value(await runProductNext(await workspace.state()));
    expect(next).toMatchObject({ action: "fix", task: "T001", mayEdit: false });
    expect(next.evidence.join()).toContain("C002");
    expect(await runProductWork(await workspace.state(), { task: "T002" })).toMatchObject({
      ok: false,
      error: { code: "STAGE_BLOCKED" },
    });
    const work = value(await runProductWork(await workspace.state(), { task: "T001" }));
    expect(work.scope.allowed).toEqual(["src/value.mjs", "test/value.test.mjs"]);
    expect(work.feedback).toContainEqual(
      expect.objectContaining({ check: "C002", status: "failed", current: true }),
    );
    const reopened = value(await readProductRecord(await workspace.state()));
    expect(reopened.state.slices.T001?.status).toBe("in-progress");
    expect(reopened.state.slices.T002?.status).toBe("closed");
    expect(reopened.state.executions).toEqual(before.state.executions);
    expect(reopened.state.reviews).toEqual(before.state.reviews);
    expect(reopened.state.sliceHistory.at(-1)).toMatchObject({
      task: "T001",
      from: "closed",
      to: "in-progress",
    });
    expect(reopened.state.sliceHistory.at(-1)?.reason).toContain("C002");
    expect(work.checks.map((check) => check.id)).toEqual(["C001", "C002"]);
    expect(productRefinement(reopened)).toEqual(productRefinement(before));

    const stillFailed = value(await runProductDone(await workspace.state(), { task: "T001" }));
    expect(stillFailed).toMatchObject({ closed: false, passed: false });
    expect(stillFailed.executions).toContainEqual(
      expect.objectContaining({ check: "C002", status: "failed" }),
    );
    await workspace.write("README.md", "An unrelated correction is outside this authorization\n");
    expect(
      await checkProductScope(
        await workspace.state(),
        reopened,
        required(reopened.brief.slices[0]),
      ),
    ).toMatchObject({ ok: false, error: { code: "SCOPE_VIOLATION" } });
    // Restore the absent out-of-scope file before the legitimate source correction.
    await rm(`${workspace.root}/README.md`);
    await workspace.write("src/value.mjs", "export const value = 2; export const ready = true;\n");
    const corrected = value(await runProductDone(await workspace.state(), { task: "T001" }));
    expect(corrected.closed).toBe(true);
    expect(corrected.executions).toEqual([
      expect.objectContaining({
        check: "C001",
        status: "passed",
        subjectDigest: corrected.subjectDigest,
      }),
      expect.objectContaining({
        check: "C002",
        status: "passed",
        subjectDigest: corrected.subjectDigest,
      }),
    ]);
    expect(corrected.subjectDigest).not.toBe(failed.subjectDigest);
    const unassessed = value(await runProductAccept(await workspace.state()));
    expect(unassessed.passed).toBe(false);
    expect(unassessed.gaps.join()).toContain("assessment");
    const fresh = value(await runProductReview(await workspace.state()));
    value(
      await runProductReview(await workspace.state(), {
        subjectDigest: fresh.subjectDigest,
        feedback: moduleFeedback(fresh),
        assessments: [
          {
            outcome: "O001",
            status: "satisfied",
            summary: "The current public value and assembled readiness checks both pass",
            evidence: ["C001", "C002"],
          },
        ],
      }),
    );
    expect(value(await runProductAccept(await workspace.state())).passed).toBe(true);
    expect(value(await runProductNext(await workspace.state())).action).toBe("complete");

    const completed = value(await readProductRecord(await workspace.state()));
    const rerun = required(corrected.executions.find((entry) => entry.check === "C002"));
    expect(rerun.task).toBeUndefined();
    expect(rerun.contractDigest).toBe(productContractDigest(completed.brief));
    value(
      await updateProductBrief(await workspace.state(), {
        brief: {
          ...completed.brief,
          checks: completed.brief.checks.map((check) =>
            check.id === "C002"
              ? { ...check, command: [process.execPath, "-e", "process.exit(17)"] }
              : check,
          ),
        },
        reason: "Correct the assembled verifier independently of the original slice check",
      }),
    );
    const revised = value(await readProductRecord(await workspace.state()));
    expect(
      applicableExecutions(revised, corrected.subjectDigest).filter(
        (entry) => entry.check === "C002",
      ),
    ).toEqual([]);
    const revisedAcceptance = value(await runProductAccept(await workspace.state()));
    expect(revisedAcceptance).toMatchObject({ passed: false });
    expect(revisedAcceptance.executions).toContainEqual(
      expect.objectContaining({ check: "C002", status: "failed", exitCode: 17 }),
    );
  });

  it("requires a focused ownership decision for an executed check with no attributable outcome or path", async () => {
    const { workspace } = await closedProduct({ outcomes: [], files: [] });
    const failed = value(await runProductAccept(await workspace.state()));
    expect(failed.executions).toContainEqual(
      expect.objectContaining({ check: "C002", status: "failed" }),
    );
    const before = value(await readProductRecord(await workspace.state()));
    expect(value(await runProductNext(await workspace.state()))).toMatchObject({
      action: "understand",
      mayEdit: false,
    });
    expect(value(await runProductNext(await workspace.state())).objective).toContain(
      "focused correction scope",
    );
    for (const task of ["T001", "T002"])
      expect(await runProductWork(await workspace.state(), { task })).toMatchObject({
        ok: false,
        error: { code: "STAGE_BLOCKED" },
      });
    expect(value(await readProductRecord(await workspace.state())).state).toEqual(before.state);
  });

  it("uses a concrete owned input when an assembled check has no outcome association", async () => {
    const { workspace } = await closedProduct({ outcomes: [] });
    value(await runProductAccept(await workspace.state()));
    expect(value(await runProductNext(await workspace.state()))).toMatchObject({
      action: "fix",
      task: "T001",
    });
    expect(
      value(await runProductWork(await workspace.state(), { task: "T001" })).checks.map(
        (check) => check.id,
      ),
    ).toEqual(["C001", "C002"]);
  });

  it("does not reauthorize a closed slice from a stale failure", async () => {
    const { workspace } = await closedProduct();
    value(await runProductAccept(await workspace.state()));
    await workspace.write("src/value.mjs", "export const value = 2; export const ready = true;\n");
    expect(value(await runProductNext(await workspace.state())).action).toBe("refine");
    expect(await runProductWork(await workspace.state(), { task: "T001" })).toMatchObject({
      ok: false,
      error: { code: "STAGE_BLOCKED" },
    });
  });

  it("does not let executable failure reopening reset an exhausted review budget", async () => {
    const { workspace } = await closedProduct();
    for (let index = 0; index < 3; index++) {
      await workspace.write(
        "src/value.mjs",
        `export const value = 2; export const transition = ${index};\n`,
      );
      const review = value(await runProductReview(await workspace.state()));
      value(
        await runProductReview(await workspace.state(), {
          subjectDigest: review.subjectDigest,
          feedback: moduleFeedback(review),
          assessments: [
            {
              outcome: "O001",
              status: "failed",
              summary: "The assembled public behavior is still incomplete",
            },
          ],
        }),
      );
    }
    const review = value(await runProductReview(await workspace.state()));
    value(
      await runProductReview(await workspace.state(), {
        subjectDigest: review.subjectDigest,
        feedback: moduleFeedback(review),
        assessments: [
          {
            outcome: "O001",
            status: "satisfied",
            summary: "A reviewer now considers the value acceptable",
          },
        ],
      }),
    );
    value(await runProductAccept(await workspace.state()));
    const before = value(await readProductRecord(await workspace.state()));
    expect(productRefinement(before).exhausted).toBe(true);
    expect(value(await runProductNext(await workspace.state()))).toMatchObject({
      action: "fix",
      mayEdit: false,
    });
    expect(await runProductWork(await workspace.state(), { task: "T001" })).toMatchObject({
      ok: true,
      value: { mayEdit: true },
    });
    expect(productRefinement(value(await readProductRecord(await workspace.state())))).toEqual(
      productRefinement(before),
    );
  });

  it("ignores removed-task and revised-contract history when choosing additional commands", async () => {
    const { workspace } = await closedProduct();
    const failed = value(await runProductAccept(await workspace.state()));
    const record = value(await readProductRecord(await workspace.state()));
    const slice = required(record.brief.slices[0]);
    const execution = required(failed.executions.find((entry) => entry.check === "C002"));
    expect(correctionChecks(record, slice, "new-subject").map((check) => check.id)).toEqual([
      "C002",
    ]);
    for (const invalid of [
      { ...execution, task: "T999", contractDigest: productContractDigest(record.brief) },
      { ...execution, contractDigest: "superseded method contract" },
      { ...execution, status: "passed" as const },
      { ...execution, status: "environment-failed" as const },
    ]) {
      const historical = { ...record, state: { ...record.state, executions: [invalid] } };
      expect(correctionChecks(historical, slice, "new-subject")).toEqual([]);
    }
    const explicit = {
      ...record,
      brief: {
        ...record.brief,
        slices: record.brief.slices.map((entry) =>
          entry.id === "T002" ? { ...entry, checks: ["C002"] } : entry,
        ),
      },
    };
    expect(failedCheckOwners(explicit, execution).map((owner) => owner.id)).toEqual(["T002"]);
    expect(failedCheckOwners(record, { ...execution, check: "CONFIG_1" })).toEqual([]);
    expect(
      currentProductFailures(
        {
          ...record,
          state: { ...record.state, executions: [execution, { ...execution, status: "passed" }] },
        },
        failed.subjectDigest,
      ),
    ).toEqual([]);

    // A broad dependency pattern or forbidden concrete path cannot alone grant a write scope.
    for (const files of [["**/*.mjs"], ["secret.mjs"]]) {
      const noOwner = {
        ...record,
        brief: {
          ...record.brief,
          checks: record.brief.checks.map((check) =>
            check.id === "C002" ? { ...check, outcomes: [], files } : check,
          ),
          slices: record.brief.slices.map((entry) => ({
            ...entry,
            scope: { ...entry.scope, allowed: ["**"], forbidden: ["secret.mjs"] },
          })),
        },
      };
      expect(failedCheckOwners(noOwner, execution)).toEqual([]);
    }
  });

  it("keeps each named slice's shared-check failure and correction independent", async () => {
    const fixture = await productWorkspace();
    workspace = fixture.workspace;
    const first = required(fixture.brief.slices[0]);
    value(
      await updateProductBrief(await workspace.state(), {
        brief: {
          ...fixture.brief,
          slices: [...fixture.brief.slices, { ...first, id: "T002" }],
        },
        reason: "Both slices declare the same check",
      }),
    );
    value(await runProductWork(await workspace.state(), { task: "T001" }));
    value(await runProductVerify(await workspace.state(), { task: "T001" }));
    const record = value(await readProductRecord(await workspace.state()));
    const second = required(record.brief.slices.find((slice) => slice.id === "T002"));
    const failure = required(
      record.state.executions.findLast((entry) => entry.task === "T001" && entry.check === "C001"),
    );
    expect(failure.status).toBe("failed");
    const otherPass = {
      ...failure,
      id: "other-slice-pass",
      task: "T002",
      contractDigest: productContractDigest(record.brief, second),
      status: "passed" as const,
      exitCode: 0,
      output: "The other slice passed the shared check",
    };
    const crossed = {
      ...record,
      state: { ...record.state, executions: [failure, otherPass] },
    };
    expect(currentProductFailures(crossed, failure.subjectDigest)).toMatchObject([
      { task: "T001", status: "failed" },
    ]);
    expect(correctionReasons(crossed, first, failure.subjectDigest)).toContain("check C001");
    expect(correctionReasons(crossed, second, failure.subjectDigest)).not.toContain("check C001");
    expect(
      correctionChecks(crossed, first, failure.subjectDigest).map((check) => check.id),
    ).toEqual(["C001"]);
    expect(correctionChecks(crossed, second, failure.subjectDigest)).toEqual([]);
    const failedAssessment = {
      outcome: "O001",
      status: "failed" as const,
      provenance: "agent-reported" as const,
      summary: "T001's behavior still fails",
      evidence: [],
      expectations: [],
    };
    const failedReview = {
      task: "T001",
      subjectDigest: failure.subjectDigest,
      contractDigest: productContractDigest(record.brief, first),
      createdAt: new Date().toISOString(),
      assessments: [failedAssessment],
      captures: [],
    };
    const otherReview = {
      ...failedReview,
      task: "T002",
      contractDigest: productContractDigest(record.brief, second),
      assessments: [{ ...failedAssessment, status: "satisfied" as const }],
    };
    const reviewed = {
      ...record,
      state: { ...record.state, reviews: [failedReview, otherReview] },
    };
    expect(reviewCorrectionOutcomes(reviewed, first, failure.subjectDigest)).toEqual(["O001"]);
    expect(reviewCorrectionOutcomes(reviewed, second, failure.subjectDigest)).toEqual([]);
    expect(productFeedbackPlan(crossed, failure.subjectDigest, first).trace.question).toContain(
      "C001",
    );
    expect(
      productFeedbackPlan(crossed, failure.subjectDigest, second).trace.question,
    ).not.toContain("C001");
    const state = await workspace.state();
    const snapshot = value(await productSourceSnapshot(state, record.brief));
    const firstContext = value(
      await buildProductContext(state, crossed, first, snapshot, false, false),
    );
    const otherContext = value(
      await buildProductContext(state, crossed, second, snapshot, false, false),
    );
    expect(firstContext.feedback).toMatchObject([{ check: "C001", status: "failed" }]);
    expect(otherContext.feedback).toEqual([]);
  });

  it("withdraws completion when a later same-source configuration check fails", async () => {
    const { workspace } = await closedProduct({
      command: [process.execPath, "-e", "process.exit(0)"],
    });
    const state = await workspace.state();
    const failingInput = `${workspace.root}.final-check-fails`;
    const configured: WorkspaceState = {
      ...state,
      config: {
        ...state.config,
        workflow: {
          ...state.config.workflow,
          validationCommands: [
            [
              process.execPath,
              "-e",
              `process.exit(require('node:fs').existsSync(${JSON.stringify(failingInput)}) ? 1 : 0)`,
            ],
          ],
        },
      },
    };
    value(await runProductVerify(configured));
    const review = value(await runProductReview(configured));
    value(
      await runProductReview(configured, {
        subjectDigest: review.subjectDigest,
        feedback: moduleFeedback(review),
        assessments: [
          {
            outcome: "O001",
            status: "satisfied",
            summary: "The current public value is two",
            evidence: ["C001"],
          },
        ],
      }),
    );
    const accepted = value(await runProductAccept(configured));
    expect(accepted.passed).toBe(true);
    expect(value(await runProductNext(configured)).action).toBe("complete");
    await writeFile(failingInput, "fail next check\n");
    expect(value(await runProductVerify(configured)).passed).toBe(false);
    expect(value(await readProductRecord(configured)).state.status).toBe("accepted");
    expect(value(await runProductNext(configured))).toMatchObject({
      action: "understand",
      mayEdit: false,
    });
    const failed = value(await runProductAccept(configured));
    expect(failed.subjectDigest).toBe(accepted.subjectDigest);
    expect(failed.executions).toContainEqual(
      expect.objectContaining({ check: "CONFIG_1", status: "failed" }),
    );
    expect(failed.passed).toBe(false);
    const next = value(await runProductNext(configured));
    expect(next).toMatchObject({ action: "understand", mayEdit: false });
    expect(next.evidence.join()).toContain("CONFIG_1");
    expect(value(await readProductRecord(configured)).state).toMatchObject({ status: "active" });
    expect(value(await readProductRecord(configured)).state.acceptedSubject).toBeUndefined();
  });
});

it("attributes pinned failures through concrete permitted paths, else to the last slice, and preserves correction freshness", async () => {
  const setup = await closedProduct();
  const record = value(await readProductRecord(await setup.workspace.state()));
  const slice = required(record.brief.slices[0]);
  const brief: ProductBrief = {
    ...record.brief,
    acceptanceBaseline: [
      {
        command: [process.execPath, "test/pinned.mjs"],
        files: [{ path: "src/value.mjs", sha256: "a".repeat(64) }],
      },
    ],
  };
  const execution = {
    ...required(record.state.executions[0]),
    id: "pinned-failure",
    task: undefined,
    check: "PINNED_1",
    status: "failed" as const,
    exitCode: 1,
    contractDigest: productContractDigest(brief),
  };
  const pinned = { ...record, brief, state: { ...record.state, executions: [execution] } };
  expect(failedCheckOwners(pinned, execution).map((owner) => owner.id)).toEqual([slice.id]);
  expect(correctionChecks(pinned, slice, execution.subjectDigest)).toEqual([
    expect.objectContaining({
      id: "PINNED_1",
      command: brief.acceptanceBaseline[0]?.command,
      files: ["src/value.mjs"],
    }),
  ]);
  const unrelatedPass = {
    ...execution,
    subjectDigest: "other-subject",
    status: "passed" as const,
    exitCode: 0,
  };
  const restored = {
    ...pinned,
    state: { ...pinned.state, executions: [execution, unrelatedPass] },
  };
  expect(
    correctionChecks(restored, slice, execution.subjectDigest).map((check) => check.id),
  ).toEqual(["PINNED_1"]);
  expect(correctionChecks(restored, slice, "other-subject")).toEqual([]);
  expect(correctionChecks(restored, slice, "new-repair-subject").map((check) => check.id)).toEqual([
    "PINNED_1",
  ]);
  const repaired = {
    ...restored,
    state: {
      ...restored.state,
      executions: [
        ...restored.state.executions,
        { ...unrelatedPass, subjectDigest: execution.subjectDigest },
      ],
    },
  };
  expect(correctionChecks(repaired, slice, execution.subjectDigest)).toEqual([]);
  expect(failedCheckOwners(pinned, { ...execution, check: "PINNED_99" })).toEqual([]);
  const finalSlice = required(brief.slices.at(-1)).id;
  for (const path of ["**/*.mjs", "outside.mjs"]) {
    const unowned: typeof pinned = {
      ...pinned,
      brief: {
        ...brief,
        acceptanceBaseline: [
          { ...required(brief.acceptanceBaseline[0]), files: [{ path, sha256: "a".repeat(64) }] },
        ],
      },
    };
    // No slice claims it by path: the slice that completes the feature owns a pinned failure.
    expect(failedCheckOwners(unowned, execution).map((owner) => owner.id)).toEqual([finalSlice]);
  }
  const forbidden = {
    ...pinned,
    brief: {
      ...brief,
      slices: brief.slices.map((s) => ({
        ...s,
        scope: { ...s.scope, forbidden: ["src/value.mjs"] },
      })),
    },
  };
  expect(failedCheckOwners(forbidden, execution).map((owner) => owner.id)).toEqual([finalSlice]);
  expect(
    correctionChecks(
      {
        ...pinned,
        state: { ...pinned.state, executions: [{ ...execution, contractDigest: "old" }] },
      },
      slice,
      execution.subjectDigest,
    ),
  ).toEqual([]);
});
