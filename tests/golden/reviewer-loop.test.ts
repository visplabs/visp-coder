import { afterEach, it, vi } from "vitest";
import { FakeModels, testerSuite } from "./support/fake-models.js";
import { CODEX, FULL, GOAL, GoldenProject, REQUEST, Recorder } from "./support/project.js";

/**
 * The loop as `visp init` sets it up for Codex: VISP launches its own tester when the feature
 * starts and its own reviewer inside `visp done`. Captures what those models are sent and what
 * the worker reads back: findings, their repair, acceptance and the reviewer handoff.
 */
vi.mock("node:dns/promises", () => ({ lookup: async () => ({ address: "127.0.0.1", family: 4 }) }));
const models = FakeModels.install();

let project: GoldenProject | undefined;
afterEach(async () => {
  await project?.destroy();
  project = undefined;
});

it("tests, reviews, repairs and accepts with VISP's own models", async () => {
  project = await GoldenProject.create({ ...CODEX, workflow: FULL });
  await models.plan({
    tester: testerSuite([["value is two", "value === 2"]]),
    reviews: ["failed", "satisfied"],
  });
  const run = new Recorder(project, "reviewer/loop");
  await run.cli("01-feature", ["feature", GOAL, "--source-brief", REQUEST]);
  await run.models("01-feature", models);
  await project.writeBrief();
  await run.cli("02-work", ["work"]);
  await run.cli("03-done-failing", ["done"]);
  await run.cli("04-next-checks-failing", ["next"]);
  await project.setValue(2);
  await run.cli("05-done-findings", ["done"]);
  await run.models("05-done-findings", models);
  await run.cli("06-next-findings-open", ["next"]);
  await run.mcp("06-next-findings-open", "visp_next");
  await run.cli("07-work-reopen", ["work", "--task", "T001"]);
  await project.workspace.write(
    "src/value.mjs",
    "export const value = 2;\nexport default value;\n",
  );
  await run.cli("08-done-repaired", ["done"]);
  await run.models("08-done-repaired", models);
  await run.cli("09-next-ready", ["next"]);
  await run.mcp("09-next-ready", "visp_next");
  await run.cli("10-accept", ["accept"]);
  await run.models("10-accept", models);
  await run.cli("11-next-accepted", ["next"]);
  await run.mcp("11-next-accepted", "visp_next");
  await run.cli("12-pr", ["pr"]);
});
