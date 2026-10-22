import { afterEach, it, vi } from "vitest";
import { FakeModels, testerSuite } from "./support/fake-models.js";
import { BRIEF, CODEX, FULL, GOAL, GoldenProject, REQUEST, Recorder } from "./support/project.js";

/**
 * A feature in two slices with one review call: the first slice closes while the pinned tests
 * still fail and without spending the review, which is kept for the completing slice.
 */
vi.mock("node:dns/promises", () => ({ lookup: async () => ({ address: "127.0.0.1", family: 4 }) }));
const models = FakeModels.install();
const [VALUE_CHECK] = BRIEF.checks;
const [VALUE_SLICE] = BRIEF.slices;
const TWO_SLICES = {
  ...BRIEF,
  outcomes: [
    ...BRIEF.outcomes,
    {
      id: "O002",
      kind: "functional",
      statement: "The module also exports the label two",
      priority: "must",
      provenance: "user-stated",
    },
  ],
  checks: [
    VALUE_CHECK,
    {
      ...VALUE_CHECK,
      id: "C002",
      command: ["node", "checks/value.check.mjs", "label"],
      outcomes: ["O002"],
    },
  ],
  slices: [
    VALUE_SLICE,
    {
      ...VALUE_SLICE,
      id: "T002",
      goal: "Export the label",
      outcomes: ["O002"],
      checks: ["C002"],
      dependsOn: ["T001"],
    },
  ],
};

let project: GoldenProject | undefined;
afterEach(async () => {
  await project?.destroy();
  project = undefined;
});

it("closes the first slice without review and reviews the completing one", async () => {
  project = await GoldenProject.create({
    ...CODEX,
    critic: { ...CODEX.critic, maxCalls: 1 },
    workflow: FULL,
  });
  await models.plan({
    tester: testerSuite([
      ["value is two", "value === 2"],
      ["label is two", 'product.label === "two"'],
    ]),
    reviews: ["satisfied"],
  });
  const run = new Recorder(project, "two-slices/one-review");
  await run.cli("01-feature", ["feature", GOAL, "--source-brief", REQUEST]);
  await models.clear();
  await project.writeBrief(TWO_SLICES);
  await run.cli("02-next", ["next"]);
  await run.cli("03-work-first-slice", ["work"]);
  await project.setValue(2);
  await run.cli("04-done-first-slice", ["done"]);
  await run.models("04-done-first-slice", models);
  await run.cli("05-next-second-slice", ["next"]);
  await run.cli("06-work-second-slice", ["work"]);
  await project.workspace.write(
    "src/value.mjs",
    'export const value = 2;\nexport const label = "two";\n',
  );
  await run.cli("07-done-completing-slice", ["done"]);
  await run.models("07-done-completing-slice", models);
  await run.cli("08-next", ["next"]);
});
