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

it("keeps a disputed pinned test the reviewer rejects", async () => {
  project = await GoldenProject.create({ ...CODEX, workflow: FULL });
  await models.plan({ tester: DISPUTED_SUITE, reviews: ["satisfied"], ruling: "rejected" });
  const run = new Recorder(project, "reviewer/dispute-rejected");
  await run.cli("01-feature", ["feature", GOAL, "--source-brief", REQUEST]);
  await models.clear();
  await project.writeBrief();
  await run.cli("02-work", ["work"]);
  await project.setValue(2);
  await run.mcp("03-done-dispute", "visp_done", {
    dispute: ["value is odd"],
    reason: "The request says return two; two is even",
  });
  await run.models("03-done-dispute", models);
  await run.cli("04-next", ["next"]);
  await run.cli("05-done-dispute-again", ["done", ...DISPUTE]);
  await run.cli("06-next", ["next"]);
});
