import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

type Comment = {
  id: string;
  author: string;
  updateAuthor: string;
  created: string;
  updated: string;
  text: string;
};
type Approval = {
  approved: boolean;
  reason?: string;
  comment?: string;
  skipped?: Array<{ comment: string; reason: string }>;
};

const lib = (name: string) => pathToFileURL(join(process.cwd(), "scripts/sdlc/lib", name)).href;
const { approvalLine, checkApproval } = (await import(lib("approval.mjs"))) as {
  approvalLine(feature: string, hash: string): string;
  checkApproval(input: {
    feature: string;
    hash: string;
    ownerId: string;
    comments: Comment[];
    bodyChangedAt?: string;
  }): Approval;
};
const { adfToBody, bodyToAdf } = (await import(lib("adf.mjs"))) as {
  adfToBody(adf: unknown): string;
  bodyToAdf(body: string): unknown;
};
const { newFeatureBody, ownerTextOf, specMarkdown, withSpec } = (await import(
  lib("issue-body.mjs")
)) as {
  newFeatureBody(words: string): string;
  ownerTextOf(body: string): string | undefined;
  specMarkdown(feature: string, title: string, spec: unknown): string;
  withSpec(body: string, spec: string): string;
};
const { yamlBlocks } = (await import(lib("yaml-blocks.mjs"))) as {
  yamlBlocks(body: string): Array<Record<string, unknown>>;
};

const OWNER = "owner-1";
const HASH = "a".repeat(64);
const OLD_HASH = "b".repeat(64);

function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: "c1",
    author: OWNER,
    updateAuthor: OWNER,
    created: "2026-11-07T12:00:00.000+0000",
    updated: "2026-11-07T12:00:00.000+0000",
    text: approvalLine("VISP-12", HASH),
    ...overrides,
  };
}

function check(comments: Comment[], bodyChangedAt = "2026-11-07T11:00:00.000+0000") {
  return checkApproval({ feature: "VISP-12", hash: HASH, ownerId: OWNER, comments, bodyChangedAt });
}

describe("spec approval from Jira comments", () => {
  it("accepts the owner's unedited comment naming the current hash, after the last spec edit", () => {
    expect(check([comment()])).toMatchObject({ approved: true, comment: "c1" });
  });

  it.each([
    ["no approval comment", [comment({ text: "Looks good to me" })], "has not approved"],
    [
      "a comment by someone else",
      [comment({ author: "bot-1", updateAuthor: "bot-1" })],
      "not written by the owner",
    ],
    ["an edited comment", [comment({ updated: "2026-11-07T12:05:00.000+0000" })], "edited"],
    ["a comment edited by an admin", [comment({ updateAuthor: "admin-1" })], "edited"],
    [
      "an approval of an older spec",
      [comment({ text: approvalLine("VISP-12", OLD_HASH) })],
      "spec changed",
    ],
    [
      "an approval for another epic",
      [comment({ text: approvalLine("VISP-99", HASH) })],
      "has not approved",
    ],
  ])("refuses %s", (_name, comments, reason) => {
    const result = check(comments);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain(reason);
  });

  it("refuses an approval older than the last change to the epic's description", () => {
    const result = check([comment()], "2026-11-07T12:30:00.000+0000");
    expect(result).toMatchObject({ approved: false });
    expect(result.reason).toContain("description changed");
  });

  it("prints a short line of the first 12 hash characters", () => {
    expect(approvalLine("VISP-12", HASH)).toBe(`SDLC approval VISP-12 spec ${HASH.slice(0, 12)}`);
  });

  it.each([
    ["the short line", approvalLine("VISP-12", HASH)],
    ["the full hash", `SDLC approval VISP-12 spec ${HASH}`],
    ["spaces a paste brings around the line", `  ${approvalLine("VISP-12", HASH)} \n`],
    ["a no-break space before the line", `\u00a0${approvalLine("VISP-12", HASH)}`],
  ])("accepts %s", (_name, text) => {
    expect(check([comment({ text })])).toMatchObject({ approved: true });
  });

  it("refuses a hash shorter than 12 characters", () => {
    const text = `SDLC approval VISP-12 spec ${HASH.slice(0, 11)}`;
    expect(check([comment({ text })]).approved).toBe(false);
  });

  it("lists every approval-like comment it passed over, with the reason", () => {
    const bot = comment({ id: "c1", author: "bot-1", updateAuthor: "bot-1" });
    const edited = comment({ id: "c2", updated: "2026-11-07T12:05:00.000+0000" });
    const result = check([bot, edited]);
    expect(result.approved).toBe(false);
    expect(result.skipped).toEqual([
      { comment: "c2", reason: expect.stringContaining("edited") },
      { comment: "c1", reason: expect.stringContaining("not written by the owner") },
    ]);
  });

  it("uses the newest valid approval when an older one went stale", () => {
    const stale = comment({ id: "c1", text: approvalLine("VISP-12", OLD_HASH) });
    const fresh = comment({
      id: "c2",
      created: "2026-11-07T13:00:00.000+0000",
      updated: "2026-11-07T13:00:00.000+0000",
    });
    expect(check([stale, fresh])).toMatchObject({ approved: true, comment: "c2" });
  });
});

describe("issue bodies through Jira's document format", () => {
  const words =
    'Keep a work log.\n\n  Indented, with "quotes", `ticks` and café ✓   \n<b>not html</b>';
  const spec = {
    intent: {
      schema: "intent@1",
      feature: "VISP-12",
      owner_text: words,
      clauses: [{ id: "I-01", text: "Entries: one file each", kind: "must" }],
    },
    acceptance: {
      schema: "acceptance@1",
      feature: "VISP-12",
      criteria: [
        { id: "AC-01", clauses: ["I-01"], given: "g", when: "w", expect: "e", level: "unit" },
      ],
    },
    testCases: {
      schema: "test-cases@1",
      feature: "VISP-12",
      cases: [{ id: "TC-01", title: "t", criteria: ["AC-01"] }],
    },
  };

  it("keeps the owner's words and the spec blocks exactly", () => {
    const body = withSpec(newFeatureBody(words), specMarkdown("VISP-12", "Work log", spec));
    const back = adfToBody(JSON.parse(JSON.stringify(bodyToAdf(body))));
    expect(ownerTextOf(back)).toBe(words);
    expect(yamlBlocks(back).map((block) => block.schema)).toEqual([
      "intent@1",
      "acceptance@1",
      "test-cases@1",
    ]);
    expect(yamlBlocks(back)[0]?.owner_text).toBe(words);
  });

  it("replaces the spec section again after a round trip", () => {
    const first = adfToBody(bodyToAdf(withSpec(newFeatureBody(words), "old spec")));
    const second = adfToBody(bodyToAdf(withSpec(first, "new spec")));
    expect(second).toContain("new spec");
    expect(second).not.toContain("old spec");
    expect(ownerTextOf(second)).toBe(words);
  });

  it("finds the owner's words when Jira drops the code block's language", () => {
    const adf = bodyToAdf(newFeatureBody(words)) as { content: Array<{ attrs?: object }> };
    for (const node of adf.content) delete node.attrs;
    expect(ownerTextOf(adfToBody(adf))).toBe(words);
  });
});
