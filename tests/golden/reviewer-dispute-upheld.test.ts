import { afterEach, it, vi } from "vitest";
import { FakeModels } from "./support/fake-models.js";
import {
  CODEX,
  DISPUTE,
  DISPUTED_SUITE,
  FULL,
  GOAL,
  GoldenProject,
  REQUEST,
  Recorder,
} from "./support/project.js";

/**
 * A pinned acceptance test that contradicts the request: the worker disputes it in `visp done`
 * and VISP's reviewer rules on it.
 */
vi.mock("node:dns/promises", () => ({ lookup: async () => ({ address: "127.0.0.1", family: 4 }) }));
const models = FakeModels.install();

let project: GoldenProject | undefined;
afterEach(async () => {
  await project?.destroy();
  project = undefined;
});

it("waives a disputed pinned test the reviewer upholds", async () => {
  project = await GoldenProject.create({ ...CODEX, workflow: FULL });
  await models.plan({ tester: DISPUTED_SUITE, reviews: ["satisfied"], ruling: "upheld" });
  const run = new Recorder(project, "reviewer/dispute-upheld");
  await run.cli("01-feature", ["feature", GOAL, "--source-brief", REQUEST]);
  await models.clear();
  await project.writeBrief();
  await run.cli("02-work", ["work"]);
  await project.setValue(2);
  await run.cli("03-done-pinned-failing", ["done"]);
  await run.cli("04-next-pinned-failing", ["next"]);
  await run.cli("05-done-dispute", ["done", ...DISPUTE]);
  await run.models("05-done-dispute", models);
  await run.cli("06-next", ["next"]);
  await run.cli("07-accept", ["accept"]);
  await run.cli("08-pr", ["pr"]);
});
