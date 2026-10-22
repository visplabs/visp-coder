import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { balancedCritic, CRITIC_MAX_CALLS } from "../../../../src/config/critic.js";
import {
  productExecutionEnvironment,
  resolvedProductExecutionEnvironment,
} from "../../../../src/core/execution-environment.js";
import {
  type CriticPacket,
  runProductCritic,
} from "../../../../src/workflow/product/critic/critic.js";
import { currentReviewGap } from "../../../../src/workflow/product/critic/critic-packet.js";
import { criticSelection } from "../../../../src/workflow/product/critic/critic-store.js";
import { browserEnvironmentIdentity } from "../../../../src/workflow/product/environment.js";
import {
  runProductContext,
  runProductDone,
  runProductNext,
  runProductVerify,
  runProductWork,
  updateProductBrief,
} from "../../../../src/workflow/product/index.js";
import {
  independentJudgments,
  independentReviewJsonSchema,
  independentReviewSchema,
} from "../../../../src/workflow/product/review/independent-review.js";
import {
  parseReviewSubmission,
  runProductReviewRequest,
} from "../../../../src/workflow/product/review/review-request.js";
import { independentReviewGaps } from "../../../../src/workflow/product/review/reviewer-handoff.js";
import { productWorkspace } from "../../support/product-workspace.js";

const projects: Awaited<ReturnType<typeof productWorkspace>>[] = [];
it("summarizes obsolete image notices while retaining current evidence failures and raw history", () => {
  const current = [
    "CAP-current: image bytes changed",
    "CAP-missing: capture file is missing",
    "No intact image of the current product was delivered for review",
  ];
  const gaps = [
    ...Array.from(
      { length: 50 },
      (_, index) => `CAP-${index}: capture describes a different product version`,
    ),
    ...current,
  ];
  const before = [...gaps];
  const result = independentReviewGaps(gaps);
  expect(result.slice(0, 3)).toEqual(current);
  expect(result).toHaveLength(4);
  expect(result[3]).toContain("50 historical capture(s)");
  expect(independentReviewGaps(current)).toEqual(current);
  expect(gaps).toEqual(before);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const p of projects.splice(0)) await p.workspace.destroy();
});
const config = balancedCritic("codex");
if (!config) throw new Error("preset missing");
const capabilities = {
  harness: "codex",
  model: config.model,
  reasoningEffort: "high",
  freshContext: true,
  images: true,
  readOnly: true,
  delegationAllowed: true,
} as const;
async function prepared(verifier = false, maxCalls = CRITIC_MAX_CALLS) {
  const p = await productWorkspace({ critic: true });
  projects.push(p);
  if (verifier) {
    const updated = await updateProductBrief(await p.workspace.state(), {
      brief: {
        ...p.brief,
        checks: p.brief.checks.map((check) => ({
          ...check,
          verifierFiles: ["test/value.test.mjs"],
        })),
      },
      reason: "Identify the assertion used to assess counterevidence",
    });
    if (!updated.ok) throw new Error(updated.error.message);
  }
  expect((await runProductWork(await p.workspace.state(), { task: "T001" })).ok).toBe(true);
  await p.workspace.write(
    "src/value.mjs",
    "// Important behavior is supplied in full, not just the first excerpt.\nexport const value = 2;\n",
  );
  expect((await runProductVerify(await p.workspace.state(), { task: "T001" })).ok).toBe(true);
  const run = async (options: object) => {
    const workspace = await p.workspace.state();
    return runProductCritic(workspace, { task: "T001", ...options });
  };
  expect((await run({ operation: "configure", config: { ...config, maxCalls } })).ok).toBe(true);
  const result = await run({
    operation: "prepare",
    capabilities,
    question: "Does the public value fulfill the request?",
  });
  if (!result.ok) throw new Error(result.error.message);
  const native = result.value as {
    attempt: string;
    packetPath: string;
    responseSchemaPath: string;
    codexCli: { args: string[] };
  };
  const packet = JSON.parse(await readFile(native.packetPath, "utf8")) as CriticPacket;
  return { p, run, native, packet };
}
function response(packet: CriticPacket) {
  return {
    summary: "Inspected the public value and its recorded execution.",
    assessments: packet.current.outcomes.map((o) => ({
      outcome: o.id,
      status: "satisfied",
      summary: "The exported value is 2.",
      evidence: [
        packet.current.evidence.find(
          (entry) => entry.kind === "execution" && entry.status === "available",
        )?.id ?? "C001",
      ],
      expectations: [],
    })),
    findings: [],
    limitations: ["No performance benchmark was requested or performed."],
    resolutions: [],
  };
}
it("binds a compact native response to tool-owned identity and uses the actual response validator as provider schema", async () => {
  const { p, run, native, packet } = await prepared();
  expect(packet.question).toBe("Does the public value fulfill the request?");
  for (const key of ["feedbackPlan", "agenda", "previousFindings", "challenges", "recurrence"])
    expect(packet.current).not.toHaveProperty(key);
  expect(packet).not.toHaveProperty("previous");
  expect(packet.current.sources.some((s) => s.kind === "authored-brief")).toBe(false);
  expect(packet.current.sources.find((s) => s.reference === "src/value.mjs")?.excerpt).toContain(
    "export const value = 2",
  );
  expect(JSON.parse(await readFile(native.responseSchemaPath, "utf8"))).toEqual(
    packet.responseSchema,
  );
  expect(native.codexCli.args).toContain("--output-schema");
  const reply = response(packet);
  expect(independentReviewSchema.safeParse(reply).success).toBe(true);
  expect(
    await run({ operation: "submit", attempt: native.attempt, capabilities, response: reply }),
  ).toMatchObject({ ok: true, value: { action: "normal-acceptance", callsUsed: 1 } });
  expect(await runProductDone(await p.workspace.state(), { task: "T001" })).toMatchObject({
    ok: true,
    value: { closed: true },
  });
});
it("does not turn zero findings into passing unassessed outcomes", async () => {
  const { run, native, packet } = await prepared();
  expect(
    await run({
      operation: "submit",
      attempt: native.attempt,
      capabilities,
      response: { ...response(packet), assessments: [] },
    }),
  ).toMatchObject({ ok: true, value: { action: "worker" } });
});
it("keeps current UI review unavailable when only an old candidate contains images", async () => {
  const { p, packet } = await prepared();
  const selected = await criticSelection(await p.workspace.state(), { task: "T001" });
  if (!selected.ok) throw new Error(selected.error.message);
  const outcome = selected.value.record.brief.outcomes[0];
  if (!outcome) throw new Error("outcome missing");
  outcome.kind = "experience";
  selected.value.record.brief.goal = "Render the public value in a browser";
  const oldOnly = {
    ...packet,
    current: { ...packet.current, images: [] },
    previous: { images: [{ data: "old" }] },
  };
  expect(currentReviewGap(oldOnly, selected.value)).toContain("no call spent");
  expect(
    currentReviewGap(
      {
        ...packet,
        current: { ...packet.current, images: [{} as CriticPacket["current"]["images"][number]] },
      },
      selected.value,
    ),
  ).toBeUndefined();
});
it("does not require browser images for a backend experience outcome", async () => {
  const { p, packet } = await prepared();
  const selected = await criticSelection(await p.workspace.state(), { task: "T001" });
  if (!selected.ok) throw new Error(selected.error.message);
  const outcome = selected.value.record.brief.outcomes[0];
  if (!outcome) throw new Error("outcome missing");
  outcome.kind = "experience";
  outcome.statement = "The public API is straightforward to call and diagnose";
  expect(currentReviewGap(packet, selected.value)).toBeUndefined();
});
it("requires current images for an executed browser contract without an experience label", async () => {
  const { p, packet } = await prepared();
  const selected = await criticSelection(await p.workspace.state(), { task: "T001" });
  if (!selected.ok) throw new Error(selected.error.message);
  const check = selected.value.record.brief.checks[0];
  if (!check) throw new Error("check missing");
  check.command = {
    kind: "browser-journey",
    journey: { url: "http://127.0.0.1:8123", actions: [] },
  };
  expect(currentReviewGap(packet, selected.value)).toContain("no call spent");
});
it("uses the same judgment parser for prepared sessions without category or example ledgers", async () => {
  const { p, packet } = await prepared();
  const preparedSession = await runProductReviewRequest(await p.workspace.state(), {
    task: "T001",
    prepare: true,
  });
  if (!preparedSession.ok) throw new Error(preparedSession.error.message);
  const session = preparedSession.value as { session: string; packetPath: string };
  const input = JSON.parse(await readFile(session.packetPath, "utf8"));
  expect(input).not.toHaveProperty("feedbackPlan");
  expect(input).not.toHaveProperty("previousFindings");
  const reply = response(packet);
  reply.assessments.forEach((assessment) => {
    assessment.evidence = [
      input.evidence.find(
        (entry: { kind: string; status: string }) =>
          entry.kind === "execution" && entry.status === "available",
      ).id,
    ];
  });
  const judgments = parseReviewSubmission(reply, session.session);
  if (!judgments.ok) throw new Error(judgments.error.message);
  expect(judgments.value.feedback?.dimensions).toEqual([]);
  expect(
    await runProductReviewRequest(await p.workspace.state(), {
      task: "T001",
      session: session.session,
      ...judgments.value,
    }),
  ).toMatchObject({ ok: true, value: { recorded: true } });
});

it("rejects invented finding fields instead of treating malformed feedback as a review", () => {
  const raw = {
    summary: "Observed the game",
    assessments: [],
    findings: [
      {
        title: "Band still attached",
        severity: "high",
        summary: "The released bird remains connected",
      },
    ],
    limitations: [],
    resolutions: [],
  };
  expect(independentReviewSchema.safeParse(raw).success).toBe(false);
  expect(
    independentReviewSchema.safeParse({
      ...raw,
      findings: [
        {
          problem: "The released bird remains connected to the sling",
          consequence: "The rendered flight contradicts the release",
          nextCheck: "Release and inspect an intermediate frame",
          evidence: ["CAP-flight"],
          outcomes: ["O001"],
          required: true,
        },
      ],
    }).success,
  ).toBe(true);
});
it.each(["executed", "source-only"])(
  "requires %s counterevidence when explicitly disproving a critic finding",
  async (evidenceKind) => {
    const { p, run, native, packet } = await prepared(true);
    expect(packet.current).not.toHaveProperty("repairQuestions");
    const first = response(packet);
    expect(
      await run({
        operation: "submit",
        attempt: native.attempt,
        capabilities,
        response: {
          ...first,
          assessments: first.assessments.map((a) => ({ ...a, status: "failed" })),
          findings: [
            {
              problem: "The exported result needs a correction",
              consequence: "The caller receives the wrong result",
              nextCheck: "Check the corrected public result",
              evidence: first.assessments[0]?.evidence,
              outcomes: ["O001"],
              required: true,
            },
          ],
        },
      }),
    ).toMatchObject({ ok: true, value: { action: "worker" } });
    await p.workspace.write(
      "src/value.mjs",
      "// Corrected implementation under review\nexport const value = 2;\n",
    );
    expect((await runProductVerify(await p.workspace.state(), { task: "T001" })).ok).toBe(true);
    const preparedAgain = await run({ operation: "prepare", capabilities });
    if (!preparedAgain.ok) throw new Error(preparedAgain.error.message);
    const second = preparedAgain.value as { attempt: string; packetPath: string };
    const secondPacket = JSON.parse(await readFile(second.packetPath, "utf8")) as CriticPacket;
    const finding = secondPacket.current.repairQuestions?.[0];
    expect(finding?.problem).toContain("exported result");
    expect(finding?.recheck).toMatchObject({
      kind: "check",
      status: "observed-unassessed",
      comparison: {
        before: { subjectDigest: packet.current.subjectDigest },
        after: { subjectDigest: secondPacket.current.subjectDigest },
      },
    });
    expect(secondPacket.current).not.toHaveProperty("previousFindings");
    expect(secondPacket.current).not.toHaveProperty("feedbackPlan");
    const work = await runProductContext(await p.workspace.state(), { task: "T001" });
    expect(work.ok && work.value.feedbackPlan?.findings[0]?.recheck).toEqual(finding?.recheck);
    const session = await runProductReviewRequest(await p.workspace.state(), {
      task: "T001",
      prepare: true,
    });
    if (!session.ok) throw new Error(session.error.message);
    const sessionPacket = JSON.parse(
      await readFile((session.value as { packetPath: string }).packetPath, "utf8"),
    );
    expect(sessionPacket.repairQuestions?.[0]?.recheck).toEqual(finding?.recheck);
    const reply = response(secondPacket);
    expect(
      await run({
        operation: "submit",
        attempt: second.attempt,
        capabilities,
        response: {
          ...reply,
          resolutions: [
            {
              id: finding?.id,
              disposition: "disproved",
              explanation:
                "The finding claimed the exported value was wrong, but the new recorded assertion confirms the required value is two; the earlier execution also passed. No behavioral repair was needed.",
              evidence:
                evidenceKind === "executed"
                  ? reply.assessments[0]?.evidence
                  : [
                      secondPacket.current.evidence.find((entry) => entry.id.startsWith("CODE-"))
                        ?.id,
                    ],
            },
          ],
        },
      }),
    ).toMatchObject({
      ok: true,
      value: { action: evidenceKind === "executed" ? "normal-acceptance" : "worker", callsUsed: 2 },
    });
    expect(await runProductDone(await p.workspace.state(), { task: "T001" })).toMatchObject({
      ok: true,
      value: { closed: evidenceKind === "executed" },
    });
  },
);

it("keeps outcome findings subject to behavioral counterevidence even without category metadata", () => {
  const input = independentReviewSchema.parse({
    summary: "Observed a broken public result",
    assessments: [],
    findings: [
      {
        problem: "Wrong result",
        consequence: "The caller fails",
        nextCheck: "Run the caller after repair",
        evidence: [],
        outcomes: ["O001"],
        required: true,
      },
    ],
    limitations: [],
    resolutions: [],
  });
  expect(independentJudgments(input, "product").feedback.findings[0]?.dimension).toBe("functional");
});
it.each([
  { kind: "quality", dimension: "non-functional" },
  { kind: "experience", dimension: "experience" },
] as const)(
  "preserves the $kind evidence policy when deriving a finding's category",
  ({ kind, dimension }) => {
    const input = independentReviewSchema.parse({
      summary: "Observed a consequential defect",
      assessments: [],
      findings: [
        {
          problem: "The requested outcome is not met",
          consequence: "The user cannot complete the activity",
          nextCheck: "Observe the corrected activity",
          evidence: [],
          outcomes: ["O001"],
          required: true,
        },
      ],
      limitations: [],
      resolutions: [],
    });
    const outcome = {
      id: "O001",
      kind,
      statement: "The requested outcome",
      priority: "must",
      provenance: "agent-proposed",
      expectations: [],
      reviewRequired: true,
    } as const;
    expect(
      independentJudgments(input, "product", [{ ...outcome, expectations: [] }]).feedback
        .findings[0]?.dimension,
    ).toBe(dimension);
  },
);

it("generates a provider schema without nested refs while preserving response constraints", async () => {
  const { packet } = await prepared();
  const schema = packet.responseSchema as Record<string, unknown>;
  function check(value: unknown) {
    if (!value || typeof value !== "object") return;
    expect(value).not.toHaveProperty("$ref");
    const node = value as Record<string, unknown>;
    if (node.type === "object") {
      expect(node.additionalProperties).toBe(false);
      expect(node.required).toEqual(Object.keys(node.properties as object));
    }
    for (const child of Object.values(node)) check(child);
  }
  check(schema);
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  expect(properties.summary).toMatchObject({ type: "string", minLength: 1 });
  expect(properties.findings?.maxItems).toBe(3);
  expect(independentReviewSchema.safeParse({ ...response(packet), summary: "" }).success).toBe(
    false,
  );
});

it("offers exact outcome IDs in the prepared provider schema instead of accepting decorated labels", async () => {
  const { packet } = await prepared();
  const schema = packet.responseSchema as {
    properties: {
      assessments: { items: { properties: { outcome: { enum: string[] } } } };
      findings: { items: { properties: { outcomes: { items: { enum: string[] } } } } };
    };
  };
  const ids = packet.current.outcomes.map((outcome) => outcome.id);
  expect(schema.properties.assessments.items.properties.outcome.enum).toEqual(ids);
  expect(schema.properties.findings.items.properties.outcomes.items.enum).toEqual(ids);
  expect(schema.properties.assessments.items.properties.outcome.enum).not.toContain(
    `${ids[0]} — A decorated outcome label`,
  );
});

it("limits native provider citations to delivered evidence without inventing fallback IDs", async () => {
  const { packet } = await prepared();
  const fields: Record<string, unknown>[] = [];
  function collect(value: unknown) {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "evidence" && child && typeof child === "object") fields.push(child);
      collect(child);
    }
  }
  collect(packet.responseSchema);
  // Assessment, expectation, finding, resolution and adjacent-regression citations.
  expect(fields).toHaveLength(5);
  const ids = packet.current.evidence.map((entry) => entry.id);
  expect(ids).toContain("SRC-REQUEST");
  for (const field of fields) {
    expect(field.items).toEqual({ type: "string", enum: [...new Set(ids)] });
    expect((field.items as { enum: string[] }).enum).not.toContain(
      "27e7cbb6-115f-49f4-ad28-fd008eefa318",
    );
  }
  expect(packet.current.evidence.some((entry) => entry.status === "not-delivered")).toBe(false);
  fields.length = 0;
  collect(await independentReviewJsonSchema([]));
  for (const field of fields) {
    expect(field.maxItems).toBe(0);
    expect(field.items).not.toHaveProperty("enum");
  }
});

it("recovers after renewed permission without replaying history or requiring source edits", async () => {
  const { p, run, native, packet } = await prepared();
  const failure = await run({
    operation: "submit",
    attempt: native.attempt,
    failure: "Host refused the first export",
    failureKind: "permission-denied",
    notInvoked: true,
  });
  expect(failure).toMatchObject({
    ok: true,
    value: {
      callsUsed: 1,
      lifecycle: { failureKind: "permission-denied", invoked: false, provenance: "host-reported" },
      recovery: { after: native.attempt, availableWithinBudget: true },
    },
  });
  expect(await run({ operation: "prepare", capabilities })).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("Previous critic attempt unavailable") },
  });
  const retry = {
    retryAfter: native.attempt,
    reason: "The user explicitly authorized this same packet and destination after the refusal",
    capabilities: { ...capabilities, delegationAllowed: true },
  };
  const state = await criticSelection(await p.workspace.state(), { task: "T001" });
  if (!state.ok) throw new Error(state.error.message);
  const { readCriticState } = await import(
    "../../../../src/workflow/product/critic/critic-store.js"
  );
  const before = await readCriticState(await p.workspace.state(), state.value);
  expect(await run({ operation: "preflight", ...retry })).toMatchObject({
    ok: true,
    value: { ready: true, callsUsed: 1 },
  });
  expect(await readCriticState(await p.workspace.state(), state.value)).toEqual(before);
  expect(
    await run({
      operation: "prepare",
      ...retry,
      capabilities: { ...capabilities, delegationAllowed: false },
    }),
  ).toMatchObject({ ok: false });
  const racing = await Promise.all([
    run({ operation: "prepare", ...retry }),
    run({ operation: "prepare", ...retry }),
  ]);
  expect(racing.filter((result) => result.ok)).toHaveLength(1);
  const retried = racing.find((result) => result.ok);
  if (!retried?.ok) throw new Error("No recovery reservation succeeded");
  const next = retried.value as { attempt: string; packetPath: string };
  expect(next.attempt).not.toBe(native.attempt);
  expect(await run({ operation: "prepare", ...retry })).toMatchObject({ ok: false });
  const after = await readCriticState(await p.workspace.state(), state.value);
  if (!before.ok || !after.ok) throw new Error("state read failed");
  expect(after.value.state?.attempts[0]).toEqual(before.value.state?.attempts[0]);
  expect(after.value.state?.attempts[1]?.recovery).toMatchObject({
    after: native.attempt,
    reason: retry.reason,
    provenance: "host-reported",
  });
  const newPacket = JSON.parse(await readFile(next.packetPath, "utf8")) as CriticPacket;
  expect(newPacket.current.subjectDigest).toBe(packet.current.subjectDigest);
  expect(
    await run({
      operation: "submit",
      attempt: next.attempt,
      capabilities: retry.capabilities,
      response: response(newPacket),
    }),
  ).toMatchObject({ ok: true, value: { callsUsed: 2, lifecycle: { acceptedReview: true } } });
});

it("requires explicit recovery for unknown invocation and preserves exhausted budgets", async () => {
  const { run, native } = await prepared(false, 2);
  expect(
    await run({
      operation: "submit",
      attempt: native.attempt,
      failure: "Transport disconnected",
      failureKind: "invocation-failed",
    }),
  ).toMatchObject({
    ok: true,
    value: { lifecycle: { invoked: null }, recovery: { invocation: "possibly-invoked" } },
  });
  expect(
    await run({ operation: "prepare", retryAfter: native.attempt, capabilities }),
  ).toMatchObject({ ok: false });
  const retry = {
    retryAfter: native.attempt,
    reason:
      "Host confirmed the prior process ended; user authorizes a fresh call despite possible prior cost",
    capabilities: { ...capabilities, delegationAllowed: true },
  };
  const next = await run({ operation: "prepare", ...retry });
  if (!next.ok) throw new Error(next.error.message);
  const id = (next.value as { attempt: string }).attempt;
  expect(
    await run({
      operation: "submit",
      attempt: id,
      failure: "Provider rejected schema",
      failureKind: "schema-rejected",
      notInvoked: true,
    }),
  ).toMatchObject({
    ok: true,
    value: { callsUsed: 2, recovery: { availableWithinBudget: false } },
  });
  expect(await run({ operation: "prepare", ...retry, retryAfter: id })).toMatchObject({
    ok: false,
  });
});

it("never recovers a pending attempt or accepts fabricated not-invoked reports", async () => {
  const { run, native } = await prepared();
  expect(
    await run({
      operation: "prepare",
      retryAfter: native.attempt,
      reason: "try again",
      capabilities: { ...capabilities, delegationAllowed: true },
    }),
  ).toMatchObject({ ok: false });
  expect(await run({ operation: "status", notInvoked: true })).toMatchObject({ ok: false });
  expect(await run({ operation: "status" })).toMatchObject({
    ok: true,
    value: { callsUsed: 1, lifecycle: { status: "pending" } },
  });
});

it("retains annotated critic findings without treating explanatory prose as evidence", async () => {
  const { run, native, packet } = await prepared();
  const source = packet.current.sources.find((s) => s.reference === "src/value.mjs");
  const outcome = packet.current.outcomes[0];
  if (!source || !outcome) throw new Error("Missing review inputs");
  const reply = {
    ...response(packet),
    findings: [
      {
        problem: "The public implementation does not exercise the claimed failure path.",
        consequence: "A passing happy path can hide a broken boundary.",
        nextCheck: "Exercise the public boundary with an invalid input.",
        evidence: [
          `${source.id} contains the complete implementation`,
          "The supplied run covers only the happy path",
        ],
        outcomes: [outcome.id],
        required: true,
      },
    ],
  };
  const result = await run({
    operation: "submit",
    attempt: native.attempt,
    capabilities,
    response: reply,
  });
  expect(result).toMatchObject({ ok: true, value: { action: "worker", callsUsed: 1 } });
  if (!result.ok) throw new Error(result.error.message);
  expect(JSON.stringify(result.value)).toContain("contains the complete implementation");
  expect(JSON.stringify(result.value)).not.toContain("schema-rejected");
});

it("does not grant approval or mandatory correction credit to prose without supplied evidence", () => {
  const result = independentJudgments(
    {
      summary: "A reviewer opinion.",
      assessments: [
        {
          outcome: "O001",
          status: "satisfied",
          summary: "Looks correct",
          evidence: ["Everything appears to work"],
          expectations: [],
        },
      ],
      findings: [
        {
          problem: "A possible issue",
          consequence: "Uncertain",
          nextCheck: "Observe it",
          evidence: ["The interaction might fail"],
          outcomes: ["O001"],
          required: true,
        },
      ],
      limitations: [],
      resolutions: [],
    },
    "product",
  );
  expect(result.assessments[0]).toMatchObject({ status: "unclear", evidence: [] });
  expect(result.feedback.findings[0]).toMatchObject({ required: false, evidence: [] });
  expect(result.feedback.limitations).toContain(
    "Unverified reviewer commentary supplied as evidence: Everything appears to work",
  );
});

it("rejects fabricated annotated IDs and reports returned-review validation separately from invocation", async () => {
  const { run, native, packet } = await prepared();
  const reply = response(packet);
  const assessment = reply.assessments[0];
  if (!assessment) throw new Error("Missing assessment");
  assessment.evidence = ["CODE-deadbeef proves the implementation"];
  const result = await run({
    operation: "submit",
    attempt: native.attempt,
    capabilities,
    response: reply,
  });
  expect(result).toMatchObject({ ok: true, value: { callsUsed: 1 } });
  expect(JSON.stringify(result)).toContain("schema-rejected");
  expect(JSON.stringify(result)).toContain("returned");
  expect(JSON.stringify(result)).toContain("unknown");
});

it("keeps annotated unselected captures outside a prepared session", async () => {
  const { p, packet } = await prepared();
  const preparedSession = await runProductReviewRequest(await p.workspace.state(), {
    task: "T001",
    prepare: true,
  });
  if (!preparedSession.ok) throw new Error(preparedSession.error.message);
  const session = preparedSession.value as { session: string };
  const reply = response(packet);
  reply.assessments.forEach((a) => {
    a.evidence = ["CAP-00000000-0000-0000-0000-000000000000 shows the finished interface"];
  });
  const parsed = parseReviewSubmission(reply, session.session);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const result = await runProductReviewRequest(await p.workspace.state(), {
    task: "T001",
    session: session.session,
    ...parsed.value,
  });
  expect(result).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("outside this review session") },
  });
});

it("keeps unsupported expectations unclear and resolutions strict while preserving annotations", () => {
  const value = independentJudgments(
    {
      summary: "Observed implementation",
      assessments: [
        {
          outcome: "O001",
          status: "satisfied",
          summary: "Inspected",
          evidence: ["CODE-deadbeef: source observation", "CODE-deadbeef"],
          expectations: [
            { id: "E001", status: "satisfied", reason: "Assumed", evidence: ["It probably works"] },
          ],
        },
      ],
      findings: [],
      limitations: [],
      resolutions: [
        { id: "F001", explanation: "Claimed repaired", evidence: ["It probably works"] },
      ],
    },
    "product",
  );
  expect(value.assessments[0]?.evidence).toEqual(["CODE-deadbeef"]);
  expect(value.assessments[0]?.summary).toContain("source observation");
  expect(value.assessments[0]?.expectations[0]).toMatchObject({
    status: "unclear",
    evidence: [],
    reason: expect.stringContaining("It probably works"),
  });
  expect(value.feedback.resolutions[0]?.evidence).toEqual(["It probably works"]);
});

it("reuses observed evidence across host thread routing while retaining execution and product environment", async () => {
  vi.stubEnv("CODEX_THREAD_ID", "worker-thread");
  const { p, run, native, packet } = await prepared();
  const environment = await browserEnvironmentIdentity(p.workspace.root);
  vi.stubEnv("CODEX_THREAD_ID", "reviewer-thread");
  expect(productExecutionEnvironment().CODEX_THREAD_ID).toBe("reviewer-thread");
  expect((await resolvedProductExecutionEnvironment()).CODEX_THREAD_ID).toBe("reviewer-thread");
  expect(await browserEnvironmentIdentity(p.workspace.root)).toBe(environment);
  expect(
    await run({
      operation: "submit",
      attempt: native.attempt,
      capabilities,
      response: response(packet),
    }),
  ).toMatchObject({ ok: true, value: { action: "normal-acceptance", callsUsed: 1 } });
  // Toolchain variables belong to the comparison identity; the capability keeps only the
  // executable and the host security context.
  vi.stubEnv("NODE_ENV", "different-product-mode");
  expect(await browserEnvironmentIdentity(p.workspace.root)).toBe(environment);
  vi.unstubAllEnvs();
  vi.stubEnv("CODEX_PERMISSION_PROFILE", "different-host-permissions");
  expect(await browserEnvironmentIdentity(p.workspace.root)).not.toBe(environment);
});

it("reuses browser evidence when only the host terminal color capability changes", async () => {
  vi.stubEnv("COLORTERM", "");
  const { p, run, native, packet } = await prepared();
  const environment = await browserEnvironmentIdentity(p.workspace.root);
  vi.stubEnv("COLORTERM", "truecolor");
  expect(productExecutionEnvironment().COLORTERM).toBe("truecolor");
  expect((await resolvedProductExecutionEnvironment()).COLORTERM).toBe("truecolor");
  expect(await browserEnvironmentIdentity(p.workspace.root)).toBe(environment);
  expect(
    await run({
      operation: "submit",
      attempt: native.attempt,
      capabilities,
      response: response(packet),
    }),
  ).toMatchObject({ ok: true, value: { action: "normal-acceptance", callsUsed: 1 } });
  vi.stubEnv("FORCE_COLOR", "0");
  expect(await browserEnvironmentIdentity(p.workspace.root)).toBe(environment);
  vi.unstubAllEnvs();
});

it("delivers critic summary and limitations to status and work without manufacturing findings", async () => {
  const { p, run, native, packet } = await prepared();
  const reviewed = response(packet);
  const submitted = await run({
    operation: "submit",
    attempt: native.attempt,
    capabilities,
    response: reviewed,
  });
  expect(submitted).toMatchObject({
    ok: true,
    value: {
      callsUsed: 1,
      findings: [],
      advice: { summary: reviewed.summary, limitations: reviewed.limitations, current: true },
    },
  });
  const work = await runProductWork(await p.workspace.state(), { task: "T001" });
  expect(work).toMatchObject({
    ok: true,
    value: {
      reviewFeedback: [
        expect.objectContaining({
          summary: reviewed.summary,
          limitations: reviewed.limitations,
          current: true,
        }),
      ],
    },
  });
  await p.workspace.write("src/value.mjs", "export const value = 3;\n");
  expect(await run({ operation: "status" })).toMatchObject({
    ok: true,
    value: {
      callsUsed: 1,
      advice: { summary: reviewed.summary, current: false },
    },
  });
});

it("keeps narrative-only advice visible without granting outcome approval", async () => {
  const { p, run, native, packet } = await prepared();
  const reviewed = { ...response(packet), assessments: [] };
  expect(
    await run({ operation: "submit", attempt: native.attempt, capabilities, response: reviewed }),
  ).toMatchObject({ ok: true });
  expect(await runProductNext(await p.workspace.state(), { task: "T001" })).toMatchObject({
    ok: true,
    value: { criticAdvice: { limitations: reviewed.limitations } },
  });
  expect(await runProductWork(await p.workspace.state(), { task: "T001" })).toMatchObject({
    ok: true,
    value: {
      reviewFeedback: [
        expect.objectContaining({
          assessments: [],
          summary: reviewed.summary,
          limitations: reviewed.limitations,
        }),
      ],
    },
  });
});

it("reports the independent response's actual malformed field without suggesting a legacy rewrite", () => {
  const input = {
    summary: "Checked the rendered product",
    assessments: [],
    findings: [{ problem: "The reset overlaps an in-flight operation" }],
    limitations: [],
    resolutions: [],
  };
  const parsed = parseReviewSubmission(input, "prepared-session");
  expect(parsed).toMatchObject({
    ok: false,
    error: {
      message: expect.stringContaining("Invalid prepared independent review"),
      recovery: expect.stringContaining("same --session"),
    },
  });
  if (parsed.ok) throw new Error("Malformed finding accepted");
  expect(parsed.error.message).toContain("consequence");
  expect(parsed.error.message).not.toContain("requires an assessments array");
  expect(parseReviewSubmission({ assessments: [] }, "prepared-session").ok).toBe(true);
});

it("delivers scoped stylesheet bytes alongside implementation without changing graph extraction", async () => {
  const { reviewCodeSources } = await import("../../../../src/workflow/product/code-context.js");
  const { independentSources } = await import(
    "../../../../src/workflow/product/review/independent-sources.js"
  );
  const { readProductRecord } = await import("../../../../src/workflow/product/store.js");
  const p = await productWorkspace();
  projects.push(p);
  const css = await readFile(
    new URL(
      "../../../fixtures/product-quality/skyline-review-regression/styles.css",
      import.meta.url,
    ),
    "utf8",
  );
  await p.workspace.write("styles.css", css);
  await p.workspace.write("outside.css", "/* unrelated */");
  const implementation = "export function launch() { return 'actual implementation'; }";
  await p.workspace.write("src/main.mjs", implementation);
  await p.workspace.write("src-other/main.mjs", "export const unrelated = true;");
  const state = await p.workspace.state();
  const record = await readProductRecord(state);
  if (!record.ok) throw new Error(record.error.message);
  record.value.brief.slices[0]?.scope.allowed.push("styles.css", "src/");
  const sources = await reviewCodeSources(state, record.value);
  const delivered = await independentSources(state, sources);
  if (!delivered.ok) throw new Error(delivered.error.message);
  const stylesheet = sources.find((source) => source.reference === "styles.css");
  expect(stylesheet?.available).toBe(true);
  expect(stylesheet?.excerpt.length).toBeLessThanOrEqual(6000);
  expect(delivered.value.find((source) => source.reference === "styles.css")).toMatchObject({
    available: true,
    excerpt: css,
    truncated: false,
    omittedRegions: [],
  });
  expect(delivered.value.some((source) => source.reference === "outside.css")).toBe(false);
  expect(delivered.value.find((source) => source.reference === "src/main.mjs")).toMatchObject({
    available: true,
    excerpt: implementation,
    truncated: false,
  });
  expect(delivered.value.some((source) => source.reference === "src-other/main.mjs")).toBe(false);
});
