import * as fileSystem from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { balancedCritic } from "../../../src/config/critic.js";
import { sha256 } from "../../../src/core/hash.js";
import {
  assignComparisons,
  type ComparisonObservation,
  type ComparisonSpec,
  prepareComparison,
  readPreparedComparison,
  summarizeComparison,
} from "../../../src/runner/comparison.js";
import { runnerSpecSchema } from "../../../src/runner/contracts.js";
import { prepareCriticComparison } from "../../../src/runner/critic-comparison.js";
import { buildRunnerProgram } from "../../../src/runner/main.js";
import { prepareReviewCalibration } from "../../../src/runner/review-calibration.js";
import { runExperiment } from "../../../src/runner/run.js";

vi.mock("../../../src/runner/run.js", () => ({ runExperiment: vi.fn(), inspectRun: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "visp-comparison-test-"));
  roots.push(root);
  const write = async (path: string, content: string) => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
    return join(root, path);
  };
  const manifest = await write(
    "legacy/manifest.json",
    JSON.stringify({
      createdAt: "2026-09-07T00:00:00Z",
      head: "a".repeat(40),
      status: " M src/app.ts\n?? src/new.ts\n",
      files: ["src/app.ts", "src/new.ts", "dist/main.js"].map((path) => ({
        path,
        sha256: sha256(path),
        bytes: path.length,
      })),
    }),
  );
  const archive = await write("legacy/source-and-build.tar.gz", "frozen original build");
  await write("replacement/src/app.ts", "export const implementation = 'replacement';");
  await write("replacement/dist/main.js", "actual replacement bundle");
  const instruction = await write(
    "instructions.md",
    "Use the selected tools. Custom skills are disabled.",
  );
  const executable = await write("host", "throw new Error('Do not launch this host');");
  const tasks: ComparisonSpec["tasks"] = [];
  for (const [index, cohort] of (
    ["existing-code-bug", "stateful-feature", "ui"] as const
  ).entries()) {
    await write(`task-${index}/start/app.js`, `starting code ${index}`);
    await write(
      `task-${index}/oracle/expectations.json`,
      `{"secretOracle":"independent-${index}"}`,
    );
    tasks.push({
      id: `task-${index}`,
      cohort,
      promptFile: await write(`task-${index}/prompt.md`, `Implement the public outcome ${index}.`),
      startDirectory: join(root, `task-${index}/start`),
      oracleDirectory: join(root, `task-${index}/oracle`),
    });
  }
  const spec: ComparisonSpec = {
    schemaVersion: 1,
    study: "quality-pilot",
    seed: "fixed-seed",
    model: { host: "codex", name: "gpt-5.6-luna", effort: "max" },
    tools: [{ name: "host", executable, version: "test-fixture" }],
    allowedTools: ["shell", "read", "write"],
    instructions: { common: [instruction], bare: [], "frozen-legacy": [], replacement: [] },
    environment: { locale: "en-US", timezone: "UTC" },
    customSkills: "disabled",
    legacy: { manifest, archive },
    replacement: { root: join(root, "replacement"), sourcePaths: ["src"], buildPath: "dist" },
    tasks,
  };
  return { root, spec, output: join(root, "prepared") };
}

describe("quality-first comparison preparation", () => {
  it("prepares staged feedback policy contrasts with fixed candidate code and no budget or model dispatch", async () => {
    const { spec, output } = await setup();
    const pins = await prepareComparison(spec, output);
    const reviewer = balancedCritic("codex");
    const prepared = await prepareCriticComparison(output, { study: "feedback-policy", reviewer });
    expect(prepared).toMatchObject({ runnable: false, budget: null, customSkills: "disabled" });
    expect(prepared.kind).toBe("prepared-feedback-policy-comparison");
    if (prepared.kind !== "prepared-feedback-policy-comparison" || !("stages" in prepared))
      throw new Error("Expected policy preparation");
    expect(prepared.assignments).toHaveLength(27);
    expect(new Set(prepared.assignments.map((entry) => entry.id)).size).toBe(27);
    expect(prepared.stages).toHaveLength(2);
    const [baseline, current, repair] = prepared.arms;
    expect(baseline?.bundle).toMatchObject({ archiveSha256: pins.legacy.archiveSha256 });
    expect(current?.bundle).toEqual(repair?.bundle);
    expect(repair?.critic).toEqual({ ...current?.critic, maxCalls: 3 });
    expect(current?.reviewMode).toBe("current");
    expect(repair?.reviewMode).toBe("current");
    expect(repair?.opportunities).toEqual(["understanding", "product", "focused-repair"]);
    expect(prepared.policy.calibration).toContain("repairRegressions");
    expect(prepared.policy.interpretation).toContain("pilot, not proof");
    expect(JSON.stringify(prepared)).not.toContain("secretOracle");
    expect(runExperiment).not.toHaveBeenCalled();
  });
  it("prepares a matched critic ablation without launching a model or exposing oracle contents", async () => {
    const { spec, output } = await setup();
    await prepareComparison(spec, output);
    const limits = {
      maxCalls: 3,

      timeoutMs: 30000,

      maxImageBytes: 4 * 1024 * 1024,
    };
    const config = {
      sameModel: { ...limits, model: spec.model.name },
      strongerModel: { ...limits, model: "study-critic-placeholder" },
    };
    const prepared = await prepareCriticComparison(output, config);
    expect(prepared).toMatchObject({ runnable: false, budget: null, customSkills: "disabled" });
    expect(prepared.assignments).toHaveLength(27);
    expect(new Set(prepared.assignments.map((a) => a.id)).size).toBe(27);
    expect(JSON.stringify(prepared)).not.toContain("secretOracle");
    expect(runExperiment).not.toHaveBeenCalled();
    await expect(prepareCriticComparison(output, config)).rejects.toThrow();
    await expect(
      prepareCriticComparison(output, {
        ...config,
        sameModel: { ...config.sameModel, model: "wrong-worker" },
      }),
    ).rejects.toThrow("match the pinned worker");
    await expect(
      prepareCriticComparison(output, { ...config, strongerModel: config.sameModel }),
    ).rejects.toThrow("different model");
    await expect(
      prepareCriticComparison(output, {
        ...config,
        strongerModel: { ...config.strongerModel, maxCalls: 1 },
      }),
    ).rejects.toThrow("limits must match");
  });
  it("assigns three repetitions of all three arms deterministically without depending on input order", () => {
    const first = assignComparisons("study", "seed", ["bug", "state", "ui"]);
    expect(first).toHaveLength(27);
    expect(new Set(first.map((row) => row.id)).size).toBe(27);
    expect(first).toEqual(assignComparisons("study", "seed", ["ui", "bug", "state"]));
    expect(first).not.toEqual(assignComparisons("study", "another-seed", ["bug", "state", "ui"]));
    for (const arm of ["bare", "frozen-legacy", "replacement"])
      expect(first.filter((row) => row.arm === arm)).toHaveLength(9);
  });

  it("pins the actual working-tree baseline and bundles, keeping oracle content out of implementation prompts", async () => {
    const { spec, output } = await setup();
    const prepared = await prepareComparison(spec, output);
    expect(prepared).toMatchObject({
      runnable: false,
      budget: null,
      customSkills: "disabled",
      status: "prepared-awaiting-budget",
    });
    expect(prepared.legacy.manifest.status).toContain("?? src/new.ts");
    expect(prepared.legacy.manifest.files.some((file) => file.path === "src/new.ts")).toBe(true);
    expect(prepared.legacy.archiveSha256).toBe(sha256("frozen original build"));
    expect(prepared.tasks.every((task) => !task.prompt.includes("secretOracle"))).toBe(true);
    expect(prepared.tasks.every((task) => task.start.sha256 !== task.oracle.sha256)).toBe(true);
    expect(runnerSpecSchema.safeParse(prepared).success).toBe(false);
    const bundle = prepared.replacement.build.files[0];
    if (!bundle) throw new Error("Expected pinned bundle");
    await writeFile(join(spec.replacement.root, "dist/main.js"), "later changed build");
    expect(await readFile(join(output, "objects", bundle.sha256), "utf8")).toBe(
      "actual replacement bundle",
    );
    expect(await readPreparedComparison(output)).toEqual(prepared);
    await expect(prepareComparison(spec, output)).rejects.toThrow("already exists");
  });

  it("uses the tool binary limit when reading prepared inputs without widening other object limits", async () => {
    const { spec, output } = await setup();
    const prepared = await prepareComparison(spec, output);
    const toolHash = prepared.tools[0]?.sha256;
    if (!toolHash) throw new Error("Expected pinned tool");
    const original = fileSystem.lstat;
    // The reader resolves the directory (macOS temporary paths sit under the /var symlink).
    const objects = join(await fileSystem.realpath(output), "objects");
    let oversized = join(objects, toolHash);
    let bytes = 300 * 1024 * 1024;
    vi.spyOn(fileSystem, "lstat").mockImplementation((async (
      path: Parameters<typeof original>[0],
    ) => {
      const actual = await original(path);
      if (path !== oversized) return actual;
      return Object.assign(Object.create(Object.getPrototypeOf(actual)), actual, { size: bytes });
    }) as typeof original);
    expect(await readPreparedComparison(output)).toEqual(prepared);
    bytes = 513 * 1024 * 1024;
    await expect(readPreparedComparison(output)).rejects.toThrow("object integrity");
    oversized = join(objects, prepared.legacy.archiveSha256);
    bytes = 300 * 1024 * 1024;
    await expect(readPreparedComparison(output)).rejects.toThrow("object integrity");
  });

  it("never dispatches a model from the preparation command", async () => {
    const { root, spec, output } = await setup();
    const input = join(root, "input.json");
    await writeFile(input, JSON.stringify(spec));
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await buildRunnerProgram().parseAsync([
      "node",
      "visp-runner",
      "prepare-comparison",
      "--spec",
      input,
      "--output",
      output,
    ]);
    expect(runExperiment).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalled();
    expect((await readPreparedComparison(output)).assignments).toHaveLength(27);
  });

  it("refuses modified pinned objects instead of treating a valid manifest as intact inputs", async () => {
    const { spec, output } = await setup();
    const prepared = await prepareComparison(spec, output);
    await writeFile(join(output, "objects", prepared.legacy.archiveSha256), "tampered original");
    await expect(readPreparedComparison(output)).rejects.toThrow("object integrity");
  });

  it("rejects an oracle inside the starting tree and leaves no completed comparison", async () => {
    const { spec, output } = await setup();
    spec.tasks[0] = {
      ...(spec.tasks[0] as ComparisonSpec["tasks"][number]),
      oracleDirectory: spec.tasks[0]?.startDirectory ?? "",
    };
    await expect(prepareComparison(spec, output)).rejects.toThrow("Held-out oracle");
    await expect(readPreparedComparison(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains missing assessments and failures instead of inferring quality from completion or cost", async () => {
    const { spec, output } = await setup();
    const prepared = await prepareComparison(spec, output);
    const assignment = prepared.assignments.find((row) => row.arm === "replacement");
    if (!assignment) throw new Error("Expected assignment");
    const row: ComparisonObservation = {
      assignmentId: assignment.id,
      status: "failed",
      assessment: null,
      quality: {
        correctness: null,
        briefFidelity: null,
        usability: null,
        visualQuality: null,
        severeDefects: null,
      },
      secondary: {
        durationMs: 5000,
        timeToFirstUsableMs: null,
        modelUsd: 0.2,
        inputTokens: null,
        outputTokens: null,
        reviewCycles: 2,
        administrativeRepairs: 0,
      },
      capabilitySignals: [
        { capability: "graph", relevantInput: false, invoked: true },
        {
          capability: "memory",
          relevantInput: true,
          invoked: true,
          decisionChange: {
            before: "Retry the rejected fix",
            after: "Preserve the recorded compatibility rule",
            evidence: ["trace/memory-decision"],
          },
        },
      ],
    };
    const summary = summarizeComparison(prepared, [row]);
    expect(summary.arms.find((arm) => arm.arm === "replacement")).toMatchObject({
      failures: 1,
      completed: 0,
      missingRuns: 8,
      quality: { correctness: { observed: 0, missing: 9, mean: null } },
    });
    expect(summary.promotion.eligible).toBe(false);
    expect(summary.arms.find((arm) => arm.arm === "replacement")?.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: "graph",
          relevantRuns: 0,
          invokedRuns: 1,
          reportedDecisionChanges: 0,
        }),
        expect.objectContaining({
          capability: "memory",
          relevantRuns: 1,
          invokedRuns: 1,
          reportedDecisionChanges: 1,
        }),
      ]),
    );
    expect(() =>
      summarizeComparison(prepared, [
        {
          ...row,
          capabilitySignals: [
            {
              capability: "graph",
              relevantInput: false,
              invoked: true,
              decisionChange: { before: "A", after: "B", evidence: ["trace"] },
            },
          ],
        },
      ]),
    ).toThrow();
    expect(() => summarizeComparison(prepared, [row, row])).toThrow("duplicated");
    expect(() => summarizeComparison(prepared, [{ ...row, assignmentId: "invented" }])).toThrow(
      "unknown",
    );
  });
});

async function calibrationCases(root: string, scenarios: string[]) {
  const cases = [];
  for (const scenario of scenarios) {
    const promptFile = join(root, `${scenario}-prompt.md`);
    await writeFile(
      promptFile,
      `Review the visible behavior against the supplied goal ${scenario}`,
    );
    for (const variant of ["defective", "control"]) {
      const asset = join(root, `${scenario}-${variant}.png`);
      const oracleFile = join(root, `${scenario}-${variant}-oracle.json`);
      await writeFile(asset, `fixture pixels ${scenario}${variant}`);
      await writeFile(oracleFile, `Evaluator-only expectations ${scenario}${variant}`);
      cases.push({
        id: `${scenario}-${variant}`,
        scenario,
        variant,
        promptFile,
        assets: [asset],
        oracleFile,
      });
    }
  }
  return cases;
}

it("pins isolated reviewer calibration inputs with three repetitions and no live budget", async () => {
  const { root, spec, output } = await setup();
  await prepareComparison(spec, output);
  const cases = await calibrationCases(root, ["flockshot", "booking", "checkout"]);
  const reviewer = balancedCritic("codex");
  const result = await prepareReviewCalibration(output, { reviewer, cases });
  expect(result).toMatchObject({
    runnable: false,
    budget: null,
    reviewer: { model: reviewer?.model },
  });
  expect(result.assignments).toHaveLength(18);
  expect(result.cases[0]?.reviewer).not.toHaveProperty("evaluator");
  expect(runExperiment).not.toHaveBeenCalled();
  await expect(
    prepareReviewCalibration(output, {
      reviewer,
      cases: cases.map((entry, index) =>
        index ? entry : { ...entry, assets: [entry.oracleFile] },
      ),
    }),
  ).rejects.toThrow("Evaluator");
});

it("accepts up to sixteen calibration cases across seven scenarios", async () => {
  const { root, spec, output } = await setup();
  await prepareComparison(spec, output);
  const cases = await calibrationCases(root, [
    "fowl-play",
    "flockshot",
    "booking",
    "checkout",
    "catapult-preview",
    "slingshot-preview",
    "catapult-finish",
  ]);
  const result = await prepareReviewCalibration(output, {
    reviewer: balancedCritic("codex"),
    cases,
  });
  expect(result.cases).toHaveLength(14);
  expect(result.assignments).toHaveLength(42);
});

it("rejects calibration sets with fewer than three scenarios or more than sixteen cases", async () => {
  const { root, spec, output } = await setup();
  await prepareComparison(spec, output);
  const reviewer = balancedCritic("codex");
  const two = await calibrationCases(root, ["booking", "checkout"]);
  await expect(prepareReviewCalibration(output, { reviewer, cases: two })).rejects.toThrow();
  const nine = await calibrationCases(
    root,
    Array.from({ length: 9 }, (_, index) => `scene${index}`),
  );
  await expect(prepareReviewCalibration(output, { reviewer, cases: nine })).rejects.toThrow();
  const unpaired = (
    await calibrationCases(root, ["booking", "checkout", "flockshot", "fowl-play"])
  ).filter((entry) => entry.id !== "flockshot-control");
  await expect(prepareReviewCalibration(output, { reviewer, cases: unpaired })).rejects.toThrow(
    "one defective and one control",
  );
  const [first, ...others] = await calibrationCases(root, ["booking", "checkout", "flockshot"]);
  const doubled = [
    ...others,
    first,
    { ...(first as NonNullable<typeof first>), id: "booking-extra" },
  ];
  await expect(prepareReviewCalibration(output, { reviewer, cases: doubled })).rejects.toThrow(
    "one defective and one control",
  );
});
