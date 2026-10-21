import { describe, expect, it } from "vitest";
import { checkEvidence } from "../../../../src/workflow/product/evidence-record/record-checks.js";
import { renderEvidenceRecord } from "../../../../src/workflow/product/evidence-record/record-markdown.js";
import {
  regressionGaps,
  regressionsFrom,
} from "../../../../src/workflow/product/evidence-record/record-regressions.js";
import type { EvidenceRecord } from "../../../../src/workflow/product/evidence-record/record-types.js";
import type { ProductCheck, ProductExecution } from "../../../../src/workflow/product/model.js";

const check: ProductCheck = {
  id: "C001",
  command: ["node", "--test", "test/total.test.mjs"],
  outcomes: ["O001"],
  files: [],
  environment: "node",
};

function run(overrides: Partial<ProductExecution>): ProductExecution {
  return {
    id: "E1",
    check: "C001",
    task: "T001",
    subjectDigest: "now",
    contractDigest: "contract",
    createdAt: "2026-10-21T10:00:00.000Z",
    command: "node --test test/total.test.mjs",
    status: "passed",
    exitCode: 0,
    durationMs: 120,
    output: "",
    provenance: "supervisor-executed",
    assertions: "agent-reported",
    ...overrides,
  };
}

const context = { author: "worker" as const, record: "visp verify --feature F --task T001" };

describe("checkEvidence", () => {
  it("never reports a pass recorded on an earlier version as passed", () => {
    const old = run({ subjectDigest: "before" });
    const evidence = checkEvidence(check, { current: [], all: [old] }, context);
    expect(evidence.result).toBe("stale");
    expect(evidence.ranAt).toBe(old.createdAt);
    expect(evidence.exitCode).toBeUndefined();
  });

  it("says not-run when no run is recorded", () => {
    expect(checkEvidence(check, { current: [], all: [] }, context).result).toBe("not-run");
  });

  it("reports a current failure in any slice over a pass in another", () => {
    const passed = run({ id: "E1", createdAt: "2026-10-21T10:05:00.000Z" });
    const failed = run({ id: "E2", task: "T002", status: "failed", exitCode: 1 });
    const evidence = checkEvidence(
      check,
      { current: [passed, failed], all: [passed, failed] },
      context,
    );
    expect(evidence).toMatchObject({ result: "failed", execution: "E2", exitCode: 1 });
  });

  it("gives the command to rerun by hand and the VISP command that records it", () => {
    const evidence = checkEvidence(check, { current: [run({})], all: [run({})] }, context);
    expect(evidence).toMatchObject({
      result: "passed",
      command: "node --test test/total.test.mjs",
      record: "visp verify --feature F --task T001",
      author: "worker",
      exercisesBehavior: true,
    });
  });

  it("marks a pass that also passes with the change reverted", () => {
    const vacuous = run({
      flip: {
        failsWithoutChange: false,
        revertedFiles: [],
        preservedValidationFiles: [],
        commands: [],
      },
    });
    const evidence = checkEvidence(check, { current: [vacuous], all: [vacuous] }, context);
    expect(evidence.failsWithoutChange).toBe(false);
  });
});

function record(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    version: 1,
    feature: "001-sum",
    lifecycle: "active",
    subjectDigest: "now",
    summary: { requirements: 1, verified: 0, judged: 0, failed: 0, unverified: 1, gaps: 1 },
    notVerified: [
      { kind: "requirement", severity: "blocking", ref: "O001", text: "C001 is stale" },
    ],
    asked: {
      request: "Sum the amounts.\nNot the rows.",
      requirements: [
        {
          id: "O001",
          statement: "The total is the sum",
          priority: "must",
          kind: "functional",
          provenance: "user-stated",
        },
      ],
      intentChanges: [],
    },
    done: [
      {
        requirement: "O001",
        status: "unverified",
        checks: [
          {
            check: "C001",
            author: "worker",
            result: "stale",
            exercisesBehavior: true,
            ranAt: "2026-10-21T10:00:00.000Z",
            command: "node --test test/total.test.mjs",
            record: "visp verify --feature 001-sum --task T001",
          },
        ],
        review: { status: "unassessed", source: "model-judgment", required: false },
      },
    ],
    suites: [],
    changed: {
      available: true,
      base: { ref: "abc^", how: "feature-start" },
      end: "working-tree",
      files: [
        {
          path: "src/total.mjs",
          status: "modified",
          added: 1,
          removed: 1,
          binary: false,
          slices: ["T001"],
          origin: "feature" as const,
        },
      ],
      totals: { files: 1, added: 1, removed: 1 },
      omittedFiles: 0,
      hiddenFiles: 0,
      scope: {
        declared: [{ slice: "T001", allowed: ["src/total.mjs"], forbidden: [] }],
        outside: [],
        overrides: [],
        refusedEdits: { recorded: false },
      },
    },
    regressions: {
      mode: "off",
      status: "not-run",
      regressions: [],
      unchecked: [],
      preExisting: 0,
      leftOut: 0,
    },
    cost: {
      startedAt: "2026-10-21T09:00:00.000Z",
      lastRecordAt: "2026-10-21T10:00:00.000Z",
      elapsedMs: 3_600_000,
      checkRuns: 2,
      checkTimeMs: 240,
      modelCalls: { reviewerLaunched: 0, reviewsRecorded: 0, testerSessions: 0, worker: null },
      models: [],
    },
    outsideAccess: { webSearches: [], testerNetworkCommands: 0 },
    next: { objective: "Run the checks again", command: "visp done --feature 001-sum" },
    readAt: "2026-10-21T10:00:00.000Z",
    ...overrides,
  };
}

describe("renderEvidenceRecord", () => {
  it("puts what is not verified before the request", () => {
    const text = renderEvidenceRecord(record());
    expect(text.indexOf("## Not verified")).toBeGreaterThan(-1);
    expect(text.indexOf("## Not verified")).toBeLessThan(text.indexOf("## Asked"));
    expect(text).toContain("**O001**");
  });

  it("quotes the request verbatim, line by line", () => {
    expect(renderEvidenceRecord(record())).toContain("> Sum the amounts.\n> Not the rows.");
  });

  it("shows a stale run as stale, with when it last ran, never as passed", () => {
    const row = renderEvidenceRecord(record())
      .split("\n")
      .find((line) => line.startsWith("| O001"));
    expect(row).toContain("stale");
    expect(row).not.toContain("passed");
    expect(row).toContain("`node --test test/total.test.mjs`");
  });

  it("labels a reviewer's verdict as a model's judgment", () => {
    const judged = record({
      done: [
        {
          requirement: "O001",
          status: "judged",
          checks: [],
          review: {
            status: "satisfied",
            source: "model-judgment",
            reviewer: "gpt-6-sol",
            required: true,
          },
        },
      ],
    });
    const row = renderEvidenceRecord(judged)
      .split("\n")
      .find((line) => line.startsWith("| O001"));
    expect(row).toContain("no executed check");
    expect(row).toContain("judged satisfied by gpt-6-sol (model)");
  });

  it("says so plainly when nothing is left unverified", () => {
    const text = renderEvidenceRecord(record({ notVerified: [] }));
    expect(text).toContain("## Not verified\n\nNothing");
  });

  it("names the unmeasured worker calls instead of printing zero", () => {
    expect(renderEvidenceRecord(record())).toContain("worker calls not measured");
  });

  it("lists every reviewer web search and counts the tester's networked commands", () => {
    const text = renderEvidenceRecord(
      record({
        outsideAccess: {
          webSearches: [{ at: "2026-10-21T10:00:00.000Z", query: "RFC 4180 quoting" }],
          testerNetworkCommands: 3,
        },
      }),
    );
    expect(text).toContain("## Outside access");
    expect(text).toContain("RFC 4180 quoting");
    expect(text).toContain("3 commands with network access");
    expect(renderEvidenceRecord(record())).not.toContain("## Outside access");
  });

  it("keeps a long file list to one screen and counts the rest", () => {
    const files = Array.from({ length: 30 }, (_, index) => ({
      path: `src/f${index}.mjs`,
      status: "modified" as const,
      added: 1,
      removed: 0,
      binary: false,
      slices: ["T001"],
      origin: "feature" as const,
    }));
    const base = record();
    const text = renderEvidenceRecord(
      record({
        changed: { ...base.changed, files, totals: { files: 30, added: 30, removed: 0 } },
      }),
    );
    expect(text).toContain("src/f11.mjs");
    expect(text).not.toContain("src/f12.mjs");
    expect(text).toContain("18 more");
  });
});

describe("regressionsFrom", () => {
  const report = {
    version: 1 as const,
    feature: "001-sum",
    subjectDigest: "now",
    key: "k",
    status: "regression" as const,
    results: [
      {
        label: "C009",
        command: "node --test",
        status: "regression" as const,
        tests: [
          { name: "totals an empty report", status: "regression" as const, message: "got NaN" },
          {
            name: "renders a header",
            status: "unchecked" as const,
            message: "timeout",
            reason: "flaky: passed on a rerun",
          },
        ],
      },
    ],
    leftOut: [],
    selection: { linked: 1, earlierWork: 0, unlinked: 0 },
    durationMs: 900,
  };

  it("reports a regression on this version as blocking and a flaky failure as unchecked", () => {
    const regressions = regressionsFrom({ mode: "gate", report }, "now");
    expect(regressions).toMatchObject({
      status: "regression",
      regressions: ["C009 › totals an empty report: got NaN"],
      unchecked: ["C009 › renders a header: flaky: passed on a rerun"],
    });
    expect(regressionGaps(regressions).map((gap) => [gap.kind, gap.severity])).toEqual([
      ["regression", "blocking"],
      ["flaky", "attention"],
    ]);
    expect(renderEvidenceRecord(record({ regressions }))).toContain(
      "**Regression** (gate mode): 1 command (1 linked to the change",
    );
  });

  it("calls a report from an earlier version stale, with no verdicts", () => {
    const regressions = regressionsFrom({ mode: "advise", report }, "later");
    expect(regressions).toMatchObject({ status: "stale", regressions: [], unchecked: [] });
  });
});
