import { join } from "node:path";
import { afterEach, it, vi } from "vitest";
import { FakeModels, testerSuite } from "./support/fake-models.js";
import { runHook } from "./support/hooks.js";
import { BRIEF, CLAUDE, GOAL, GoldenProject, REQUEST, Recorder } from "./support/project.js";

/**
 * A feature accepted and left uncommitted, as a Claude Code worker that commits only when the
 * user asks leaves it, and a later session whose user asks for more: `visp next`, the Stop
 * hook and `visp feature` (bench run co1-conventions-carryover-prose-visp-dev-1).
 */
vi.mock("node:dns/promises", () => ({ lookup: async () => ({ address: "127.0.0.1", family: 4 }) }));
const models = FakeModels.install();

let project: GoldenProject | undefined;
afterEach(async () => {
  await project?.destroy();
  project = undefined;
});

const NOTIFICATION = [
  "<task-notification>",
  "<task-id>b0golden</task-id>",
  "<status>completed</status>",
  '<summary>Background command "visp feature" completed (exit code 0)</summary>',
  "</task-notification>",
].join("\n");

it("starts a later session's request from the accepted feature's uncommitted work", async () => {
  project = await GoldenProject.create(CLAUDE);
  await models.plan({ tester: testerSuite([["value is two", "value === 2"]]) });
  const run = new Recorder(project, "session/accepted");
  const env = { CLAUDE_PROJECT_DIR: project.root };
  const hook = (name: string, session: string, input: Record<string, unknown>) =>
    run.save(
      `${name}.txt`,
      runHook(
        project?.root ?? "",
        ".visp/hooks/claude-pretooluse.mjs",
        { session_id: session, ...input },
        env,
      ),
    );
  const prompt = (text: string) => ({ hook_event_name: "UserPromptSubmit", prompt: text });

  await hook("01-prompt", "session-1", prompt(REQUEST));
  await run.cli("02-feature", ["feature", GOAL, "--source-brief", REQUEST]);
  await project.writeBrief(BRIEF);
  await run.cli("03-work", ["work"]);
  await project.setValue(2);
  await run.cli("04-done", ["done"]);
  await run.cli("05-accept", ["accept"]);
  await hook("06-notification", "session-1", prompt(NOTIFICATION));
  await run.cli("07-next-accepted", ["next"]);
  await hook("08-stop-accepted", "session-1", { hook_event_name: "Stop" });

  await hook("09-prompt-later-session", "session-2", prompt("Also export the value three."));
  await run.cli("10-next-later-session", ["next"]);
  await run.mcp("10-next-later-session", "visp_next");
  await hook("11-stop-before-trying", "session-2", { hook_event_name: "Stop" });
  await hook("12-write-refused", "session-2", {
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: join(project.root, "src/value.mjs"), content: "x" },
  });
  await hook("13-stop-after-refusal", "session-2", { hook_event_name: "Stop" });
  await run.cli("14-feature-from-accepted", [
    "feature",
    "Export three",
    "--source-brief",
    "Also export the value three.",
  ]);
  await run.cli("15-next-new-feature", ["next"]);
});
