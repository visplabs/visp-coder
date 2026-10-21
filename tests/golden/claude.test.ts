import { afterEach, it, vi } from "vitest";
import { FakeModels, testerSuite } from "./support/fake-models.js";
import { BRIEF, CLAUDE, FULL, GOAL, GoldenProject, REQUEST, Recorder } from "./support/project.js";

/** The reviewer and tester VISP launches as `claude -p` for a Claude Code project. */
vi.mock("node:dns/promises", () => ({ lookup: async () => ({ address: "127.0.0.1", family: 4 }) }));
const models = FakeModels.install();
const TWO = testerSuite([["value is two", "value === 2"]]);

let project: GoldenProject | undefined;
afterEach(async () => {
  await project?.destroy();
  project = undefined;
});

it("launches claude -p as the tester and reviewer of a new project", async () => {
  project = await GoldenProject.create({ ...CLAUDE, workflow: FULL });
  await models.plan({ tester: TWO, reviews: ["satisfied"] });
  const run = new Recorder(project, "claude/new-project");
  await run.cli("01-feature", ["feature", GOAL, "--source-brief", REQUEST]);
  await run.models("01-feature", models);
  await project.writeBrief(BRIEF);
  await run.cli("02-work", ["work"]);
  await project.setValue(2);
  await run.cli("03-done", ["done"]);
  await run.models("03-done", models);
  await run.cli("04-next", ["next"]);
});
