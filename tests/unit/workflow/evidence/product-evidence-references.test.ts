import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../../../src/config/schema.js";
import { hashValue, sha256 } from "../../../../src/core/hash.js";
import { err, ok } from "../../../../src/core/result.js";
import { browserJourneySchema } from "../../../../src/testing/browser-journey.js";
import {
  productJourneyKey,
  rawUrlJourneyKey,
} from "../../../../src/workflow/evidence/product-journey.js";
import {
  outcomeStatuses,
  productEvidenceGaps,
} from "../../../../src/workflow/product/assessment.js";
import {
  productEvidenceCatalogue as buildCatalogue,
  currentJourneyFailures,
  currentJourneyFeedback,
  evidenceSupportGaps,
  type ProductEvidenceCatalogue,
  resolveAssessmentEvidence,
  withoutUnavailableCitations,
} from "../../../../src/workflow/product/evidence-references.js";
import {
  initialProductState,
  type ProductExecution,
  parseProductBrief,
} from "../../../../src/workflow/product/model.js";
import { productSources } from "../../../../src/workflow/product/sources.js";
import type { ProductRecord } from "../../../../src/workflow/product/store.js";
import { productContractDigest } from "../../../../src/workflow/product/subject.js";
import type { WorkspaceState } from "../../../../src/workflow/state.js";
import { pngHeader } from "../../support/workspace.js";

// These catalogue unit tests deliberately supply no implementation sources; workspace I/O is tested separately.
const productEvidenceCatalogue = (...args: Parameters<typeof buildCatalogue>) =>
  buildCatalogue(...([args[0], args[1], args[2], args[3], args[4], []] as const));
const subject = "a".repeat(64);
const workspace = {
  config: defaultConfig(),
  files: { readBytesIfExists: async () => ok(undefined) },
} as unknown as WorkspaceState;
function record(): ProductRecord {
  const parsed = parseProductBrief({
    version: 2,
    feature: "001-evidence",
    originalRequest: "Preserved request",
    goal: "Observable result",
    outcomes: [{ id: "O001", kind: "quality", statement: "Observable result" }],
    checks: [{ id: "C001", command: ["node", "check.mjs"], outcomes: ["O001"] }],
    slices: [
      {
        id: "T001",
        goal: "Result",
        outcomes: ["O001"],
        checks: ["C001"],
        scope: { allowed: ["app.mjs"] },
      },
    ],
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return {
    brief: parsed.value,
    state: initialProductState(parsed.value, "2026-09-08"),
    briefText: "",
    stateText: "",
  };
}
function execution(
  input: ProductRecord,
  changes: Partial<ProductExecution> = {},
): ProductExecution {
  return {
    id: "EXEC-1",
    check: "C001",
    subjectDigest: subject,
    contractDigest: productContractDigest(input.brief),
    createdAt: "2026-09-08",
    command: "node check.mjs",
    status: "passed",
    exitCode: 0,
    durationMs: 5,
    output: "Observed result",
    provenance: "supervisor-executed",
    assertions: "agent-reported",
    ...changes,
  };
}
const image = () => {
  const bytes = pngHeader(390, 844);
  return {
    id: "CAP-1",
    path: ".visp/capture.png",
    sha256: sha256(bytes),
    subjectDigest: subject,
    viewport: { width: 390, height: 844 },
    route: "http://localhost/",
    steps: ["Navigate"],
    createdAt: "2026-09-08",
    provenance: "runner-captured" as const,
    data: bytes.toString("base64"),
    mimeType: "image/png",
  };
};
function run(input: ProductRecord, changes: Record<string, unknown> = {}) {
  return {
    id: "RUN-1",
    version: 2,
    provenance: "runner-executed",
    subjectDigest: subject,
    contractDigest: productContractDigest(input.brief),
    journeyDigest: "exact-one",
    journeyKey: "journey-v2:condition-one",
    status: "completed",
    captures: [image()],
    operations: [],
    ...changes,
  };
}

describe("derived evidence identities", () => {
  it("retains held-input failures when only an immediate press passes", () => {
    const input = record();
    const journey = browserJourneySchema.parse({
      url: "https://example.test",
      actions: [
        {
          kind: "drag",
          selector: "#launch",
          from: { x: 20, y: 20 },
          to: { x: 20, y: 20 },
          steps: 2,
          durationMs: 80,
        },
      ],
    });
    const immediate = browserJourneySchema.parse({
      ...journey,
      actions: [{ ...journey.actions[0], durationMs: 0 }],
    });
    const heldFailure = run(input, {
      id: "held",
      journey,
      journeyKey: productJourneyKey(journey),
      journeyDigest: hashValue(journey),
      status: "failed",
      failure: { kind: "behavior", message: "Button replaced before release" },
    });
    input.state.captureRuns = [
      heldFailure,
      run(input, {
        id: "immediate",
        journey: immediate,
        journeyKey: productJourneyKey(immediate),
        journeyDigest: hashValue(immediate),
      }),
    ];
    expect(currentJourneyFailures(input, subject)).toHaveLength(1);
    const retry = browserJourneySchema.parse({
      ...journey,
      actions: [{ ...journey.actions[0], capture: true }],
    });
    input.state.captureRuns.push(
      run(input, {
        id: "held-repaired",
        journey: retry,
        journeyKey: productJourneyKey(retry),
        journeyDigest: hashValue(retry),
      }),
    );
    expect(currentJourneyFailures(input, subject)).toEqual([]);
  });

  it("counts a replay on another loopback port as the replay of a failed journey", () => {
    const input = record();
    const journeyAt = (origin: string) =>
      browserJourneySchema.parse({
        url: `${origin}/play`,
        actions: [{ kind: "click", selector: "#launch" }],
      });
    const failed = journeyAt("http://localhost:3000");
    const replayed = journeyAt("http://127.0.0.1:8123");
    input.state.captureRuns = [
      run(input, {
        id: "failed-on-3000",
        journey: failed,
        journeyKey: productJourneyKey(failed),
        journeyDigest: hashValue(failed),
        status: "failed",
        failure: { kind: "behavior", message: "Launch did nothing" },
      }),
    ];
    expect(currentJourneyFailures(input, subject)).toHaveLength(1);
    input.state.captureRuns.push(
      run(input, {
        id: "replayed-on-8123",
        journey: replayed,
        journeyKey: productJourneyKey(replayed),
        journeyDigest: hashValue(replayed),
      }),
    );
    expect(currentJourneyFailures(input, subject)).toEqual([]);
  });

  it("lets a replay clear a failure stored under the raw-URL key an earlier build wrote", () => {
    const input = record();
    const journey = browserJourneySchema.parse({
      url: "http://localhost:3000/play",
      actions: [{ kind: "click", selector: "#launch" }],
    });
    const previousKey = rawUrlJourneyKey(journey);
    expect(previousKey).not.toBe(productJourneyKey(journey));
    // Golden value computed with the build that hashed the URL as written.
    expect(previousKey).toBe(
      "journey-v3:ed08a8a5444e4d79cbd121b792aca1c2032d5125f06d78a2195aa672e1ed8e5a",
    );
    const recorded = run(input, {
      id: "recorded-by-earlier-build",
      journey,
      journeyKey: previousKey,
      journeyDigest: hashValue(journey),
      status: "failed",
      failure: { kind: "behavior", message: "Launch did nothing" },
    });
    input.state.captureRuns = [recorded];
    expect(currentJourneyFailures(input, subject)).toHaveLength(1);
    const replayed = browserJourneySchema.parse({ ...journey, url: "http://127.0.0.1:9000/play" });
    input.state.captureRuns.push(
      run(input, {
        id: "replayed-by-this-build",
        journey: replayed,
        journeyKey: productJourneyKey(replayed),
        journeyDigest: hashValue(replayed),
      }),
    );
    expect(currentJourneyFailures(input, subject)).toEqual([]);
    // A stored key that is neither the current nor the raw-URL key is not trusted as this journey.
    input.state.captureRuns = [
      { ...recorded, journeyKey: `journey-v3:${"0".repeat(64)}` },
      ...input.state.captureRuns.slice(1),
    ];
    expect(currentJourneyFailures(input, subject)).toHaveLength(1);
  });

  it.each([1, 2])(
    "requires a contract for modern capture evidence while preserving version %s history",
    async (version) => {
      const input = record();
      const capture = image();
      input.state.captures = [capture];
      input.state.captureRuns = [
        run(input, {
          version,
          contractDigest: undefined,
          operations: [
            {
              id: "OP-unbound",
              kind: "observe",
              measurement: { json: '{"matched":true}', truncated: false },
            },
          ],
        }),
      ];
      const catalogue = await productEvidenceCatalogue(workspace, input, subject, [capture]);
      expect(catalogue.entries.find((entry) => entry.id === "OP-unbound")?.status).toBe(
        version === 1 ? "available" : "stale",
      );
      expect(catalogue.entries.find((entry) => entry.id === capture.id)?.viewport).toEqual(
        version === 1 ? capture.viewport : undefined,
      );
    },
  );
  it("keeps explicit old passes from hiding a later same-subject failure, then permits an actual passing retry", async () => {
    const input = record();
    input.state.executions = [
      execution(input),
      execution(input, { id: "EXEC-2", status: "failed" }),
    ];
    let catalogue = await productEvidenceCatalogue(workspace, input, subject, []);
    expect(catalogue.entries.find((entry) => entry.id === "EXEC-1")?.status).toBe("failed");
    input.state.executions.push(execution(input, { id: "EXEC-3" }));
    catalogue = await productEvidenceCatalogue(workspace, input, subject, []);
    expect(catalogue.aliases.get("C001")).toBe("EXEC-3");
    expect(catalogue.entries.find((entry) => entry.id === "EXEC-1")?.status).toBe("available");
  });
  it("keeps shared-check evidence separate across slices and scopes the check alias", async () => {
    const input = record();
    const first = input.brief.slices[0];
    if (!first) throw new Error("Missing first slice");
    const second = { ...first, id: "T002", goal: "Independent result" };
    input.brief.slices.push(second);
    input.state.executions = [
      execution(input, {
        id: "EXEC-T001",
        task: first.id,
        contractDigest: productContractDigest(input.brief, first),
      }),
      execution(input, {
        id: "EXEC-T002",
        task: second.id,
        contractDigest: productContractDigest(input.brief, second),
        status: "failed",
        exitCode: 1,
      }),
    ];
    const catalogue = await productEvidenceCatalogue(workspace, input, subject, []);
    expect(catalogue.entries.find((entry) => entry.id === "EXEC-T001")?.status).toBe("available");
    expect(catalogue.entries.find((entry) => entry.id === "EXEC-T002")?.status).toBe("failed");
    expect(catalogue.aliases.get("C001")).toBe("EXEC-T002");
    const firstCatalogue = await buildCatalogue(workspace, input, subject, [], [], [], first);
    const secondCatalogue = await buildCatalogue(workspace, input, subject, [], [], [], second);
    expect(firstCatalogue.aliases.get("C001")).toBe("EXEC-T001");
    expect(secondCatalogue.aliases.get("C001")).toBe("EXEC-T002");
    expect(firstCatalogue.entries.find((entry) => entry.id === "EXEC-T002")?.status).toBe(
      "unavailable",
    );
    expect(outcomeStatuses(input, subject, first)[0]?.behavior).toBe("passed");
    expect(outcomeStatuses(input, subject, second)[0]?.behavior).toBe("failed");
    expect((await productEvidenceGaps(workspace, input, subject, first)).join("\n")).not.toContain(
      "C001: failed",
    );
    expect((await productEvidenceGaps(workspace, input, subject, second)).join("\n")).toContain(
      "C001: failed",
    );
    input.state.executions = input.state.executions.map((entry) => ({
      ...entry,
      status: entry.task === first.id ? "failed" : "passed",
      exitCode: entry.task === first.id ? 1 : 0,
    }));
    expect(outcomeStatuses(input, subject, first)[0]?.behavior).toBe("failed");
    expect(outcomeStatuses(input, subject, second)[0]?.behavior).toBe("passed");
    expect((await productEvidenceGaps(workspace, input, subject, first)).join("\n")).toContain(
      "C001: failed",
    );
  });
  it("retains a scoped check failure when a later feature-wide run of the same check passes", async () => {
    const input = record();
    const slice = input.brief.slices[0];
    if (!slice) throw new Error("Missing slice");
    input.state.executions = [
      execution(input, {
        id: "EXEC-SLICE-FAILED",
        task: slice.id,
        contractDigest: productContractDigest(input.brief, slice),
        status: "failed",
        exitCode: 1,
      }),
      execution(input, { id: "EXEC-FEATURE-PASSED" }),
    ];

    expect(outcomeStatuses(input, subject, slice)[0]?.behavior).toBe("failed");
    expect((await productEvidenceGaps(workspace, input, subject, slice)).join("\n")).toContain(
      "C001: failed",
    );
    const catalogue = await buildCatalogue(workspace, input, subject, [], [], [], slice);
    expect(catalogue.aliases.get("C001")).toBe("EXEC-SLICE-FAILED");

    input.state.executions.push(
      execution(input, {
        id: "EXEC-SLICE-RECHECKED",
        task: slice.id,
        contractDigest: productContractDigest(input.brief, slice),
      }),
    );
    expect(outcomeStatuses(input, subject, slice)[0]?.behavior).toBe("passed");
    expect((await productEvidenceGaps(workspace, input, subject, slice)).join("\n")).not.toContain(
      "C001: failed",
    );
    const rechecked = await buildCatalogue(workspace, input, subject, [], [], [], slice);
    expect(rechecked.aliases.get("C001")).toBe("EXEC-SLICE-RECHECKED");
  });
  it("retains a feature-wide failure when a later scoped run of the same check passes", async () => {
    const input = record();
    const slice = input.brief.slices[0];
    if (!slice) throw new Error("Missing slice");
    input.state.executions = [
      execution(input, { id: "EXEC-FEATURE-FAILED", status: "failed", exitCode: 1 }),
      execution(input, {
        id: "EXEC-SLICE-PASSED",
        task: slice.id,
        contractDigest: productContractDigest(input.brief, slice),
      }),
    ];

    expect(outcomeStatuses(input, subject, slice)[0]?.behavior).toBe("failed");
    expect((await productEvidenceGaps(workspace, input, subject, slice)).join("\n")).toContain(
      "C001: failed",
    );
    const catalogue = await buildCatalogue(workspace, input, subject, [], [], [], slice);
    expect(catalogue.aliases.get("C001")).toBe("EXEC-FEATURE-FAILED");
  });
  it("refuses ambiguous execution and operation IDs without rewriting either receipt", async () => {
    const input = record();
    input.state.executions = [
      execution(input, { id: "EXEC-DUP", status: "failed", exitCode: 1 }),
      execution(input, { id: "EXEC-DUP" }),
    ];
    input.state.captureRuns = [
      run(input, { id: "RUN-1", operations: [{ id: "OP-DUP", kind: "pointer" }] }),
      run(input, {
        id: "RUN-2",
        operations: [
          {
            id: "OP-DUP",
            kind: "observe",
            measurement: { json: '{"matched":true}', truncated: false },
          },
        ],
      }),
    ];
    const before = JSON.stringify(input.state);
    const catalogue = await productEvidenceCatalogue(workspace, input, subject, []);
    for (const id of ["EXEC-DUP", "OP-DUP"]) {
      expect(catalogue.entries.filter((entry) => entry.id === id)).toHaveLength(2);
      expect(catalogue.entries.filter((entry) => entry.id === id)).toEqual([
        expect.objectContaining({ status: "unavailable" }),
        expect.objectContaining({ status: "unavailable" }),
      ]);
      expect(evidenceSupportGaps([id], catalogue, "O001", true).join(" ")).toContain("ambiguous");
      expect(
        resolveAssessmentEvidence(
          {
            outcome: "O001",
            status: "satisfied",
            provenance: "agent-reported",
            summary: "Ambiguous citation",
            evidence: [id],
            expectations: [],
          },
          catalogue,
        ),
      ).toMatchObject({ ok: false, error: { code: "EVIDENCE_FAILED" } });
    }
    expect(JSON.stringify(input.state)).toBe(before);
  });
  it("distinguishes stale and environment-failed executions from unexecuted check declarations", async () => {
    const input = record();
    input.state.executions = [
      execution(input, { subjectDigest: "old" }),
      execution(input, { id: "EXEC-env", status: "environment-failed" }),
    ];
    const catalogue = await productEvidenceCatalogue(workspace, input, subject, []);
    expect(catalogue.entries.find((entry) => entry.id === "EXEC-1")?.status).toBe("stale");
    expect(catalogue.entries.find((entry) => entry.id === "EXEC-env")?.status).toBe("unavailable");
    const absent = await productEvidenceCatalogue(workspace, record(), subject, []);
    expect(absent.entries.find((entry) => entry.id === "C001")?.status).toBe("unavailable");
    expect(evidenceSupportGaps(["missing", "SRC-REQUEST"], absent).join()).toContain(
      "No current execution",
    );
    expect(
      resolveAssessmentEvidence(
        {
          outcome: "O001",
          status: "satisfied",
          provenance: "agent-reported",
          summary: "Claims source suffices",
          evidence: [],
          expectations: [
            { id: "E001", status: "satisfied", reason: "Reported", evidence: ["missing"] },
          ],
        },
        absent,
      ),
    ).toMatchObject({ ok: false });
  });
  it("only derives viewport facts from intact completed runner capture identity", async () => {
    const input = record();
    const capture = image();
    input.state.captures = [null, capture];
    input.state.captureRuns = [run(input)];
    expect(
      (await productEvidenceCatalogue(workspace, input, subject, [capture])).entries.find(
        (entry) => entry.id === capture.id,
      )?.viewport,
    ).toEqual({ width: 390, height: 844 });
    for (const changed of [
      run(input, { status: "failed" }),
      run(input, { captures: [{ ...capture, sha256: "b".repeat(64) }] }),
      run(input, { contractDigest: "old" }),
    ]) {
      input.state.captureRuns = [changed];
      expect(
        (await productEvidenceCatalogue(workspace, input, subject, [capture])).entries.find(
          (entry) => entry.id === capture.id,
        )?.viewport,
      ).toBeUndefined();
    }
    input.state.captureRuns = [run(input)];
    const wrongPixels = { ...capture, data: pngHeader(1280, 720).toString("base64") };
    expect(
      (await productEvidenceCatalogue(workspace, input, subject, [wrongPixels])).entries.find(
        (entry) => entry.id === capture.id,
      )?.viewport,
    ).toBeUndefined();
  });
  it.each([
    [undefined, "unavailable"],
    [{ json: "invalid", truncated: false }, "unavailable"],
    [{ json: "{}", truncated: false }, "unavailable"],
    [{ json: '{"matched":true}', truncated: true }, "unavailable"],
    [{ json: '{"matched":true}', truncated: false }, "available"],
    [{ json: '{"matched":false}', truncated: false }, "failed"],
  ])(
    "keeps terminal observation validity distinct from its existence",
    async (measurement, status) => {
      const input = record();
      input.state.captureRuns = [
        null,
        run(input, { operations: [{ id: "OP-1", kind: "observe", measurement }] }),
      ];
      expect(
        (await productEvidenceCatalogue(workspace, input, subject, [])).entries.find(
          (entry) => entry.id === "OP-1",
        )?.status,
      ).toBe(status);
    },
  );
  it("exposes actual control sensitivity without treating agent-printed control data as executed", async () => {
    const input = record();
    input.state.controls = [
      null,
      { id: "PRINTED", execution: { detected: true } },
      {
        id: "CTL-1",
        subjectDigest: subject,
        contractDigest: productContractDigest(input.brief),
        outcomes: ["O001"],
        execution: { provenance: "supervisor-executed", detected: false },
      },
    ];
    const catalogue = await productEvidenceCatalogue(workspace, input, subject, []);
    expect(catalogue.entries.some((entry) => entry.id === "PRINTED")).toBe(false);
    expect(catalogue.entries.find((entry) => entry.id === "CTL-1")).toMatchObject({
      status: "failed",
      summary: expect.stringContaining("sensitivity"),
    });
  });
  it("keeps a failed scrolling observation failed after a successful retry", async () => {
    const input = record();
    input.state.captureRuns = [
      run(input, {
        status: "timed-out",
        operations: [
          {
            id: "SCROLL-failed",
            kind: "scroll",
            measurement: {
              json: JSON.stringify({
                before: { y: 0 },
                after: { y: 0, inViewport: false },
                matched: false,
              }),
              truncated: false,
            },
          },
        ],
      }),
      run(input, {
        id: "RUN-retry",
        operations: [
          {
            id: "SCROLL-passed",
            kind: "scroll",
            measurement: {
              json: JSON.stringify({
                before: { y: 0 },
                after: { y: 400, inViewport: true },
                matched: true,
              }),
              truncated: false,
            },
          },
        ],
      }),
    ];
    const catalogue = await productEvidenceCatalogue(workspace, input, subject, []);
    expect(currentJourneyFailures(input, subject)).toEqual([]);
    expect(catalogue.entries.find((entry) => entry.id === "SCROLL-failed")?.status).toBe("failed");
    expect(evidenceSupportGaps(["SCROLL-failed"], catalogue)).toContain(
      "SCROLL-failed: evidence failed",
    );
    expect(evidenceSupportGaps(["SCROLL-passed"], catalogue)).toEqual([]);
  });
  it("does not use action-only operations or sensitivity controls as functional results", async () => {
    const input = record();
    input.state.captureRuns = [
      run(input, {
        operations: [
          { id: "NAV", kind: "navigate" },
          { id: "CLICK", kind: "pointer" },
          { id: "CAPTURE", kind: "capture" },
          {
            id: "OBSERVED",
            kind: "observe",
            measurement: { json: '{"matched":true}', truncated: false },
          },
        ],
      }),
    ];
    input.state.controls = [
      {
        id: "CONTROL",
        subjectDigest: subject,
        contractDigest: productContractDigest(input.brief),
        outcomes: ["O001"],
        execution: { provenance: "supervisor-executed", detected: true },
      },
    ];
    const catalogue = await productEvidenceCatalogue(workspace, input, subject, []);
    for (const id of ["NAV", "CLICK", "CAPTURE", "CONTROL"])
      expect(evidenceSupportGaps([id], catalogue, "O001", true)).toContain(
        "No current execution or observation supports this judgment",
      );
    expect(evidenceSupportGaps(["OBSERVED"], catalogue, "O001", true)).toEqual([]);
  });
  it("clears only the same generated semantic journey and contract, preserving altered expectations", () => {
    const input = record();
    const failed = run(input, {
      status: "failed",
      failure: { kind: "behavior", message: "Expected score to change" },
    });
    input.state.captureRuns = [failed, run(input, { journeyKey: "journey-v2:navigation-only" })];
    expect(currentJourneyFailures(input, subject)).toHaveLength(1);
    input.state.captureRuns.push(run(input, { journeyDigest: "different-timeout-and-captures" }));
    expect(currentJourneyFailures(input, subject)).toEqual([]);
    input.state.captureRuns = [
      failed,
      run(input, { journeyKey: "journey-v2:weakened-expected-score" }),
    ];
    expect(currentJourneyFailures(input, subject)).toHaveLength(1);
    input.state.captureRuns = [
      run(input, { ...failed, journeyKey: "old-coarse-key" }),
      run(input, { journeyKey: "old-coarse-key", journeyDigest: "different-actions" }),
    ];
    expect(currentJourneyFailures(input, subject)).toHaveLength(1);
    expect(currentJourneyFailures(input, "changed-product")).toHaveLength(1);
  });
  it("delivers bounded recent diagnostics without dropping unresolved completion gaps", () => {
    const input = record();
    input.state.captureRuns = Array.from({ length: 5 }, (_, index) =>
      run(input, {
        id: `RUN-${index}`,
        journeyKey: `journey-v2:condition-${index}`,
        status: "failed",
        failure: { kind: "behavior", message: `Unresolved condition ${index}` },
        operations: [
          {
            id: `OBS-${index}`,
            kind: "observe",
            measurement: { json: "x".repeat(9000), truncated: false },
          },
        ],
      }),
    );
    const feedback = currentJourneyFeedback(input, subject);
    expect(feedback.omitted).toBe(2);
    expect(feedback.runs.map((entry) => entry.runId)).toEqual(["RUN-4", "RUN-3", "RUN-2"]);
    expect(feedback.runs[0]?.terminalMeasurement).toEqual({
      json: "x".repeat(8000),
      truncated: true,
    });
    expect(currentJourneyFailures(input, subject)).toHaveLength(5);
    expect(currentJourneyFeedback(input, "changed-product").runs).toHaveLength(3);
  });
  it("pins source identity from full material while keeping missing or changed material unsubstantiated", async () => {
    const input = record();
    const content = `${"Context ".repeat(500)}External expectation`;
    const id = `SRC-${sha256(`oracle.txt:${sha256(content)}`).slice(0, 16)}`;
    input.brief.acceptanceBaseline = [
      {
        command: ["node", "oracle.txt"],
        files: [
          { path: "oracle.txt", sha256: sha256(content) },
          { path: "oracle.txt", sha256: sha256(content) },
        ],
      },
    ];
    const outcome = input.brief.outcomes[0];
    if (!outcome) throw new Error("Missing fixture outcome");
    outcome.source = id;
    outcome.sourceQuote = "External expectation";
    const available = {
      files: { readBytesIfExists: async () => ok(Buffer.from(content)) },
    } as unknown as WorkspaceState;
    const sources = await productSources(available, input);
    expect(sources.sources).toHaveLength(3);
    expect(sources.sources.some((source) => source.kind === "authored-brief")).toBe(true);
    expect(sources.sources.find((source) => source.id === id)?.excerpt).not.toContain(
      "External expectation",
    );
    expect(sources.claims[0]?.sourceStatus).toBe("identified");
    const missing = {
      files: {
        readBytesIfExists: async () => err({ code: "IO_ERROR", message: "Unavailable source" }),
      },
    } as unknown as WorkspaceState;
    expect((await productSources(missing, input)).claims[0]?.sourceStatus).toBe("unavailable");
    outcome.sourceQuote = "Not in actual source";
    expect((await productSources(available, input)).claims[0]?.sourceStatus).toBe(
      "unsubstantiated",
    );
  });
});

it.each([false, true])(
  "keeps the asserted terminal fields and preserves requested text (text assertion: %s)",
  (testsText) => {
    const input = record();
    const expected = {
      kind: "wait-for",
      selector: "#status",
      ...(testsText ? { text: "Ready" } : { attribute: { name: "data-state", value: "ready" } }),
    };
    const measurement = {
      json: JSON.stringify({
        expected,
        actual: { text: "Unrelated full page prose", attribute: "busy", count: 1 },
        matched: false,
      }),
      truncated: false,
    };
    input.state.captureRuns = [
      run(input, {
        status: "failed",
        failure: { kind: "behavior", message: "Expected ready, observed busy" },
        operations: [{ id: "OBS-state", kind: "observe", measurement }],
      }),
    ];
    const before = JSON.stringify(input.state);
    const feedback = currentJourneyFeedback(input, subject).runs[0]?.terminalMeasurement;
    expect(feedback).toBeDefined();
    const shown = JSON.parse(feedback?.json ?? "{}");
    expect(shown).toMatchObject({
      expected,
      actual: { attribute: "busy", count: 1 },
      matched: false,
    });
    if (testsText) expect(shown.actual.text).toBe("Unrelated full page prose");
    else {
      expect(shown.actual.text).toBeUndefined();
      expect(shown.omittedFields).toEqual(["actual.text"]);
      expect(feedback?.truncated).toBe(true);
    }
    expect(currentJourneyFailures(input, subject)).toHaveLength(1);
    expect(JSON.stringify(input.state)).toBe(before);
  },
);

it.each(["passed", "failed", "environment-failed"] as const)(
  "keeps CHECK aliases bound to the canonical execution's %s status",
  async (status) => {
    const input = record();
    input.state.executions = [execution(input, { status })];
    const source = {
      id: "CHECK-EXEC-1",
      kind: "executed-check" as const,
      reference: "Executed C001",
      sha256: "digest",
      available: true,
      excerpt: "Recorded results",
    };
    const catalogue = await buildCatalogue(workspace, input, subject, [], [], [source]);
    const canonical = catalogue.entries.find((entry) => entry.id === "EXEC-1");
    expect(catalogue.aliases.get(source.id)).toBe("EXEC-1");
    expect(catalogue.entries.find((entry) => entry.id === source.id)).toEqual({
      ...canonical,
      id: source.id,
    });
    expect(
      resolveAssessmentEvidence(
        {
          outcome: "O001",
          provenance: "agent-reported",
          status: "satisfied",
          summary: "Executed",
          evidence: [source.id],
          expectations: [],
        },
        catalogue,
      ),
    ).toMatchObject({ ok: true, value: { evidence: ["EXEC-1"] } });
  },
);

it("preserves stale, out-of-slice and syntax-only eligibility for CHECK aliases", async () => {
  const input = record();
  const slice = input.brief.slices[0];
  if (!slice) throw new Error("Missing slice");
  const check = input.brief.checks[0];
  if (!check) throw new Error("Missing check");
  check.command = ["node", "--check", "app.mjs"];
  input.state.executions = [execution(input, { subjectDigest: "old", task: "T001" })];
  const source = {
    id: "CHECK-EXEC-1",
    kind: "executed-check" as const,
    reference: "Executed C001",
    sha256: "digest",
    available: true,
    excerpt: "Recorded results",
  };
  const catalogue = await buildCatalogue(workspace, input, subject, [], [], [source], slice);
  expect(catalogue.entries.find((entry) => entry.id === source.id)).toMatchObject({
    status: "stale",
    supportsBehavior: false,
  });
  expect(evidenceSupportGaps([source.id], catalogue, "O001", true)).not.toHaveLength(0);
  const unbound = await buildCatalogue(
    workspace,
    input,
    subject,
    [],
    [],
    [{ ...source, id: "CHECK-invented" }],
  );
  expect(unbound.entries.find((entry) => entry.id === "CHECK-invented")?.kind).toBe("source");
  expect(evidenceSupportGaps(["CHECK-invented"], unbound, "O001", true)).not.toHaveLength(0);
});

describe("citations of evidence VISP could not deliver", () => {
  const entry = (
    id: string,
    status: ProductEvidenceCatalogue["entries"][number]["status"],
  ): ProductEvidenceCatalogue["entries"][number] => ({
    id,
    kind: "execution",
    status,
    summary: id,
    outcomes: [],
  });
  const catalogue: ProductEvidenceCatalogue = {
    entries: [
      entry("EXEC-OK", "available"),
      entry("SRC-PNG", "unavailable"),
      // Two receipts with one ID: VISP lists both as unavailable, but the ID is ambiguous.
      entry("EXEC-DUP", "unavailable"),
      entry("EXEC-DUP", "unavailable"),
      entry("EXEC-OLD", "stale"),
    ],
    aliases: new Map([["C001", "EXEC-OK"]]),
    sources: [],
    sourceClaims: [] as unknown as ProductEvidenceCatalogue["sourceClaims"],
  };

  it("are dropped beside evidence VISP delivered", () => {
    expect(withoutUnavailableCitations(["SRC-PNG", "C001"], catalogue)).toEqual({
      kept: ["C001"],
      dropped: ["SRC-PNG"],
    });
  });

  it("are kept when nothing else cited is usable", () => {
    expect(withoutUnavailableCitations(["SRC-PNG", "UNKNOWN"], catalogue)).toEqual({
      kept: ["SRC-PNG", "UNKNOWN"],
      dropped: [],
    });
  });

  it("never include an ambiguous ID, which keeps the judgment unavailable as before", () => {
    expect(withoutUnavailableCitations(["EXEC-DUP", "SRC-PNG", "C001"], catalogue)).toEqual({
      kept: ["EXEC-DUP", "C001"],
      dropped: ["SRC-PNG"],
    });
    // An ambiguous ID is not usable evidence that would let an unavailable one be dropped.
    expect(withoutUnavailableCitations(["EXEC-DUP", "SRC-PNG"], catalogue)).toEqual({
      kept: ["EXEC-DUP", "SRC-PNG"],
      dropped: [],
    });
    expect(evidenceSupportGaps(["EXEC-DUP", "C001"], catalogue).join(" ")).toContain(
      "EXEC-DUP: ambiguous evidence ID",
    );
  });
});
