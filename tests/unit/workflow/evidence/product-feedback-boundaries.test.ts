import { describe, expect, it } from "vitest";
import type { ProductEvidenceCatalogue } from "../../../../src/workflow/product/evidence-references.js";
import {
  feedbackIntentDigest,
  feedbackTemplate,
  outstandingFeedback,
  productFeedbackGaps,
  productFeedbackPlan,
  validateProductFeedback,
} from "../../../../src/workflow/product/feedback.js";
import { initialProductState, parseProductBrief } from "../../../../src/workflow/product/model.js";
import { reviewExcerpt } from "../../../../src/workflow/product/review/review-excerpts.js";
import type { ProductRecord } from "../../../../src/workflow/product/store.js";
import { productContractDigest } from "../../../../src/workflow/product/subject.js";

function record(): ProductRecord {
  const parsed = parseProductBrief({
    version: 2,
    feature: "001-feedback",
    goal: "Play a game",
    originalRequest: "Play a game",
    outcomes: [{ id: "O001", kind: "experience", statement: "A usable game" }],
    slices: [
      { id: "T001", goal: "Usable game", outcomes: ["O001"], scope: { allowed: ["index.html"] } },
    ],
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return {
    brief: parsed.value,
    briefText: "",
    stateText: "",
    state: initialProductState(parsed.value, "now"),
  };
}
const catalogue: ProductEvidenceCatalogue = {
  entries: [
    { id: "SRC-REQUEST", kind: "source", status: "available", outcomes: [], summary: "Goal" },
    { id: "CODE-old", kind: "source", status: "available", outcomes: [], summary: "Code" },
    { id: "CODE-new", kind: "source", status: "available", outcomes: [], summary: "Changed code" },
    { id: "E1", kind: "execution", status: "available", outcomes: ["O001"], summary: "Old run" },
    { id: "E2", kind: "execution", status: "available", outcomes: ["O001"], summary: "New run" },
    {
      id: "FAIL",
      kind: "execution",
      status: "failed",
      outcomes: ["O001"],
      summary: "Observed failure",
    },
    { id: "IMG", kind: "image", status: "available", outcomes: ["O001"], summary: "Actual pixels" },
    {
      id: "OP",
      kind: "operation",
      status: "available",
      outcomes: ["O001"],
      summary: "Actual input",
    },
    { id: "STALE", kind: "image", status: "stale", outcomes: ["O001"], summary: "Old pixels" },
  ],
  aliases: new Map([["C001", "E1"]]),
  sources: [],
  sourceClaims: [],
};

describe("quality review boundaries", () => {
  it("explains non-applicability without inferring a passing status from prose", () => {
    const subject = record();
    const outcome = subject.brief.outcomes[0];
    if (!outcome) throw new Error("Missing fixture outcome");
    outcome.kind = "functional";
    const feedback = feedbackTemplate();
    feedback.dimensions = [
      {
        dimension: "experience",
        status: "satisfied",
        reason: "This headless API has no rendered interface; UI review is not applicable.",
        evidence: ["C001"],
      },
    ];
    expect(
      validateProductFeedback(feedback, subject, catalogue, { context: "current" }),
    ).toMatchObject({
      ok: true,
      value: {
        dimensions: [
          { status: "unclear", reason: expect.stringContaining('status "not-applicable"') },
        ],
      },
    });
    const experience = feedback.dimensions[0];
    if (!experience) throw new Error("Missing experience feedback");
    experience.status = "not-applicable";
    expect(
      validateProductFeedback(feedback, subject, catalogue, { context: "current" }),
    ).toMatchObject({
      ok: true,
      value: { dimensions: [{ status: "not-applicable" }] },
    });
    outcome.kind = "experience";
    expect(
      validateProductFeedback(feedback, subject, catalogue, { context: "current" }),
    ).toMatchObject({
      ok: true,
      value: {
        dimensions: [
          { status: "unclear", reason: expect.stringContaining("applies to this product") },
        ],
      },
    });
  });

  it("keeps observed findings scoped without requiring missing category declarations", () => {
    const subject = record();
    const first = subject.brief.slices[0];
    const outcome = subject.brief.outcomes[0];
    if (!first || !outcome) throw new Error("Missing fixture outcome or slice");
    subject.brief.outcomes.push({ ...outcome, id: "O002" });
    subject.brief.slices.push({ ...first, id: "T002", outcomes: ["O002"], goal: "Another slice" });
    const feedback = feedbackTemplate();
    feedback.findings.push({
      dimension: "experience",
      problem: "Primary control is clipped",
      nextCheck: "Inspect the primary control",
      outcomes: ["O001"],
      required: true,
      evidence: ["IMG"],
    });
    subject.state.reviews.push({
      subjectDigest: "current",
      contractDigest: productContractDigest(subject.brief, first),
      policyVersion: 5,
      task: first.id,
      createdAt: "now",
      assessments: [],
      captures: [],
      feedback,
    });
    expect(productFeedbackPlan(subject, "current", first).gaps.join(" ")).toContain(
      "Primary control is clipped",
    );
    expect(productFeedbackPlan(subject, "current", subject.brief.slices[1]).gaps).toEqual([]);
    expect(productFeedbackPlan(subject, "current").gaps.join(" ")).toContain(
      "Primary control is clipped",
    );
    expect(productFeedbackPlan(subject, "changed", first).gaps.join(" ")).toContain(
      "Primary control is clipped",
    );
  });

  it("keeps malformed, duplicate and ungrounded feedback out of state", () => {
    const subject = record();
    expect(validateProductFeedback(undefined, subject, catalogue, { context: "current" })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(validateProductFeedback({}, subject, catalogue, { context: "current" }).ok).toBe(false);
    const feedback = feedbackTemplate();
    feedback.dimensions.push(feedback.dimensions[0] as (typeof feedback.dimensions)[number]);
    expect(validateProductFeedback(feedback, subject, catalogue, { context: "current" }).ok).toBe(
      false,
    );
    feedback.dimensions = [];
    feedback.findings = [
      {
        dimension: "code",
        problem: "Unknown owner",
        nextCheck: "Inspect owner",
        outcomes: ["O999"],
        required: true,
        evidence: [],
      },
    ];
    expect(validateProductFeedback(feedback, subject, catalogue, { context: "current" }).ok).toBe(
      false,
    );
  });

  it("requires actual UI images and operations, while preserving recorded failing evidence", () => {
    for (const [evidence, expected] of [
      [[], "unclear"],
      [["SRC-REQUEST"], "unclear"],
      [["IMG"], "unclear"],
      [["IMG", "OP"], "satisfied"],
    ] as const) {
      const feedback = {
        phase: "product",
        dimensions: [
          { dimension: "experience", status: "satisfied", reason: "Observed journey", evidence },
        ],
        findings: [],
        resolutions: [],
      };
      const validated = validateProductFeedback(feedback, record(), catalogue, {
        context: "current",
      });
      expect(validated.ok && validated.value?.dimensions[0]?.status).toBe(expected);
    }
    const failed = validateProductFeedback(
      {
        phase: "product",
        dimensions: [
          {
            dimension: "functional",
            status: "failed",
            reason: "Wrong terminal result",
            evidence: ["FAIL"],
          },
        ],
      },
      record(),
      catalogue,
      { context: "unavailable" },
    );
    expect(failed.ok && failed.value?.dimensions[0]?.status).toBe("failed");
    expect(
      validateProductFeedback(
        {
          phase: "product",
          dimensions: [
            {
              dimension: "experience",
              status: "satisfied",
              reason: "Old pixels",
              evidence: ["STALE"],
            },
          ],
        },
        record(),
        catalogue,
        { context: "current" },
      ).ok,
    ).toBe(false);
  });

  it("does not mark functional review satisfied from pixels or input-only operations", () => {
    const subject = record();
    const outcome = subject.brief.outcomes[0];
    if (!outcome) throw new Error("Missing fixture outcome");
    outcome.kind = "functional";
    for (const [evidence, expected] of [
      [["IMG"], "unclear"],
      [["OP"], "unclear"],
      [["E1"], "satisfied"],
    ] as const) {
      const validated = validateProductFeedback(
        {
          phase: "product",
          dimensions: [
            {
              dimension: "functional",
              status: "satisfied",
              reason: "Claimed behavior result",
              evidence: [...evidence],
            },
          ],
        },
        subject,
        catalogue,
        { context: "current" },
      );
      expect(validated.ok && validated.value?.dimensions[0]?.status).toBe(expected);
    }
  });

  it("requires new counterevidence to resolve persistent findings, including normalized aliases", () => {
    const subject = record();
    const feedback = validateProductFeedback(
      {
        phase: "product",
        dimensions: [],
        findings: [
          {
            dimension: "functional",
            problem: "Wrong win",
            nextCheck: "Exhaust shots",
            outcomes: ["O001"],
            required: true,
            evidence: ["C001"],
          },
        ],
      },
      subject,
      catalogue,
      { context: "current" },
    );
    if (!feedback.ok) throw new Error("Invalid fixture");
    subject.state.reviews.push({
      policyVersion: 4,
      subjectDigest: "old",
      contractDigest: productContractDigest(subject.brief),
      createdAt: "now",
      assessments: [],
      captures: [],
      feedback: feedback.value,
    });
    const id = outstandingFeedback(subject)[0]?.id;
    for (const evidence of [["C001"], ["FAIL"], ["SRC-REQUEST"]])
      expect(
        validateProductFeedback(
          {
            phase: "product",
            dimensions: [],
            resolutions: [{ id, explanation: "Claimed fix", evidence }],
          },
          subject,
          catalogue,
          { context: "current" },
        ),
      ).toMatchObject({ ok: true, value: { resolutions: [] } });
    const resolved = validateProductFeedback(
      {
        phase: "product",
        dimensions: [],
        resolutions: [
          { id, explanation: "New execution counterchecks the terminal state", evidence: ["E2"] },
        ],
      },
      subject,
      catalogue,
      { context: "current" },
    );
    expect(resolved.ok).toBe(true);
    expect(
      validateProductFeedback(
        {
          phase: "product",
          dimensions: [],
          resolutions: [{ id, explanation: "Cannot see", evidence: ["E2"] }],
        },
        subject,
        catalogue,
        { context: "unavailable" },
      ),
    ).toMatchObject({ ok: true, value: { resolutions: [] } });
    expect(productFeedbackPlan(subject, "changed").findings[0]?.id).toBe(id);
  });

  it("retains useful feedback when a known repair lacks behavioral counterevidence", () => {
    const subject = record();
    subject.state.reviews.push({
      policyVersion: 4,
      subjectDigest: "old",
      contractDigest: productContractDigest(subject.brief),
      createdAt: "now",
      assessments: [],
      captures: [],
      feedback: {
        phase: "product",
        dimensions: [],
        resolutions: [],
        findings: [
          {
            dimension: "functional",
            problem: "Wrong result",
            nextCheck: "Observe result",
            outcomes: ["O001"],
            required: true,
            evidence: ["E1"],
          },
        ],
      },
    });
    const finding = outstandingFeedback(subject)[0];
    const previous = subject.state.reviews[0];
    if (!finding || !previous) throw new Error("Missing fixture finding");
    const id = finding.id;
    const value = validateProductFeedback(
      {
        phase: "product",
        dimensions: [],
        summary: "The source repair looks correct; rendering is unobserved",
        findings: [
          {
            dimension: "experience",
            problem: "Control is obscured",
            nextCheck: "Expose control",
            outcomes: ["O001"],
            required: true,
            evidence: ["IMG"],
          },
        ],
        resolutions: [{ id, explanation: "Source changed", evidence: ["CODE-new"] }],
      },
      subject,
      catalogue,
      { context: "fresh" },
    );
    expect(value).toMatchObject({
      ok: true,
      value: { resolutions: [], findings: [{ problem: "Control is obscured" }] },
    });
    if (!value.ok || !value.value) throw new Error("Expected retained feedback");
    expect(value.value.limitations?.join(" ")).toContain(id);
    expect(value.value.limitations?.join(" ")).toContain("remains unresolved");
    subject.state.reviews.push({ ...previous, feedback: value.value });
    expect(outstandingFeedback(subject).some((finding) => finding.id === id)).toBe(true);
  });

  it("counts recurring product findings across metadata and routes a focused new hypothesis", () => {
    const subject = record();
    const feedback = feedbackTemplate("understanding");
    feedback.dimensions = feedback.dimensions.map((entry) => ({
      ...entry,
      status: "satisfied",
      reason: "Proposed check distinguishes the failure",
      evidence: ["SRC-REQUEST"],
    }));
    const base = {
      subjectDigest: "s",
      contractDigest: productContractDigest(subject.brief),
      createdAt: "now",
      assessments: [],
      captures: [],
      feedback,
      feedbackIntentDigest: feedbackIntentDigest(subject.brief),
    };
    subject.state.reviews.push(base);
    expect(subject.state.reviews.at(-1)?.feedback?.phase).toBe("understanding");
    feedback.findings = [
      {
        dimension: "code",
        problem: "Repeated state ownership defect",
        nextCheck: "Trace reset callers",
        required: true,
        outcomes: ["O001"],
        evidence: ["CODE-old"],
      },
    ];
    subject.state.reviews.push({ ...base, subjectDigest: "metadata-change" });
    expect(productFeedbackPlan(subject, "other").research?.question).toContain(
      "different hypothesis",
    );
    expect(productFeedbackGaps(subject, "other").length).toBeGreaterThan(0);
    const optional = feedback.findings[0];
    if (optional) optional.required = false;
    expect(outstandingFeedback(subject).every((finding) => !finding.required)).toBe(true);
  });

  it("cannot relabel an observed product failure as design advice to resolve it with source text", () => {
    const subject = record();
    const problem = {
      dimension: "functional" as const,
      problem: "Released bird travels in the wrong direction",
      nextCheck: "Release a down-left pull and observe upward forward motion",
      outcomes: ["O001"],
      required: true,
      evidence: ["E1"],
    };
    const append = (phase: "product" | "understanding", finding: typeof problem) => {
      const feedback = validateProductFeedback(
        { phase, dimensions: [], findings: [finding] },
        subject,
        catalogue,
        { context: "current" },
      );
      if (!feedback.ok) throw new Error(feedback.error.message);
      subject.state.reviews.push({
        policyVersion: 4,
        subjectDigest: phase,
        contractDigest: productContractDigest(subject.brief),
        createdAt: "now",
        assessments: [],
        captures: [],
        feedback: feedback.value,
      });
    };
    append("product", problem);
    const observed = outstandingFeedback(subject)[0];
    if (!observed) throw new Error("No product failure");
    const history = JSON.stringify(subject.state.reviews[0]);
    append("understanding", { ...problem, required: false, evidence: ["SRC-REQUEST"] });
    expect(outstandingFeedback(subject)).toEqual([{ ...observed, repeats: 2 }]);
    expect(JSON.stringify(subject.state.reviews[0])).toBe(history);

    const resolution = (evidence: string[]) =>
      validateProductFeedback(
        {
          phase: "understanding",
          dimensions: [],
          resolutions: [
            { id: observed.id, explanation: "Reconsider the expected launch direction", evidence },
          ],
        },
        subject,
        catalogue,
        { context: "current" },
      );
    expect(resolution(["CODE-new"])).toMatchObject({
      ok: true,
      value: { resolutions: [] },
    });
    expect(resolution(["E2"]).ok).toBe(true);

    // A finding that really originated in design can still use a revised design/source decision.
    subject.state.reviews.splice(0, 1);
    expect(outstandingFeedback(subject)[0]?.phase).toBe("understanding");
    expect(resolution(["CODE-new"]).ok).toBe(true);
  });

  it("sends relevant late HTML handlers instead of only the stylesheet prefix", async () => {
    const source = `<style>\n${".x { color:red }\n".repeat(1000)}</style>\n<script>\nfunction resetRound(){ return 'ready'; }\nfunction launchBird(){ return resetRound(); }\n</script>`;
    const { excerpt } = await reviewExcerpt("index.html", source, "resetRound", 1000);
    expect(excerpt).toContain("1004: function resetRound");
    expect(excerpt.length).toBeLessThan(1000);
    expect((await reviewExcerpt("data.txt", "x".repeat(6000), "", 200)).excerpt).toHaveLength(200);
    expect((await reviewExcerpt("small.js", "let a=1", "", 200)).excerpt).toBe("let a=1");
  });
});

it("schedules first-render visual judgment and detects repeated captures without visual assessment", () => {
  const subject = record();
  const slice = subject.brief.slices[0];
  const pending = productFeedbackPlan(subject, "current", slice).visualCheckpoint;
  expect(pending?.status).toBe("awaiting-render");
  const capture = {
    id: "CAP-one",
    path: ".visp/one.png",
    sha256: "a".repeat(64),
    subjectDigest: "current",
    route: "file:///index.html",
    steps: ["Navigate"],
    viewport: { width: 390, height: 844 },
    createdAt: "now",
    provenance: "runner-captured",
  };
  subject.state.captureRuns.push(
    ...[1, 2, 3].map((id) => ({
      id: String(id),
      version: 2,
      provenance: "runner-executed",
      subjectDigest: "current",
      task: "T001",
      contractDigest: productContractDigest(subject.brief, slice),
      captures: [capture],
      operations: [],
      status: "completed",
    })),
  );
  const plan = productFeedbackPlan(subject, "current", slice).visualCheckpoint;
  expect(plan).toMatchObject({
    status: "review-rendered-slice",
    recovery: expect.stringContaining("Repeated captures"),
    images: [{ id: "CAP-one" }],
  });
  expect(plan?.assess).toContain("theme is not aesthetic success");
  // The worker is sent to the review handoff by default, and to `visp done` when VISP launches it.
  expect(plan?.command).toContain("--handoff");
  const launched = productFeedbackPlan(subject, "current", slice, {
    reviewer: "visp",
  }).visualCheckpoint;
  expect(launched?.command).toMatch(/^visp done --feature \S+ --task T001$/);
  expect(launched?.imageStatus).toContain("VISP's independent reviewer receives the actual image");
  expect(launched?.imageStatus).not.toContain("review handoff");
  // Once VISP's reviewer cannot run again the images go to the human reviewer.
  const gone = productFeedbackPlan(subject, "current", slice, {
    reviewer: "gone",
  }).visualCheckpoint;
  expect(gone?.command).toMatch(/^visp pr --feature \S+$/);
  expect(gone?.imageStatus).toContain("human reviewer receives the images");
  expect(productFeedbackPlan(subject, "changed", slice).visualCheckpoint).toMatchObject({
    status: "awaiting-render",
    images: [],
  });
  expect(subject.state.reviews).toHaveLength(0);
});

it("does not schedule browser aesthetics for a CLI and does not keep recapturing an assessed unchanged slice", () => {
  const subject = record();
  const slice = subject.brief.slices[0];
  if (!slice) throw new Error("missing slice");
  subject.brief.slices[0] = { ...slice, scope: { ...slice.scope, allowed: ["src/cli.ts"] } };
  expect(
    productFeedbackPlan(subject, "current", subject.brief.slices[0]).visualCheckpoint,
  ).toBeUndefined();
  subject.brief.slices[0] = slice;
  const feedback = feedbackTemplate();
  feedback.phase = "product";
  feedback.dimensions = [
    {
      dimension: "experience",
      status: "satisfied",
      reason: "Inspected composition and primary activity in the current mobile render",
      evidence: [],
    },
  ];
  subject.state.reviews.push({
    subjectDigest: "current",
    contractDigest: productContractDigest(subject.brief, slice),
    task: "T001",
    createdAt: "now",
    assessments: [],
    captures: [],
    feedback,
  });
  const capture = {
    id: "CAP",
    path: ".visp/cap.png",
    sha256: "a".repeat(64),
    subjectDigest: "current",
    route: "file:///index.html",
    steps: [],
    viewport: { width: 390, height: 844 },
    createdAt: "now",
    provenance: "runner-captured",
  };
  subject.state.captureRuns.push({
    version: 2,
    provenance: "runner-executed",
    subjectDigest: "current",
    task: "T001",
    contractDigest: productContractDigest(subject.brief, slice),
    captures: [capture],
    operations: [],
  });
  expect(productFeedbackPlan(subject, "current", slice).visualCheckpoint).toMatchObject({
    status: "assessed",
  });
  expect(productFeedbackPlan(subject, "current", slice).visualCheckpoint).not.toHaveProperty(
    "recovery",
  );
});

it("recognizes modern outcome assessments without requiring legacy category declarations", () => {
  const subject = record();
  const slice = subject.brief.slices[0];
  const experiences = subject.brief.outcomes.filter((outcome) => outcome.kind === "experience");
  const assessments = experiences.map((outcome) => ({
    outcome: outcome.id,
    status: "satisfied" as const,
    provenance: "agent-reported" as const,
    summary: "Observed the intended experience",
    expectations: [],
    evidence: [],
  }));
  subject.state.reviews.push({
    subjectDigest: "current",
    contractDigest: productContractDigest(subject.brief, slice),
    task: slice?.id,
    createdAt: "now",
    captures: [],
    assessments,
    feedback: { phase: "product", dimensions: [], findings: [], resolutions: [] },
  });
  subject.state.captureRuns.push({
    version: 2,
    provenance: "runner-executed",
    subjectDigest: "current",
    task: slice?.id,
    contractDigest: productContractDigest(subject.brief, slice),
    captures: [
      {
        id: "CAP",
        path: ".visp/cap.png",
        sha256: "a".repeat(64),
        subjectDigest: "current",
        route: "file:///index.html",
        steps: [],
        viewport: { width: 390, height: 844 },
        createdAt: "now",
        provenance: "runner-captured",
      },
    ],
    operations: [],
  });
  expect(productFeedbackPlan(subject, "current", slice).visualCheckpoint?.status).toBe("assessed");
  expect(productFeedbackPlan(subject, "changed", slice).visualCheckpoint?.status).toBe(
    "awaiting-render",
  );
  const assessed = subject.state.reviews[0]?.assessments[0];
  if (!assessed) throw new Error("Missing fixture experience");
  assessed.status = "failed";
  expect(productFeedbackPlan(subject, "current", slice).visualCheckpoint?.status).toBe(
    "review-rendered-slice",
  );
});

// Reviewers that opened a rendered PNG VISP listed as an unavailable core file cited it beside
// current evidence, and every review of that run was discarded.
describe("citations VISP cannot use", () => {
  const withUnavailable: ProductEvidenceCatalogue = {
    ...catalogue,
    entries: [
      ...catalogue.entries,
      { id: "CODE-png", kind: "source", status: "unavailable", outcomes: [], summary: "Binary" },
    ],
  };
  const finding = (evidence: string[]) => {
    const feedback = feedbackTemplate();
    feedback.dimensions = [];
    feedback.findings = [
      {
        dimension: "code",
        problem: "The handler ignores the second input",
        nextCheck: "Exercise the second input",
        outcomes: ["O001"],
        required: false,
        evidence,
      },
    ];
    return feedback;
  };

  it("are dropped, and recorded, when the entry still cites usable evidence", () => {
    const validated = validateProductFeedback(
      finding(["CODE-new", "CODE-png"]),
      record(),
      withUnavailable,
      { context: "current" },
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok || !validated.value) return;
    expect(validated.value.findings[0]?.evidence).toEqual(["CODE-new"]);
    expect(validated.value.limitations).toContain(
      "VISP dropped citations of evidence it could not deliver: CODE-png",
    );
  });

  it("still reject an entry with nothing usable left, or with a stale or unknown citation", () => {
    for (const evidence of [["CODE-png"], ["STALE"], ["MISSING"], ["CODE-new", "STALE"]])
      expect(
        validateProductFeedback(finding(evidence), record(), withUnavailable, {
          context: "current",
        }).ok,
        evidence.join(),
      ).toBe(false);
  });
});
