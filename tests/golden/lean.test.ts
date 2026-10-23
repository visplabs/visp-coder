import { afterEach, expect, it, vi } from "vitest";
import { DECLINED_TESTER, FakeModels, testerSuite } from "./support/fake-models.js";
import { BRIEF, CLAUDE, GOAL, GoldenProject, REQUEST, Recorder } from "./support/project.js";

/**
 * The default lean profile: a picture request is drafted before any check, the reviewer tags
 * gaps against the request and VISP makes them required while other findings become notes, and
 * only the completing slice is reviewed, by the cheaper lean reviewer.
 */
vi.mock("node:dns/promises", () => ({ lookup: async () => ({ address: "127.0.0.1", family: 4 }) }));
const models = FakeModels.install();
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
  project = await GoldenProject.create({ ...CLAUDE, files: PICTURE_CHECK });
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

// A render that fails sent the reviewer `images: []` and no word of the picture; with no
// browser here every render fails, so the packet must name the picture it cannot show.
it("names a drafted picture VISP could not render, rather than sending no image", async () => {
  vi.stubEnv("CHROME_BIN", "/missing/chrome");
  try {
    project = await GoldenProject.create({ ...CLAUDE, files: PICTURE_CHECK });
    await models.plan({ tester: DECLINED_TESTER, reviews: ["satisfied"] });
    const run = new Recorder(project, "lean/picture-unrendered");
    await run.cli("01-feature", ["feature", "Draw a PS5 controller", "--source-brief", PICTURE]);
    await run.models("01-feature", models);
    await run.cli("02-work-draft", ["work"]);
    await project.workspace.write(
      "controller.svg",
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40"><rect width="80" height="40" fill="#222"/></svg>\n',
    );
    await run.cli("03-work-check", ["work", "--check", "node checks/picture.check.mjs"]);
    await run.cli("04-done", ["done"]);
    await run.models("04-done", models);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("reviews only the slice that completes the feature", async () => {
  const [check] = BRIEF.checks;
  const [slice] = BRIEF.slices;
  project = await GoldenProject.create(CLAUDE);
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

it("lists the request's requirements and closes once each is accounted for", async () => {
  project = await GoldenProject.create(CLAUDE);
  await models.plan({ reviews: ["satisfied"] });
  const run = new Recorder(project, "lean/requirements");
  const request = [
    "Change the public value module:",
    "- `value` returns two instead of one.",
    '- Add a `label` export that is "two".',
  ].join("\n");
  await run.cli("01-feature", ["feature", GOAL, "--source-brief", request]);
  await run.cli("02-work", ["work", "--check", "node checks/value.check.mjs"]);
  await project.setValue(2);
  await run.cli("03-done-unaccounted", ["done"]);
  await run.models("03-done-unaccounted", models);
  await run.cli("04-next", ["next"]);
  await run.cli("05-done-accounted", [
    "done",
    "--account",
    "R001=C001 value is two",
    "R002=not done: the label export is left for a later request",
  ]);
  await run.cli("06-next", ["next"]);
});

it("starts the lean slice in the feature command, and marks tests the check does not show", async () => {
  project = await GoldenProject.create(CLAUDE);
  await models.plan({ reviews: ["satisfied"] });
  const run = new Recorder(project, "lean/feature-check");
  const request = [
    "Change the public value module:",
    "- `value` returns two instead of one.",
    '- Add a `label` export that is "two".',
  ].join("\n");
  await run.cli("01-feature-check", [
    "feature",
    GOAL,
    "--check",
    "node checks/value.check.mjs",
    "--source-brief",
    request,
  ]);
  await project.setValue(2);
  await run.cli("02-done-claimed", [
    "done",
    "--account",
    "R001=C001 value_is_two",
    "R002=not done: the label export is left for a later request",
  ]);
  await run.models("02-done-claimed", models);
  await run.cli("03-pr", ["pr"]);
});

/**
 * D13: a lean feature runs no VISP reviewer unless the project or the user set the critic's
 * mode. In batch B2 lean with the reviewer and lean without it scored the same hidden checks and
 * probes, and the reviewer cost more. The critic's launch and model stay configured.
 */
const LAUNCH_ONLY = { critic: { harness: "claude-code", launch: "claude-exec" } };
const reviews = async () => (await models.calls()).filter((call) => call.role === "reviewer");

it("runs no reviewer on a lean feature when no critic mode is set", async () => {
  project = await GoldenProject.create({ harness: "claude-code", ...LAUNCH_ONLY });
  await models.plan({ reviews: ["satisfied"] });
  const run = new Recorder(project, "lean/reviewer-off");
  await run.cli("01-feature-check", [
    "feature",
    GOAL,
    "--check",
    "node checks/value.check.mjs",
    "--source-brief",
    REQUEST,
  ]);
  await run.models("01-feature-check", models);
  await project.setValue(2);
  await run.cli("02-done", ["done"]);
  expect(await reviews()).toEqual([]);
  await run.models("02-done", models);
  await run.cli("03-next", ["next"]);
  await run.cli("04-accept", ["accept"]);
  expect(await reviews()).toEqual([]);
});

// A feature that leaves lean (here a check failed on two versions) gets the full loop's reviewer.
it("turns the reviewer on when a lean feature escalates to the full profile", async () => {
  project = await GoldenProject.create({ harness: "claude-code", ...LAUNCH_ONLY });
  await models.plan({ reviews: ["satisfied"] });
  const run = new Recorder(project, "lean/reviewer-escalated");
  await run.cli("01-feature-check", [
    "feature",
    GOAL,
    "--check",
    "node checks/value.check.mjs",
    "--source-brief",
    REQUEST,
  ]);
  await models.clear();
  await project.setValue(3);
  await run.cli("02-done-failing", ["done"]);
  await project.setValue(4);
  await run.cli("03-done-failing-again", ["done"]);
  await project.setValue(2);
  await run.cli("04-done-escalated", ["done"]);
  expect(await reviews()).toHaveLength(1);
  await run.models("04-done-escalated", models);
});
