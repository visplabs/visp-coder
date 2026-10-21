import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { vispError } from "../../../src/core/errors.js";
import { err, ok } from "../../../src/core/result.js";
import { productReply } from "../../../src/mcp/tools/workflow.js";

it.each(["completed", "failed", "timed-out", "cancelled"])(
  "keeps capture %s and complete evidence readable without repeating the full JSON",
  (status) => {
    const data = {
      status,
      runId: "CAPRUN-current",
      operations: 24,
      ...(status === "completed"
        ? {}
        : {
            failure: {
              kind: "behavior",
              message: "Observed missing scrollWidth attribute",
              actionIndex: 2,
            },
          }),
      captures: Array.from({ length: 6 }, (_, index) => ({
        id: `CAP-${index}`,
        path: `.visp/features/001-game/captures/CAP-${index}.png`,
        sha256: "a".repeat(64),
        subjectDigest: "b".repeat(64),
        steps: ["Navigate localhost", "Drag the bird", "Observe settled score"],
      })),
      images: [{ mimeType: "image/png", data: "YWJj" }],
      nextCommand: "visp review",
    };
    const compact = productReply("visp_capture", ok(data));
    const detailed = productReply("visp_capture", ok(data), true);
    expect(compact.structuredContent).toEqual(detailed.structuredContent);
    expect(compact.structuredContent?.data).toMatchObject({
      imageIds: ["CAP-0", "CAP-1", "CAP-2", "CAP-3", "CAP-4", "CAP-5"],
    });
    expect(compact.structuredContent?.data).not.toHaveProperty("images");
    expect(compact.content.filter((entry) => entry.type === "image")).toEqual(
      detailed.content.filter((entry) => entry.type === "image"),
    );
    const text = compact.content
      .flatMap((entry) => (entry.type === "text" ? [entry.text] : []))
      .join("\n");
    expect(text).toContain(status);
    expect(text).toContain("Next: visp_review");
    if (data.failure) expect(text).toContain(data.failure.message);
    expect(text).toBe(
      detailed.content.flatMap((entry) => (entry.type === "text" ? [entry.text] : [])).join("\n"),
    );
  },
);

it("retains full tool errors regardless of compact mode", () => {
  const result = err(
    vispError("EVIDENCE_FAILED", "Product changed during capture", {
      details: { paths: ["game.js"] },
    }),
  );
  const compact = productReply("visp_capture", result);
  expect(compact).toEqual(productReply("visp_capture", result, true));
  expect(compact.isError).toBe(true);
  expect(compact.content[0]).toMatchObject({ text: expect.stringContaining("game.js") });
});

it("gives text-only work consumers the objective, scope and next failing check", () => {
  const result = productReply(
    "visp_work",
    ok({
      feature: "001-game",
      task: "T001",
      mayEdit: true,
      objective: "Make the second shot work",
      scope: { allowed: ["game.mjs"], expected: ["game.mjs"], forbidden: ["tests/oracle.mjs"] },
      checks: [{ id: "C001", command: ["node", "test/game.mjs"] }],
      feedbackPlan: {
        nextCheck: "Hit a target, settle, then shoot again",
        findings: [{ problem: "The second shot stays locked", nextCheck: "Replay C001" }],
        gaps: ["repeat-and-recover: unassessed"],
      },
    }),
  );
  const visible = result.content
    .flatMap((entry) => (entry.type === "text" ? [entry.text] : []))
    .join("\n");
  for (const essential of [
    "Make the second shot work",
    "game.mjs",
    "tests/oracle.mjs",
    "C001",
    "second shot stays locked",
    "repeat-and-recover",
    "visp_work",
  ])
    expect(visible).toContain(essential);
});

it("routes next work through MCP and keeps one full copy of detail", () => {
  const next = productReply(
    "visp_next",
    ok({
      feature: "001-game",
      task: "T001",
      command: "visp work --feature 001-game --task T001",
      action: "work",
    }),
  );
  expect(next.structuredContent).toMatchObject({
    nextAction: { tool: "visp_work", arguments: { feature: "001-game", task: "T001" } },
  });
  expect(next.content[0]).toMatchObject({ text: expect.stringContaining("visp_work") });
  expect(next.content[0]).not.toMatchObject({ text: expect.stringContaining("Next: visp work") });
  const large = { feature: "001-game", files: [{ content: "x".repeat(20000) }] };
  const detailed = productReply("visp_work", ok(large), true);
  expect(JSON.stringify(detailed.content)).not.toContain("x".repeat(1000));
  expect(JSON.stringify(detailed.structuredContent)).toContain("x".repeat(1000));
});

it("makes a revoked brief grant and its recovery visible", () => {
  const result = productReply(
    "visp_brief",
    ok({
      feature: "001-game",
      outcomes: [],
      slices: [],
      authorizationRevoked: true,
      mayEdit: false,
      nextCommand: "visp work --feature 001-game --task T001",
    }),
  );
  const text = result.content
    .flatMap((entry) => (entry.type === "text" ? [entry.text] : []))
    .join("\n");
  expect(text).toContain('"authorizationRevoked":true');
  expect(text).toContain('"mayEdit":false');
  expect(text).toContain("visp_work");
});

it("preserves the prepared review session's usable handoff in text-only hosts", () => {
  const handoff = {
    session: "review-session",
    feature: "001-game",
    task: "T001",
    packetPath: "/project/.visp/reviews/packet.json",
    responsePath: "/project/.visp/reviews/response.json",
    command: "visp review --session review-session --from -",
    instructions: "Read the packet and actual images, then submit judgments.",
  };
  const result = productReply("visp_review", ok(handoff));
  const text = result.content
    .flatMap((entry) => (entry.type === "text" ? [entry.text] : []))
    .join("\n");
  for (const value of Object.values(handoff).filter((value) => value !== handoff.command))
    expect(text).toContain(value);
  expect(text).toContain("visp_review");
});

it("keeps environment recovery and retained critic feedback visible to text-only workers", () => {
  const data = {
    feature: "001-game",
    task: "T001",
    feedbackPlan: {
      capability: {
        status: "unavailable",
        detail: "Browser startup denied in this shell",
        recovery: "Use the supported VISP MCP capture in its authorized host context",
      },
    },
    criticUnderstanding: {
      status: "reviewed",
      callsRemaining: 1,
      guidance: "Keep the remaining call for the rendered product",
      findings: [{ problem: "Reset must cancel the older countdown" }],
    },
    journeyFeedback: {
      failures: [
        { runId: "CAPRUN-second-input", replay: "visp capture --replay CAPRUN-second-input" },
      ],
    },
    userFeedback: { findings: [{ problem: "Pause must freeze moving planes" }] },
    criticAdvice: { status: "suggested", command: "visp critic --preflight --capabilities -" },
  };
  const compact = productReply("visp_work", ok(data));
  const text = compact.content
    .flatMap((entry) => (entry.type === "text" ? [entry.text] : []))
    .join("\n");
  for (const essential of [
    "Browser startup denied",
    "VISP MCP capture",
    "remaining call",
    "older countdown",
    "CAPRUN-second-input",
    "Pause must freeze",
    "visp critic --preflight --capabilities -",
  ])
    expect(text).toContain(essential);
  expect(compact.structuredContent).toEqual(
    productReply("visp_work", ok(data), true).structuredContent,
  );
});

it("keeps capture replay identity and the committed next action visible in compact text", () => {
  const result = productReply(
    "visp_capture",
    ok({
      status: "timed-out",
      runId: "CAPRUN-repeat-input",
      replayCommand: "visp capture --replay CAPRUN-repeat-input",
      nextCommand: "visp critic --preflight --capabilities -",
      next: {
        action: "fix",
        reason: "Repeated input timed out",
        criticAdvice: { status: "suggested", command: "visp critic --preflight --capabilities -" },
      },
    }),
  );
  const text = result.content
    .flatMap((entry) => (entry.type === "text" ? [entry.text] : []))
    .join("\n");
  for (const value of [
    "CAPRUN-repeat-input",
    "visp capture --replay",
    "Repeated input timed out",
    "visp_critic",
  ])
    expect(text).toContain(value);
});

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../fixtures/product-replies/${name}.json`, import.meta.url), "utf8"),
  );
const textOf = (reply: ReturnType<typeof productReply>) =>
  reply.content.flatMap((entry) => (entry.type === "text" ? [entry.text] : [])).join("\n");

it("keeps a closed slice's reply short while retaining the next quality step", () => {
  const data = fixture("done-closed");
  const compact = productReply("visp_done", ok(data));
  const detailed = productReply("visp_done", ok(data), true);
  expect(compact.structuredContent).toEqual(detailed.structuredContent);
  const text = textOf(compact);
  expect(text).toBe(textOf(detailed));
  expect(text.length).toBeLessThan(JSON.stringify(data).length / 4);
  expect(text).toContain('"closed":true');
  expect(text).toContain("C001: passed");
  expect(text).toContain(data.next.objective);
  expect(text).toContain("Next: visp_review");
});

it("keeps the reason an unresolved slice cannot close", () => {
  const text = textOf(productReply("visp_done", ok(fixture("done-unresolved"))));
  expect(text).toContain("unresolved-product");
  expect(text).toContain("__pycache__/sentiment_api.cpython-310.pyc");
  expect(text).toContain("O001: behavior unassessed; review unassessed");
});

it("keeps the end of a failing check's output", () => {
  const data = fixture("done-closed");
  const failing = {
    ...data,
    passed: false,
    closed: false,
    executions: [
      {
        ...data.executions[0],
        status: "failed",
        exitCode: 1,
        output: `${"setup noise\n".repeat(400)}AssertionError: expected 2, received 1`,
      },
    ],
  };
  const text = textOf(productReply("visp_done", ok(failing)));
  expect(text).toContain("AssertionError: expected 2, received 1");
  expect(text).toContain('"exitCode":1');
  expect(text.length).toBeLessThan(6_000);
});

it("acknowledges a brief update with identifiers and normalizations instead of the whole brief", () => {
  const brief = fixture("done-closed");
  const updated = {
    version: 2,
    feature: brief.feature,
    incomplete: false,
    originalRequest: "x".repeat(2_000),
    goal: "Serve sentiment",
    outcomes: brief.outcomes.map((outcome: { id: string; statement: string }) => ({
      id: outcome.id,
      kind: "functional",
      statement: outcome.statement,
      priority: "must",
      provenance: "agent-proposed",
      reviewRequired: false,
      expectations: [],
    })),
    examples: [],
    decisions: [],
    uncertainties: [],
    checks: [{ id: "C001", command: "python3 -m unittest", outcomes: ["O001"], files: [] }],
    slices: [
      {
        id: "T001",
        goal: "Serve one request",
        outcomes: ["O001"],
        dependsOn: [],
        scope: { allowed: ["api.py"], expected: [], forbidden: [] },
        checks: ["C001"],
        approach: "",
      },
    ],
    acceptanceBaseline: [],
    normalized: ["examples[0].then → expected"],
  };
  const compact = productReply("visp_brief", ok(updated));
  const text = textOf(compact);
  expect(compact.structuredContent).toEqual(
    productReply("visp_brief", ok(updated), true).structuredContent,
  );
  expect(text).not.toContain("x".repeat(100));
  expect(text).toContain("T001");
  expect(text).toContain("examples[0].then → expected");
  expect(text).toContain("Next: visp_next");
});

it("keeps the next step's findings once and drops the repeated critic list", () => {
  const finding = `FB-1: functional: ${"Wrong-method routing is incomplete. ".repeat(20)}`;
  const data = {
    feature: "001-api",
    task: "T001",
    action: "fix",
    objective: "Reopen the implicated slice",
    command: "visp work --feature 001-api --task T001",
    evidence: [finding, finding, "O001: behavior passed; review failed"],
    mayEdit: true,
    criticAdvice: {
      status: "feedback",
      guidance: "Use the recorded findings",
      findings: [{ problem: finding, nextCheck: "GET /v1/sentiment" }],
    },
  };
  const compact = productReply("visp_next", ok(data));
  const text = textOf(compact);
  expect(compact.structuredContent).toEqual(
    productReply("visp_next", ok(data), true).structuredContent,
  );
  expect(text).toContain('"action":"fix"');
  expect(text).toContain("visp_work");
  expect(text).toContain("O001: behavior passed; review failed");
  expect(text.split("Wrong-method routing").length - 1).toBeLessThanOrEqual(20);
  expect(text).toBe(textOf(productReply("visp_next", ok(data), true)));
});

it("shows a check's full command and leaves browser guidance out of non-browser work", () => {
  const data = {
    feature: "001-api",
    task: "T001",
    objective: "Serve",
    mayEdit: true,
    scope: { allowed: ["server.py"], expected: [], forbidden: [] },
    checks: [
      {
        id: "C1",
        command: ["python3", "-m", "unittest", "discover", "-s", "tests", "-v"],
        outcomes: ["O1"],
      },
    ],
    notes: ["Graph uncertainty: json.loads", "Scope comes from the brief"],
    feedbackPlan: {
      observationPlan: { session: "For browser checks: use the same browser session" },
    },
  };
  const text = textOf(productReply("visp_work", ok(data)));
  expect(text).toContain('["python3","-m","unittest","discover","-s","tests","-v"]');
  expect(text).not.toContain("For browser checks");
  expect(text).not.toContain("Graph uncertainty");
  expect(text).toContain("Scope comes from the brief");
});
