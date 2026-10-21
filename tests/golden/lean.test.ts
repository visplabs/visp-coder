import { afterEach, it, vi } from "vitest";
import { DECLINED_TESTER, FakeModels, testerSuite } from "./support/fake-models.js";
import { BRIEF, CLAUDE, GOAL, GoldenProject, REQUEST, Recorder } from "./support/project.js";

/**
 * Lean mode: a picture request is drafted before any check (`workflow.draftFirst`), the
 * reviewer tags gaps against the request and VISP makes them required while other findings
 * become notes (`workflow.requestGaps`), and only the completing slice is reviewed
 * (`workflow.reviewCadence`).
 */
vi.mock("node:dns/promises", () => ({ lookup: async () => ({ address: "127.0.0.1", family: 4 }) }));
const models = FakeModels.install();
const LEAN = { draftFirst: "visual", reviewCadence: "feature", requestGaps: "required" };
const PICTURE = "Create an SVG of a PS5 controller in controller.svg.";
const PICTURE_CHECK = {
  "checks/picture.check.mjs":
    'import { readFileSync } from "node:fs";\nif (!readFileSync("controller.svg", "utf8").includes("<svg")) process.exit(1);\n',
};

let project: GoldenProject | undefined;
afterEach(async () => {
  await project?.destroy();
  project = undefined;
});

it("drafts a picture first, then reviews it with request gaps required", async () => {
  project = await GoldenProject.create({ ...CLAUDE, workflow: LEAN, files: PICTURE_CHECK });
  await models.plan({
    tester: DECLINED_TESTER,
    reviews: ["failed", "satisfied"],
    findings: [
      {
        problem: "Request gap: the controller has one flat colour, not the PS5's two-tone shell",
        required: false,
      },
      { problem: "The touchpad could have a subtle gradient", required: false },
    ],
  });
  const run = new Recorder(project, "lean/picture");
  await run.cli("01-feature", ["feature", "Draw a PS5 controller", "--source-brief", PICTURE]);
  await run.models("01-feature", models);
  await run.cli("02-next", ["next"]);
  await run.cli("03-work-draft", ["work"]);
  await project.workspace.write(
    "controller.svg",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40"><rect width="80" height="40" fill="#222"/></svg>\n',
  );
  await run.cli("04-next-draft", ["next"]);
  await run.cli("05-work-check", ["work", "--check", "node checks/picture.check.mjs"]);
  await run.cli("06-done-gap", ["done"]);
  await run.models("06-done-gap", models);
  await run.cli("07-work-reopen", ["work", "--task", "T001"]);
  await project.workspace.write(
    "controller.svg",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40"><rect width="80" height="40" fill="#fff"/><rect y="20" width="80" height="20" fill="#222"/></svg>\n',
  );
  await run.cli("08-done-repaired", ["done"]);
  await run.models("08-done-repaired", models);
  await run.cli("09-next", ["next"]);
});

it("reviews only the slice that completes the feature", async () => {
  const [check] = BRIEF.checks;
  const [slice] = BRIEF.slices;
  project = await GoldenProject.create({ ...CLAUDE, workflow: LEAN });
  await models.plan({
    tester: testerSuite([["value is two", "value === 2"]]),
    reviews: ["satisfied"],
  });
  const run = new Recorder(project, "lean/two-slices");
  await run.cli("01-feature", ["feature", GOAL, "--source-brief", REQUEST]);
  await models.clear();
  await project.writeBrief({
    ...BRIEF,
    checks: [check, { ...check, id: "C002" }],
    slices: [
      slice,
      { ...slice, id: "T002", goal: "Keep the value", checks: ["C002"], dependsOn: ["T001"] },
    ],
  });
  await run.cli("02-work-first-slice", ["work"]);
  await project.setValue(2);
  await run.cli("03-done-first-slice", ["done"]);
  await run.models("03-done-first-slice", models);
  await run.cli("04-work-second-slice", ["work"]);
  await project.workspace.write("src/value.mjs", "export const value = 2; // kept\n");
  await run.cli("05-done-completing-slice", ["done"]);
  await run.models("05-done-completing-slice", models);
  await run.cli("06-next", ["next"]);
});
