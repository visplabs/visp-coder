import { afterEach, it, vi } from "vitest";
import { DECLINED_TESTER, FakeModels } from "./support/fake-models.js";
import { BRIEF, CLAUDE, GOAL, GoldenProject, REQUEST, Recorder } from "./support/project.js";

/**
 * `workflow.regressionGate`: an existing test of the changed module passed before the change and
 * fails after it. `advise` reports it in the done reply and the reviewer packet; `gate` blocks
 * done, spends no review, and closes once the test passes again.
 */
vi.mock("node:dns/promises", () => ({ lookup: async () => ({ address: "127.0.0.1", family: 4 }) }));
const models = FakeModels.install();
const EXISTING = {
  "src/value.mjs": 'export const value = 1;\nexport const label = "one";\n',
  "test/label.test.mjs": [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { label } from "../src/value.mjs";',
    'test("label is one", () => assert.equal(label, "one"));',
    "",
  ].join("\n"),
};
const BROKEN = 'export const value = 2;\nexport const label = "two";\n';
const KEPT = 'export const value = 2;\nexport const label = "one";\n';

let project: GoldenProject | undefined;
afterEach(async () => {
  await project?.destroy();
  project = undefined;
});

it("advise: reports a regression in the done reply and the reviewer packet", async () => {
  project = await GoldenProject.create({
    ...CLAUDE,
    workflow: { regressionGate: "advise" },
    files: EXISTING,
  });
  await models.plan({ tester: DECLINED_TESTER, reviews: ["satisfied"] });
  const run = new Recorder(project, "regression-gate/advise");
  await run.cli("01-feature", ["feature", GOAL, "--source-brief", REQUEST]);
  await models.clear();
  await project.writeBrief(BRIEF);
  await run.cli("02-work", ["work"]);
  await project.workspace.write("src/value.mjs", BROKEN);
  await run.cli("03-done-regression", ["done"]);
  await run.models("03-done-regression", models);
  await run.cli("04-next", ["next"]);
});

it("gate: blocks done on a regression, then closes once the test passes again", async () => {
  project = await GoldenProject.create({
    ...CLAUDE,
    workflow: { regressionGate: "gate" },
    files: EXISTING,
  });
  await models.plan({ tester: DECLINED_TESTER, reviews: ["satisfied"] });
  const run = new Recorder(project, "regression-gate/gate");
  await run.cli("01-feature", ["feature", GOAL, "--source-brief", REQUEST]);
  await models.clear();
  await project.writeBrief(BRIEF);
  await run.cli("02-work", ["work"]);
  await project.workspace.write("src/value.mjs", BROKEN);
  await run.cli("03-done-blocked", ["done"]);
  await run.models("03-done-blocked", models);
  await run.cli("04-next", ["next"]);
  await project.workspace.write("src/value.mjs", KEPT);
  await run.cli("05-done-repaired", ["done"]);
  await run.models("05-done-repaired", models);
  await run.cli("06-next", ["next"]);
});
