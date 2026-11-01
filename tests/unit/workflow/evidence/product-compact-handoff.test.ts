import { expect, it } from "vitest";
import { compactProductReply } from "../../../../src/workflow/product-compact-text.js";

const handoff = {
  action: "fix",
  completion: "handoff",
  objective: "The independent review budget is spent. Run nothing more for it",
  evidence: ["The module has no default export. Next check: import it", "O001: unclear"],
  mayEdit: true,
};

/** A handoff ends the loop, so `done` carries what is open instead of sending the worker to `pr`. */
it.each(["done", "accept"])("prints what a handoff leaves open in the %s reply", (operation) => {
  const text = compactProductReply(operation, { feature: "001-two", next: handoff }, "cli") ?? "";
  const summary = JSON.parse((text.split("\n")[0] ?? "").replace(`${operation}: `, ""));
  expect(summary.next).toEqual({
    action: "fix",
    objective: handoff.objective,
    completion: "handoff",
    open: { entries: handoff.evidence, remaining: 0 },
  });
});

it("keeps other next steps to their action, objective and command", () => {
  const next = {
    action: "accept",
    objective: "Run final checks",
    command: "visp accept --feature 001-two",
    evidence: ["C001: passed"],
    mayEdit: false,
  };
  const text = compactProductReply("done", { feature: "001-two", next }, "cli") ?? "";
  const summary = JSON.parse((text.split("\n")[0] ?? "").replace("done: ", ""));
  expect(summary.next).toEqual({
    action: "accept",
    objective: "Run final checks",
    command: "visp accept --feature 001-two",
  });
});
