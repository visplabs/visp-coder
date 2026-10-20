import { spawnSync } from "node:child_process";
import { afterEach, it } from "vitest";
import { runHook, SESSION } from "./support/hooks.js";
import { GoldenProject, Recorder } from "./support/project.js";

/**
 * Codex's installed hook script driven with the inputs Codex sends, and what the Git
 * pre-commit hook prints when a commit is refused or allowed.
 */
let project: GoldenProject | undefined;
afterEach(async () => {
  await project?.destroy();
  project = undefined;
});

it("answers Codex's prompt, shell, stop and apply_patch hooks", async () => {
  project = await GoldenProject.create({ harness: "codex" });
  const run = new Recorder(project, "hooks/codex");
  const script = ".visp/hooks/codex-hooks.mjs";
  const codex = (name: string, input: Record<string, unknown>) =>
    run.save(
      `${name}.txt`,
      runHook(project?.root ?? "", script, { session_id: SESSION, cwd: project?.root, ...input }),
    );
  await codex("01-prompt", {
    hook_event_name: "UserPromptSubmit",
    prompt: "Make the public value module return two instead of one.",
  });
  await project.startFeature();
  await project.cli("work");
  await codex("02-bash-delete-tests", {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "rm -rf acceptance" },
  });
  await codex("03-stop-work", { hook_event_name: "Stop" });
  const patch = (...lines: string[]) => ({
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    tool_input: { command: ["*** Begin Patch", ...lines, "*** End Patch", ""].join("\n") },
  });
  await codex(
    "04-patch-in-scope",
    patch(
      "*** Update File: src/value.mjs",
      "@@",
      "-export const value = 1;",
      "+export const value = 2;",
    ),
  );
  await codex(
    "05-patch-out-of-scope",
    patch(
      "*** Update File: src/value.mjs",
      "@@",
      "-export const value = 1;",
      "+export const value = 2;",
      "*** Add File: README.md",
      "+# Value",
    ),
  );
  await codex("06-patch-unreadable", patch("*** Rename File: README.md"));
});

it("refuses an out-of-scope commit in the Git hook", async () => {
  project = await GoldenProject.create();
  const run = new Recorder(project, "hooks/git");
  await project.startFeature();
  await project.cli("work");
  const commit = async (name: string, path: string) => {
    await project?.workspace.write(path, "export const value = 2;\n");
    spawnSync("git", ["add", path], { cwd: project?.root });
    const result = spawnSync("git", ["commit", "-q", "-m", `change ${path}`], {
      cwd: project?.root,
      encoding: "utf8",
    });
    await run.save(
      `${name}.txt`,
      [
        `$ git commit (staged ${path})`,
        "--- stdout",
        result.stdout,
        "--- stderr",
        result.stderr,
        `--- exit ${result.status}`,
      ].join("\n"),
    );
  };
  await commit("01-commit-out-of-scope", "README.md");
  spawnSync("git", ["reset", "-q", "README.md"], { cwd: project.root });
  await commit("02-commit-in-scope", "src/value.mjs");
});
