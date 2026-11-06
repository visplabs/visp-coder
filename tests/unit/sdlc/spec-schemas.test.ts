import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

type Validation = { ok: true; value: unknown } | { ok: false; errors: string[] };
const { validateDocument } = (await import(
  pathToFileURL(join(process.cwd(), "scripts/sdlc/schemas/index.mjs")).href
)) as { validateDocument(doc: unknown): Validation };
const { yamlBlocks } = (await import(
  pathToFileURL(join(process.cwd(), "scripts/sdlc/lib/yaml-blocks.mjs")).href
)) as { yamlBlocks(markdown: string): Array<Record<string, unknown>> };

const intent = {
  schema: "intent@1",
  feature: "F-12",
  owner_text: "Work log entries are separate timestamped files.",
  clauses: [{ id: "I-01", text: "Work log entries are separate files", kind: "must" }],
};

const envelope = {
  id: "T-13-review-20261102T101530Z",
  feature: "F-12",
  task: "T-13",
  agent: "reviewer",
  created_at: "2026-11-02T10:15:30Z",
  status: "done",
};

function errorsOf(doc: unknown): string[] {
  const result = validateDocument(doc);
  return result.ok ? [] : result.errors;
}

describe("sdlc schemas", () => {
  it("accepts a valid intent, acceptance and test-case set", () => {
    expect(errorsOf(intent)).toEqual([]);
    expect(
      errorsOf({
        schema: "acceptance@1",
        feature: "F-12",
        criteria: [
          {
            id: "AC-01",
            clauses: ["I-01"],
            given: "an agent finishes a stage",
            when: "the stop hook runs",
            expect: "one new worklog file exists",
            level: "integration",
          },
        ],
      }),
    ).toEqual([]);
    expect(
      errorsOf({
        schema: "test-cases@1",
        feature: "F-12",
        cases: [
          {
            id: "TC-01",
            title: "stop hook writes one file",
            criteria: ["AC-01"],
            test: "tests/unit/sdlc/worklog.test.ts > worklog > writes one file",
          },
        ],
      }),
    ).toEqual([]);
  });

  it("names the field that is wrong", () => {
    const errors = errorsOf({ ...intent, clauses: [{ id: "1", text: "x", kind: "maybe" }] });
    expect(errors.some((error) => error.startsWith("clauses.0.id"))).toBe(true);
    expect(errors.some((error) => error.startsWith("clauses.0.kind"))).toBe(true);
  });

  it("rejects unknown fields and unknown schemas", () => {
    expect(errorsOf({ ...intent, extra: true }).length).toBeGreaterThan(0);
    expect(errorsOf({ schema: "plan@9" })[0]).toContain('unknown schema "plan@9"');
  });

  it("requires a citation and runnable evidence for a blocking review finding", () => {
    const review = (finding: Record<string, unknown>) => ({
      ...envelope,
      schema: "review@1",
      body: { verdict: "changes_requested", findings: [finding] },
    });
    expect(
      errorsOf(
        review({
          id: "R-1",
          severity: "blocking",
          cites: "AC-01",
          text: "no file is written",
          evidence: { command: "pnpm exec vitest run tests/unit/sdlc/worklog.test.ts" },
        }),
      ),
    ).toEqual([]);
    expect(
      errorsOf(review({ id: "R-1", severity: "blocking", cites: "AC-01", text: "no file" })),
    ).not.toEqual([]);
    expect(errorsOf(review({ id: "R-2", severity: "advisory", text: "rename x" }))).toEqual([]);
  });

  it("validates a handoff envelope", () => {
    const handoff = {
      ...envelope,
      schema: "handoff@1",
      agent: "coder",
      body: {
        summary: "Adds the worklog writer",
        changed_files: ["scripts/sdlc/lib/worklog.mjs"],
        tests: [{ criterion: "AC-01", test: "tests/unit/sdlc/worklog.test.ts > writes one file" }],
      },
    };
    expect(errorsOf(handoff)).toEqual([]);
    expect(errorsOf({ ...handoff, created_at: "yesterday" })).not.toEqual([]);
  });
});

describe("yaml blocks in an issue body", () => {
  it("returns blocks that name a schema and skips the rest", () => {
    const body = [
      "Some prose.",
      "```yaml",
      "schema: intent@1",
      "feature: F-12",
      "```",
      "```yaml",
      "just: config",
      "```",
      "```js",
      "schema: 'not yaml'",
      "```",
    ].join("\r\n");
    expect(yamlBlocks(body)).toEqual([{ schema: "intent@1", feature: "F-12" }]);
  });

  it("says which block does not parse", () => {
    expect(() => yamlBlocks("```yaml\nschema: [unclosed\n```\n")).toThrow(/yaml block 1/);
  });
});
