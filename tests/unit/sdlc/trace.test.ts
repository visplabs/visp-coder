import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

type Problem = { severity: "error" | "warning"; kind: string; message: string };
type Report = { problems: Problem[]; clauses: Array<{ id: string; status: string }> };
type Spec = {
  intent: { clauses: Array<{ id: string; text: string; kind: string }> };
  acceptance: { criteria: Array<{ id: string; clauses: string[]; level: string }> };
  testCases: { cases: Array<{ id: string; criteria: string[]; test?: string }> };
};
const { trace, resultsIndex } = (await import(
  pathToFileURL(join(process.cwd(), "scripts/sdlc/lib/trace.mjs")).href
)) as {
  trace(spec: Spec, results?: Map<string, string>): Report;
  resultsIndex(report: unknown, root: string): Map<string, string>;
};

function spec(overrides: Partial<Spec> = {}): Spec {
  return {
    intent: {
      clauses: [
        { id: "I-01", text: "files per entry", kind: "must" },
        { id: "I-02", text: "timestamps in names", kind: "should" },
        { id: "I-03", text: "no network in hooks", kind: "must_not" },
      ],
    },
    acceptance: {
      criteria: [
        { id: "AC-01", clauses: ["I-01"], level: "unit" },
        { id: "AC-02", clauses: ["I-02"], level: "unit" },
      ],
    },
    testCases: {
      cases: [
        { id: "TC-01", criteria: ["AC-01"], test: "tests/a.test.ts > a > one" },
        { id: "TC-02", criteria: ["AC-02"], test: "tests/a.test.ts > a > two" },
      ],
    },
    ...overrides,
  };
}

const kinds = (report: Report) => report.problems.map((problem) => problem.kind);
const status = (report: Report, id: string) => report.clauses.find((c) => c.id === id)?.status;

describe("sdlc trace", () => {
  it("finds no problem in a complete spec and plans every clause", () => {
    const report = trace(spec());
    expect(report.problems).toEqual([]);
    expect(status(report, "I-01")).toBe("planned");
    expect(status(report, "I-03")).toBe("not applicable");
  });

  it("reports a must clause without criteria as a gap and a should clause as a warning", () => {
    const report = trace(spec({ acceptance: { criteria: [] }, testCases: { cases: [] } }));
    expect(report.problems).toContainEqual(
      expect.objectContaining({ kind: "gap", severity: "error" }),
    );
    expect(report.problems).toContainEqual(
      expect.objectContaining({ kind: "gap", severity: "warning" }),
    );
    expect(status(report, "I-01")).toBe("missing");
  });

  it("reports criteria no clause asked for, unknown references and duplicates", () => {
    const report = trace(
      spec({
        acceptance: {
          criteria: [
            { id: "AC-01", clauses: ["I-01"], level: "unit" },
            { id: "AC-01", clauses: [], level: "unit" },
            { id: "AC-03", clauses: ["I-09"], level: "unit" },
          ],
        },
        testCases: { cases: [{ id: "TC-01", criteria: ["AC-01", "AC-07"] }] },
      }),
    );
    expect(kinds(report)).toEqual(
      expect.arrayContaining(["duplicate", "scope", "dangling", "untested"]),
    );
  });

  it("uses test results to mark clauses delivered, partial or failing", () => {
    const passing = new Map([
      ["tests/a.test.ts > a > one", "passed"],
      ["tests/a.test.ts > a > two", "passed"],
    ]);
    expect(status(trace(spec(), passing), "I-01")).toBe("delivered");

    const failing = new Map([["tests/a.test.ts > a > one", "failed"]]);
    const report = trace(spec(), failing);
    expect(status(report, "I-01")).toBe("open");
    expect(kinds(report)).toContain("failing");
    expect(report.problems.find((p) => p.kind === "failing")?.message).toContain("TC-02");
  });

  it("reads a vitest JSON report into test keys relative to the repository", () => {
    const index = resultsIndex(
      {
        testResults: [
          {
            name: "/repo/tests/a.test.ts",
            assertionResults: [{ ancestorTitles: ["a"], title: "one", status: "passed" }],
          },
        ],
      },
      "/repo",
    );
    expect(index.get("tests/a.test.ts > a > one")).toBe("passed");
  });
});
