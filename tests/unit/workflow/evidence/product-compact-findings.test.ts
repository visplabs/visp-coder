import { expect, it } from "vitest";
import { compactProductReply } from "../../../../src/workflow/product-compact-text.js";

const problem = "The module has no default export";
const nextCheck = "Import the default export and compare it with two";
const open = {
  id: "FB-1",
  dimension: "functional",
  problem,
  nextCheck,
  required: true,
  recheck: { command: "visp verify --task T001", guidance: "Replay the reported input." },
};
const earlier = {
  ...open,
  id: "FB-2",
  problem: "An earlier review's finding",
  nextCheck: "Run it",
};

function summary(value: Record<string, unknown>) {
  const text = compactProductReply("done", { feature: "001-two", ...value }, "cli") ?? "";
  return JSON.parse((text.split("\n")[0] ?? "").replace("done: ", ""));
}

/** A finding was printed as a gap, as an open finding and as the reviewer's (leandef2, C7). */
it("prints a finding the review returned once, as the reviewer's", () => {
  const reply = summary({
    gaps: [`FB-1: ${problem} ${nextCheck}`, "C002: the check could not run"],
    feedbackPlan: { findings: [open, earlier] },
    critic: { reviewed: true, findings: [{ problem, nextCheck, required: true }] },
  });
  expect(reply.critic.findings).toEqual([{ problem, nextCheck, required: true }]);
  expect(reply.findings).toEqual([expect.objectContaining({ id: "FB-2" })]);
  expect(reply.gaps).toEqual({ entries: ["C002: the check could not run"], remaining: 0 });
});

it("keeps an open finding whole when no review returned it", () => {
  const reply = summary({
    gaps: [`FB-1: ${problem} ${nextCheck}`],
    feedbackPlan: { findings: [open] },
    critic: { reviewed: false, findings: [] },
    next: {
      action: "fix",
      completion: "handoff",
      objective: "The independent review budget is spent.",
      evidence: [`${problem}. Next check: ${nextCheck}`, "O001: unclear"],
    },
  });
  expect(reply.findings).toEqual([expect.objectContaining({ id: "FB-1", recheck: open.recheck })]);
  expect(reply.gaps).toBeUndefined();
  expect(reply.next.open).toEqual({ entries: ["O001: unclear"], remaining: 0 });
});
