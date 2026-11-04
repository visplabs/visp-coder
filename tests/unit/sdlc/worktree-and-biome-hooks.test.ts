import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHook } from "./support/sdlc-repo.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

describe("worktree create hook", () => {
  it("branches a new worktree from origin/develop and prints its path last", () => {
    const root = mkdtempSync(join(tmpdir(), "sdlc-worktree-"));
    roots.push(root);
    const origin = join(root, "origin");
    const clone = join(root, "clone");
    git(root, "init", "-q", "-b", "develop", origin);
    git(
      origin,
      "-c",
      "user.email=t@e",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "a",
    );
    git(root, "clone", "-q", origin, clone);
    git(
      origin,
      "-c",
      "user.email=t@e",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "b",
    );
    const tip = git(origin, "rev-parse", "HEAD");

    const result = runHook(
      "worktree-create.mjs",
      { hook_event_name: "WorktreeCreate", name: "bold-oak", cwd: clone },
      { SDLC_WORKTREE_SETUP: "0", SDLC_OWNER: "" },
    );
    expect(result.status, result.stderr).toBe(0);
    const path = result.stdout.trim().split("\n").at(-1) ?? "";
    expect(path).toBe(join(clone, ".claude/worktrees/bold-oak"));
    expect(git(path, "rev-parse", "HEAD")).toBe(tip);
    expect(git(path, "branch", "--show-current")).toBe("sdlc/bold-oak");
  });
});

describe("biome feedback hook", () => {
  function repoWithFile(content: string) {
    const root = mkdtempSync(join(tmpdir(), "sdlc-biome-"));
    roots.push(root);
    git(root, "init", "-q");
    writeFileSync(join(root, "biome.json"), JSON.stringify({ files: { includes: ["**/*.ts"] } }));
    writeFileSync(join(root, "bad.ts"), content);
    return root;
  }

  function edited(root: string) {
    return runHook("biome-feedback.mjs", {
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(root, "bad.ts") },
      cwd: root,
    });
  }

  it("tells the agent about Biome errors in the file it just wrote", () => {
    const root = repoWithFile("export function f() {\n  debugger;\n}\n");
    const result = edited(root);
    expect(result.status, result.stderr).toBe(0);
    const context = JSON.stringify(result.json);
    expect(context).toContain("additionalContext");
    expect(context).toContain("noDebugger");
  });

  it("stays quiet for a clean file", () => {
    const root = repoWithFile("export const a = 1;\n");
    expect(existsSync(join(root, "bad.ts"))).toBe(true);
    expect(edited(root).stdout.trim()).toBe("");
  });
});
