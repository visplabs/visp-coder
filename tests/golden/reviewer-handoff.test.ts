import { afterEach, it, vi } from "vitest";
import { DECLINED_TESTER, FakeModels } from "./support/fake-models.js";
import { runHook, SESSION } from "./support/hooks.js";
import { BRIEF, CODEX, GOAL, GoldenProject, REQUEST, Recorder } from "./support/project.js";

/**
 * VISP's reviewer through MCP tools, with a budget of one review: the worker repairs the
 * finding, the reviewer cannot run again, and what is open goes to the human through `visp pr`.
 */
vi.mock("node:dns/promises", () => ({ lookup: async () => ({ address: "127.0.0.1", family: 4 }) }));
const models = FakeModels.install();

let project: GoldenProject | undefined;
afterEach(async () => {
  await project?.destroy();
  project = undefined;
});

it("hands open findings to visp pr once the review budget is spent", async () => {
  project = await GoldenProject.create({
    ...CODEX,
    critic: { ...CODEX.critic, maxCalls: 1 },
  });
  await models.plan({ tester: DECLINED_TESTER, reviews: ["failed"] });
  const run = new Recorder(project, "reviewer/handoff");
  await run.mcp("01-feature", "visp_feature", { goal: GOAL, sourceBrief: REQUEST });
  await run.models("01-feature", models);
  await run.mcp("02-brief-patch", "visp_brief", {
    patch: BRIEF,
    reason: "Define the first usable behavior",
  });
  await run.mcp("03-work", "visp_work");
  await project.setValue(2);
  await run.mcp("04-done-findings", "visp_done");
  await run.models("04-done-findings", models);
  await run.mcp("05-work-reopen", "visp_work", { task: "T001" });
  await project.workspace.write(
    "src/value.mjs",
    "export const value = 2;\nexport default value;\n",
  );
  await run.mcp("06-done-budget-spent", "visp_done");
  await run.models("06-done-budget-spent", models);
  await run.mcp("07-next-handoff", "visp_next");
  await run.cli("07-next-handoff", ["next"]);
  await run.cli("08-accept-handoff", ["accept"]);
  await run.cli("09-pr", ["pr"]);
  // The record as data: the fields tools such as the reviewer study read.
  await run.cli("09b-pr-json", ["pr", "--json"]);
  await run.save(
    "10-stop-hook.txt",
    runHook(project.root, ".visp/hooks/codex-hooks.mjs", {
      session_id: SESSION,
      cwd: project.root,
      hook_event_name: "Stop",
    }),
  );
});
