import { describe, expect, it } from "vitest";
import type { ProductCheck } from "../../../../src/workflow/product/model.js";
import {
  type RegressionCandidate,
  selectRegressionCandidates,
} from "../../../../src/workflow/product/regression/regression-selection.js";

const check = (id: string, ...command: [string, ...string[]]): ProductCheck => ({
  id,
  command,
  outcomes: [],
  files: [],
  environment: "other",
});
const graph = (path: string, distance: number): RegressionCandidate => ({
  label: path,
  origin: "graph",
  distance,
  check: check("REGRESSION", "node", "--test", path),
});
const declared = (
  label: string,
  origin: RegressionCandidate["origin"],
  ...command: [string, ...string[]]
) => ({
  label,
  origin,
  check: check("C001", ...command),
});

describe("selectRegressionCandidates", () => {
  it("orders direct tests, this feature's earlier tests, earlier features' tests, then distant tests", () => {
    const { selected, overCap } = selectRegressionCandidates(
      [
        graph("test/far.test.mjs", 3),
        declared("F-a PINNED_1", "earlier-feature", "node", "acceptance/a.mjs"),
        graph("test/near.test.mjs", 1),
        declared("C002", "feature", "node", "checks/two.mjs"),
      ],
      10,
    );
    expect(selected.map((entry) => entry.label)).toEqual([
      "test/near.test.mjs",
      "C002",
      "F-a PINNED_1",
      "test/far.test.mjs",
    ]);
    expect(overCap).toEqual([]);
  });

  it("runs one command once and reports what the cap left out", () => {
    const { selected, overCap } = selectRegressionCandidates(
      [
        graph("test/a.test.mjs", 1),
        declared("C002", "feature", "node", "--test", "test/a.test.mjs"),
        graph("test/b.test.mjs", 1),
        graph("test/c.test.mjs", 2),
      ],
      2,
    );
    expect(selected.map((entry) => entry.label)).toEqual(["test/a.test.mjs", "test/b.test.mjs"]);
    expect(overCap.map((entry) => entry.label)).toEqual(["test/c.test.mjs"]);
  });
});
