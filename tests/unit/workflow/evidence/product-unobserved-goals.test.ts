import { expect, it } from "vitest";
import type { ProductExecution } from "../../../../src/workflow/product/model.js";
import { reviewCheckResult } from "../../../../src/workflow/product/review/review-check-context.js";
import {
  notObservedGoals,
  unobservedGoalRounds,
} from "../../../../src/workflow/product/unobserved-goals.js";

const LEVEL3 = "level 3 can be won";

function run(subjectDigest: string, createdAt: string, output: string): ProductExecution {
  return {
    id: `EXEC-${subjectDigest}-${createdAt}`,
    check: "PINNED_1",
    subjectDigest,
    contractDigest: "contract",
    createdAt,
    command: "node acceptance/game.acceptance.mjs",
    status: "passed",
    exitCode: 0,
    durationMs: 1,
    output,
    provenance: "supervisor-executed",
    assertions: "runner-observed",
  };
}
const review = (subjectDigest: string, createdAt: string, unavailable = false) => ({
  subjectDigest,
  createdAt,
  ...(unavailable ? { reviewer: { context: "unavailable" } } : {}),
});
const record = (executions: ProductExecution[], reviews: ReturnType<typeof review>[]) =>
  ({ state: { executions, reviews } }) as unknown as Parameters<typeof unobservedGoalRounds>[0];

it("keys a NOT OBSERVED goal without its attempt count, keeping names with colons whole", () => {
  expect(
    notObservedGoals(
      [
        "PASS: level 1 can be won",
        `NOT OBSERVED: ${LEVEL3}: 150 attempts`,
        `  NOT OBSERVED: ${LEVEL3}: 148 attempts`,
        "NOT OBSERVED: Level: win: 4000 attempts",
        "NOT OBSERVED: after winning the last level Play again returns to level 1: level 3 not won",
        "NOT OBSERVED: retry after error",
      ].join("\n"),
    ),
  ).toEqual([
    LEVEL3,
    "Level: win",
    "after winning the last level Play again returns to level 1: level 3 not won",
    "retry after error",
  ]);
});

// kd1-slingshot-game-visp-kcand-5: reviews at 33 and 47 minutes both held the outcome for level 3
// NOT OBSERVED, and the worker retuned levels until the 3600 s cap.
it("spends a goal's one repair round once a review saw it and a later version still misses it", () => {
  const rounds = unobservedGoalRounds(
    record(
      [
        run("A", "2026-10-21T06:20:00.000Z", `NOT OBSERVED: ${LEVEL3}: 150 attempts`),
        run("B", "2026-10-21T06:40:00.000Z", `NOT OBSERVED: ${LEVEL3}: 150 attempts`),
      ],
      [review("A", "2026-10-21T06:27:00.000Z")],
    ),
    "B",
  );
  expect(rounds).toEqual({ goals: [LEVEL3], spent: [LEVEL3] });
});

it("keeps a goal's round open until the product changed after the review that saw it", () => {
  const sameVersion = record(
    [run("A", "2026-10-21T06:20:00.000Z", `NOT OBSERVED: ${LEVEL3}: 150 attempts`)],
    [review("A", "2026-10-21T06:27:00.000Z")],
  );
  expect(unobservedGoalRounds(sameVersion, "A")).toEqual({ goals: [LEVEL3], spent: [] });
  const otherGoal = record(
    [
      run("A", "2026-10-21T06:20:00.000Z", "NOT OBSERVED: level 2 can be won: 150 attempts"),
      run("B", "2026-10-21T06:40:00.000Z", `NOT OBSERVED: ${LEVEL3}: 150 attempts`),
    ],
    [review("A", "2026-10-21T06:27:00.000Z")],
  );
  expect(unobservedGoalRounds(otherGoal, "B")).toEqual({ goals: [LEVEL3], spent: [] });
  const noReviewer = record(
    [
      run("A", "2026-10-21T06:20:00.000Z", `NOT OBSERVED: ${LEVEL3}: 150 attempts`),
      run("B", "2026-10-21T06:40:00.000Z", `NOT OBSERVED: ${LEVEL3}: 150 attempts`),
    ],
    [review("A", "2026-10-21T06:27:00.000Z", true)],
  );
  expect(unobservedGoalRounds(noReviewer, "B")).toEqual({ goals: [LEVEL3], spent: [] });
  const observed = record(
    [
      run("A", "2026-10-21T06:20:00.000Z", `NOT OBSERVED: ${LEVEL3}: 150 attempts`),
      run("B", "2026-10-21T06:40:00.000Z", `PASS: ${LEVEL3}`),
    ],
    [review("A", "2026-10-21T06:27:00.000Z")],
  );
  expect(unobservedGoalRounds(observed, "B")).toEqual({ goals: [], spent: [] });
});

it("tells the reviewer not to hold an outcome for a goal whose round is spent", () => {
  const execution = run("B", "2026-10-21T06:40:00.000Z", `NOT OBSERVED: ${LEVEL3}: 150 attempts`);
  const fresh = reviewCheckResult(execution);
  expect(fresh).toContain("It gets one repair round.");
  expect(fresh).not.toContain("Repair round spent");
  const spent = reviewCheckResult(execution, undefined, { spentGoals: [LEVEL3] });
  expect(spent).toContain(
    `Repair round spent: "${LEVEL3}" was NOT OBSERVED at an earlier review and still is after the product changed. Do not hold an outcome or report a finding for it; list it in limitations as unverified, and judge the rest of each outcome as usual.`,
  );
});
