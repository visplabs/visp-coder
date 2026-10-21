import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EvidenceRecord } from "../../../src/workflow/product/evidence-record/record-types.js";
import { runProductReport } from "../../../src/workflow/product/index.js";
import { changeMapScenario } from "../../unit/support/change-map-scenario.js";
import { uiScenario, value } from "../../unit/support/ui-scenario.js";
import type { TestWorkspace } from "../../unit/support/workspace.js";

/** Features recorded by the real workflow; see the scenarios for what each one did. */
let mapped: { workspace: TestWorkspace; feature: string };
let dashboard: { workspace: TestWorkspace; accepted: string; active: string };

beforeAll(async () => {
  [mapped, dashboard] = await Promise.all([changeMapScenario(), uiScenario()]);
}, 240_000);

afterAll(async () => {
  await Promise.all([mapped?.workspace.destroy(), dashboard?.workspace.destroy()]);
});

async function report(workspace: TestWorkspace, feature: string) {
  const { markdown, record } = value(await runProductReport(await workspace.state(), { feature }));
  if (!record) throw new Error(`No evidence record for ${feature}`);
  return { markdown, record };
}

describe("visp pr evidence record, after edits that outdate every check", () => {
  let record: EvidenceRecord;
  let markdown: string;
  beforeAll(async () => {
    ({ record, markdown } = await report(mapped.workspace, mapped.feature));
  });

  it("verifies nothing: both checks ran only on an earlier version", () => {
    expect(record.summary).toMatchObject({ requirements: 2, verified: 0 });
    for (const entry of record.done) {
      expect(entry.status).toBe("unverified");
      expect(entry.checks.map((check) => check.result)).toEqual(["stale"]);
    }
  });

  it("lists both requirements, the open finding and the unscoped edit as not verified", () => {
    const refs = record.notVerified.map((gap) => `${gap.kind}:${gap.ref}`);
    expect(refs).toEqual(
      expect.arrayContaining([
        "requirement:O001",
        "requirement:O002",
        "out-of-scope:src/download.mjs",
      ]),
    );
    expect(record.notVerified.some((gap) => gap.kind === "finding")).toBe(true);
    expect(record.notVerified[0]?.severity).toBe("blocking");
  });

  it("reports scope declared against scope touched", () => {
    expect(record.changed.available).toBe(true);
    expect(record.changed.files.map((file) => file.path).sort()).toEqual([
      "src/csv.mjs",
      "src/download.mjs",
      "src/report.mjs",
    ]);
    expect(record.changed.scope.outside).toEqual(["src/download.mjs"]);
    expect(record.changed.scope.refusedEdits).toEqual({ recorded: false });
  });

  it("counts the time and the model calls VISP recorded", () => {
    expect(record.cost.checkRuns).toBeGreaterThan(0);
    expect(record.cost.modelCalls).toMatchObject({ reviewsRecorded: 1, worker: null });
    expect(record.cost.models).toContain("gpt-6-sol");
  });

  it("prints no passed result anywhere in the Done table", () => {
    const done = markdown.slice(markdown.indexOf("## Done"), markdown.indexOf("## Changed"));
    expect(done).not.toContain("passed");
    expect(done).toContain("stale");
  });

  it("fits about one screen", () => {
    expect(markdown.split("\n").length).toBeLessThan(80);
  });
});

describe("visp pr evidence record for an accepted feature", () => {
  it("shows the requirement verified by a current passing check", async () => {
    const { record } = await report(dashboard.workspace, dashboard.accepted);
    expect(record.lifecycle).toBe("accepted");
    expect(record.done).toEqual([
      expect.objectContaining({
        requirement: "O001",
        status: "verified",
        checks: [expect.objectContaining({ check: "C001", result: "passed", author: "worker" })],
      }),
    ]);
    expect(record.notVerified.filter((gap) => gap.severity === "blocking")).toEqual([]);
  });
});

describe("visp pr evidence record for a feature mid-flight", () => {
  it("puts the failing check and the required finding first", async () => {
    const { record, markdown } = await report(dashboard.workspace, dashboard.active);
    const blocking = record.notVerified.filter((gap) => gap.severity === "blocking");
    expect(blocking.map((gap) => gap.kind)).toEqual(
      expect.arrayContaining(["requirement", "finding"]),
    );
    expect(markdown.indexOf("## Not verified")).toBeLessThan(markdown.indexOf("## Asked"));
  });

  it("keeps the full handoff document behind --full", async () => {
    const state = await dashboard.workspace.state();
    const full = value(await runProductReport(state, { feature: dashboard.active, full: true }));
    expect(full.markdown).toContain("## Not verified");
    expect(full.markdown).toContain("## Independent review");
  });
});
