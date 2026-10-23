import { readFile, rm } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runProductVerify, runProductWork } from "../../../../src/workflow/product/index.js";
import {
  independentJudgments,
  independentReviewSchema,
} from "../../../../src/workflow/product/review/independent-review.js";
import { deliveredReviewEvidenceIds } from "../../../../src/workflow/product/review/review-context.js";
import { runProductReviewRequest } from "../../../../src/workflow/product/review/review-request.js";
import { readProductRecord, saveProductState } from "../../../../src/workflow/product/store.js";
import { productSourceDigest } from "../../../../src/workflow/product/subject.js";
import { recordedProductJourney } from "../../support/product-journey.js";
import { productWorkspace } from "../../support/product-workspace.js";

const projects: Awaited<ReturnType<typeof productWorkspace>>[] = [];
afterEach(async () => {
  for (const project of projects.splice(0)) await project.workspace.destroy();
});
async function ready() {
  const p = await productWorkspace();
  projects.push(p);
  expect((await runProductWork(await p.workspace.state())).ok).toBe(true);
  await p.workspace.write("src/value.mjs", "export const value = 2;\n");
  expect((await runProductVerify(await p.workspace.state())).ok).toBe(true);
  return p.workspace;
}

it("owns review identity outside product source and records a session only once", async () => {
  const w = await ready();
  const state = await w.state();
  const before = await productSourceDigest(state);
  const prepared = await runProductReviewRequest(state, { prepare: true, task: "T001" });
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) return;
  const session = prepared.value as { session: string; packetPath: string; responsePath: string };
  expect(session.responsePath).toContain("/.visp/");
  const packet = JSON.parse(await readFile(session.packetPath, "utf8"));
  expect(packet.originalRequest).toBeTruthy();
  expect(independentReviewSchema.safeParse(packet.submission).success).toBe(true);
  expect(packet.submission).not.toHaveProperty("subjectDigest");
  expect(packet.submission).not.toHaveProperty("selection");
  expect(packet.submission.assessments).toHaveLength(0);
  expect(packet).not.toHaveProperty("challenges");
  expect(packet.submission).not.toHaveProperty("coverage");
  expect(await productSourceDigest(await w.state())).toEqual(before);
  const input = {
    session: session.session,
    task: "T001",
    ...independentJudgments(packet.submission, "product"),
  };
  expect(await runProductReviewRequest(await w.state(), input)).toMatchObject({
    ok: true,
    value: { recorded: true },
  });
  expect(await runProductReviewRequest(await w.state(), input)).toMatchObject({
    ok: false,
    error: { code: "STATE_BUSY" },
  });
});

it("delivers every shown interaction reference to prepared sessions", async () => {
  const w = await ready();
  await recordedProductJourney(w, "interaction-budget");
  const state = await w.state();
  const record = await readProductRecord(state, { task: "T001" });
  if (!record.ok) throw new Error(record.error.message);
  const run = record.value.state.captureRuns.at(-1);
  if (!run || typeof run !== "object") throw new Error("Missing interaction run");
  const runs = Array.from({ length: 6 }, (_, runIndex) => ({
    ...run,
    id: `interaction-budget-run-${runIndex}`,
    status: "completed" as const,
    operations: [
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `interaction-budget-${runIndex}-pointer-${index}`,
        kind: "pointer" as const,
      })),
      ...Array.from({ length: 6 }, (_, observationIndex) => ({
        id: `interaction-budget-${runIndex}-observe-${observationIndex}`,
        kind: "observe" as const,
        measurement: {
          json: JSON.stringify({
            expected: {
              selector: `#go-${runIndex}-${observationIndex}`,
              visibility: "visible",
            },
            actual: { selector: `#go-${runIndex}-${observationIndex}`, visibility: "visible" },
            matched: true,
          }),
          truncated: false,
        },
      })),
    ],
  }));
  const saved = await saveProductState(state, record.value, {
    ...record.value.state,
    captureRuns: [...record.value.state.captureRuns.slice(0, -1), ...runs],
  });
  expect(saved.ok).toBe(true);

  const prepared = await runProductReviewRequest(await w.state(), {
    prepare: true,
    task: "T001",
  });
  if (!prepared.ok) throw new Error(prepared.error.message);
  const packet = JSON.parse(
    await readFile((prepared.value as { packetPath: string }).packetPath, "utf8"),
  );
  const shownInteractionIds = packet.interactionEvidence.runs.flatMap(
    (entry: { observations: { id: string }[]; inputs: { id: string }[] }) => [
      ...entry.observations.map((observation) => observation.id),
      ...entry.inputs.map((input) => input.id),
    ],
  );
  expect(shownInteractionIds.length).toBeGreaterThan(60);
  const selectedInteractionId = shownInteractionIds[0];
  if (!selectedInteractionId) throw new Error("Missing shown interaction evidence");
  const responseSchema = JSON.stringify(packet.responseSchema);
  for (const id of shownInteractionIds) expect(responseSchema).toContain(id);
  expect(packet.evidence.map((entry: { id: string }) => entry.id)).toContain(
    "interaction-budget-before",
  );
  const sessionPath = resolve(
    (prepared.value as { packetPath: string }).packetPath,
    "../session.json",
  );
  const persistedSession = JSON.parse(await readFile(sessionPath, "utf8"));
  expect(persistedSession.evidenceIds).toEqual(expect.arrayContaining(shownInteractionIds));

  const submitted = await runProductReviewRequest(await w.state(), {
    session: (prepared.value as { session: string }).session,
    assessments: [
      {
        outcome: "O001",
        status: "unclear",
        summary: "The current interaction was inspected.",
        evidence: [selectedInteractionId],
      },
    ],
  });
  expect(submitted).toMatchObject({ ok: true });
});

it("does not promote an undelivered image into the generated reference union", () => {
  const interactionEvidence = {
    runs: [
      {
        runId: "run-current",
        status: "completed",
        viewports: [],
        observations: [
          {
            id: "OP-shown",
            status: "matched",
            expected: { selector: "#go" },
            actual: { selector: "#go" },
            limitation: "",
          },
        ],
        layout: [],
        inputs: [],
        omittedObservations: 0,
        omittedLayouts: 0,
        layoutAvailability: "No layout measurement",
        omittedInputs: 0,
      },
    ],
    omittedRuns: 0,
    guidance: "",
  } as Parameters<typeof deliveredReviewEvidenceIds>[1];
  expect(
    deliveredReviewEvidenceIds(
      [
        { id: "CAP-current", status: "available" },
        { id: "CAP-omitted", status: "not-delivered" },
      ],
      interactionEvidence,
    ),
  ).toEqual(["CAP-current", "OP-shown"]);
});

it("rejects changed source, escaping session IDs and manufactured evidence", async () => {
  const w = await ready();
  const prepared = await runProductReviewRequest(await w.state(), { prepare: true, task: "T001" });
  if (!prepared.ok) throw new Error(prepared.error.message);
  const { session } = prepared.value as { session: string };
  expect(
    await runProductReviewRequest(await w.state(), { session: "../../outside", assessments: [] }),
  ).toMatchObject({ ok: false });
  expect(
    await runProductReviewRequest(await w.state(), {
      session,
      assessments: [
        { outcome: "O001", status: "satisfied", summary: "invented", evidence: ["CAP-made-up"] },
      ],
    }),
  ).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("outside this review session") },
  });
  await w.write("src/value.mjs", "export const value = 3;\n");
  expect(
    await runProductReviewRequest(await w.state(), { session, assessments: [] }),
  ).toMatchObject({ ok: false, error: { code: "EVIDENCE_FAILED" } });
});

it.each(["pretend", ""])(
  "does not allow session identity %j to be supplied in a judgment",
  async (subjectDigest) => {
    const w = await ready();
    expect(
      await runProductReviewRequest(await w.state(), {
        session: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
        subjectDigest,
        assessments: [],
      }),
    ).toMatchObject({ ok: false, error: { code: "ARTIFACT_INVALID" } });
  },
);

it("refuses session metadata that redirects prepared image reads", async () => {
  const w = await ready();
  await recordedProductJourney(w, "original");
  const prepared = await runProductReviewRequest(await w.state(), { prepare: true, task: "T001" });
  if (!prepared.ok) throw new Error(prepared.error.message);
  const { session, packetPath } = prepared.value as { session: string; packetPath: string };
  const path = resolve(packetPath, "../session.json");
  const original = JSON.parse(await readFile(path, "utf8"));
  const packet = JSON.parse(await readFile(packetPath, "utf8"));
  for (const image of [
    { ...original.images[0], path: packet.images[0].sourcePath },
    { path: "/tmp/outside.png", sha256: "../../../../outside" },
  ]) {
    await w.write(relative(w.root, path), JSON.stringify({ ...original, images: [image] }));
    expect(
      await runProductReviewRequest(await w.state(), { session, assessments: [] }),
    ).toMatchObject({ ok: false, error: { code: "ARTIFACT_INVALID" } });
  }
  await w.write(relative(w.root, path), JSON.stringify(original));
  expect(
    await runProductReviewRequest(await w.state(), { session, assessments: [] }),
  ).toMatchObject({ ok: true });
});

it.each(["altered", "missing"])(
  "keeps prepared image selection stable and rejects %s selected bytes",
  async (change) => {
    const w = await ready();
    const captures = await recordedProductJourney(w, "original");
    const prepared = await runProductReviewRequest(await w.state(), {
      prepare: true,
      task: "T001",
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    const session = prepared.value as { session: string; packetPath: string; responsePath: string };
    const packet = await readFile(session.packetPath, "utf8");
    await recordedProductJourney(w, "unrelated");
    expect(await readFile(session.packetPath, "utf8")).toBe(packet);
    const selected = captures[0];
    if (!selected) throw new Error("No capture");
    await w.write(relative(w.root, session.responsePath), JSON.stringify({ assessments: [] }));
    const submitted = await runProductReviewRequest(await w.state(), {
      session: session.session,
      assessments: [],
    });
    if (!submitted.ok) throw new Error(submitted.error.message);
    expect(submitted.ok).toBe(true);
    const again = await runProductReviewRequest(await w.state(), { prepare: true, task: "T001" });
    if (!again.ok) throw new Error(again.error.message);
    const later = again.value as { session: string; packetPath: string };
    const image = JSON.parse(await readFile(later.packetPath, "utf8")).images[0];
    if (change === "altered")
      await w.write(relative(w.root, resolve(w.root, image.path)), "changed bytes");
    else await rm(resolve(w.root, image.path));
    expect(
      await runProductReviewRequest(await w.state(), { session: later.session, assessments: [] }),
    ).toMatchObject({ ok: false, error: { code: "EVIDENCE_FAILED" } });
  },
);

it("rejects corrupt session metadata, mismatched selection and a removed review mode", async () => {
  const w = await ready();
  const prepared = await runProductReviewRequest(await w.state(), { prepare: true, task: "T001" });
  if (!prepared.ok) throw new Error(prepared.error.message);
  const { session, packetPath } = prepared.value as { session: string; packetPath: string };
  const path = resolve(packetPath, "../session.json");
  const original = JSON.parse(await readFile(path, "utf8"));
  for (const input of [
    "{",
    "{}",
    JSON.stringify({ ...original, id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" }),
    JSON.stringify({ ...original, reviewMode: "observation-preview" }),
    JSON.stringify({ ...original, selection: { ...original.selection, feature: "999-other" } }),
  ]) {
    await w.write(relative(w.root, path), input);
    expect(
      await runProductReviewRequest(await w.state(), { session, assessments: [] }),
    ).toMatchObject({ ok: false });
  }
  await w.write(relative(w.root, path), JSON.stringify(original));
  expect(
    await runProductReviewRequest(await w.state(), { session, task: "T999", assessments: [] }),
  ).toMatchObject({ ok: false });
  expect(
    await runProductReviewRequest(await w.state(), {
      session: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      assessments: [],
    }),
  ).toMatchObject({ ok: false });
  expect(
    await runProductReviewRequest(await w.state(), { prepare: true, feature: "999-missing" }),
  ).toMatchObject({ ok: false });
  expect(
    await runProductReviewRequest(await w.state(), { prepare: true, task: "T999" }),
  ).toMatchObject({ ok: false });
  const packet = JSON.parse(await readFile(packetPath, "utf8"));
  const evidence = packet.evidence
    .filter((entry: { status: string }) => entry.status === "available")
    .slice(0, 1)
    .map((entry: { id: string }) => entry.id);
  expect(
    await runProductReviewRequest(await w.state(), {
      session,
      assessments: [
        { outcome: "O001", status: "unclear", summary: "Still requires assessment", evidence },
      ],
      detail: true,
    }),
  ).toMatchObject({ ok: true });
});

it("does not record two submissions when callers race for one session", async () => {
  const w = await ready();
  const result = await runProductReviewRequest(await w.state(), { prepare: true, task: "T001" });
  if (!result.ok) throw new Error(result.error.message);
  const session = (result.value as { session: string }).session;
  const state = await w.state();
  const results = await Promise.all(
    [1, 2].map(() => runProductReviewRequest(state, { session, assessments: [] })),
  );
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.filter((result) => !result.ok)).toHaveLength(1);
});

it("persists execution-derived links using only the prepared image selection", async () => {
  const w = await ready();
  const captures = await recordedProductJourney(w, "linked");
  const state = await w.state();
  const record = await readProductRecord(state);
  if (!record.ok) throw new Error(record.error.message);
  const saved = await saveProductState(state, record.value, {
    ...record.value.state,
    captureRuns: record.value.state.captureRuns.map((run) => ({
      ...(run as object),
      id: "bound-run",
    })),
    executions: record.value.state.executions.map((execution) => ({
      ...execution,
      captureRunId: "bound-run",
    })),
  });
  expect(saved.ok).toBe(true);
  const prepared = await runProductReviewRequest(await w.state(), { prepare: true, task: "T001" });
  if (!prepared.ok) throw new Error(prepared.error.message);
  const { session } = prepared.value as { session: string };
  await recordedProductJourney(w, "added-later");
  const submitted = await runProductReviewRequest(await w.state(), {
    session,
    assessments: [
      {
        outcome: "O001",
        status: "satisfied",
        summary: "Observed the interaction",
        evidence: [record.value.state.executions[0]?.id],
      },
    ],
  });
  if (!submitted.ok) throw new Error(submitted.error.message);
  const after = await readProductRecord(await w.state());
  if (!after.ok) throw new Error(after.error.message);
  expect(after.value.state.reviews.at(-1)?.assessments[0]).toMatchObject({
    status: "satisfied",
    evidence: [record.value.state.executions[0]?.id, ...captures.map((capture) => capture.id)],
  });
});

it("accepts prepared CHECK result citations as their canonical behavior execution", async () => {
  const w = await ready();
  const prepared = await runProductReviewRequest(await w.state(), { prepare: true, task: "T001" });
  if (!prepared.ok) throw new Error(prepared.error.message);
  const session = prepared.value as { session: string; packetPath: string };
  const packet = JSON.parse(await readFile(session.packetPath, "utf8"));
  const source = packet.sources.find((entry: { kind: string }) => entry.kind === "executed-check");
  expect(source).toBeDefined();
  expect(JSON.stringify(packet.responseSchema)).toContain(source.id);
  const submitted = await runProductReviewRequest(await w.state(), {
    session: session.session,
    task: "T001",
    detail: true,
    reviewer: { context: "fresh" },
    assessments: [
      {
        outcome: "O001",
        status: "satisfied",
        summary: "Executed behavior passes",
        evidence: [source.id],
        expectations: [],
      },
    ],
  });
  expect(submitted).toMatchObject({
    ok: true,
    value: { assessments: [{ status: "satisfied", evidence: [source.id.slice(6)] }] },
  });
});
