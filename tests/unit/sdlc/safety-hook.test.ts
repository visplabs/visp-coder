import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const hook = join(process.cwd(), "scripts/sdlc/hooks/safety.mjs");

function runHook(command: string, options: { owner?: boolean; cwd?: string } = {}) {
  const env = { ...process.env };
  delete env.SDLC_OWNER;
  if (options.owner !== false) env.SDLC_OWNER = "1";
  const input = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    cwd: options.cwd ?? process.cwd(),
  };
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify(input),
    env,
    encoding: "utf8",
  });
}

function repoOnBranch(branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-safety-"));
  spawnSync("git", ["init", "-q", "-b", branch, dir]);
  return dir;
}

describe("sdlc safety hook", () => {
  const repos: string[] = [];
  afterAll(() => {
    for (const dir of repos) rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    "git push --force origin feat/x",
    "git push -f",
    "git push -uf origin feat/x",
    "git push --force-with-lease origin feat/x",
    "git push origin +feat/x",
    "git push origin main",
    "git push origin HEAD:develop",
    "git push origin refs/heads/develop",
    "git push --tags",
    "git push origin refs/tags/v1.0.0",
    "git push origin --delete feat/x",
    "git push origin :feat/x",
    "git -C ../other push --force",
    "git tag v1.0.0",
    "git tag -a v1.0.0 -m release",
    "git tag -d v1.0.0",
    "gh pr merge 12 --squash",
    "gh release create v1.0.0",
    "gh release edit v1.0.0 --draft=false",
    "gh repo delete visplabs/visp-coder",
    "npm publish",
    "pnpm publish --tag beta",
    "npm stage approve 123",
    "npm dist-tag add pkg@1.0.0 latest",
    "npm unpublish pkg@1.0.0",
    "git branch -D feat/x",
    "git branch --delete feat/x",
    "git worktree remove ../visp-coder-x",
    "git worktree prune",
    "git clean -fdx",
    "git clean -X -f",
    "gh auth token",
    "secret-tool lookup service gh",
    "cat ~/.config/gh/hosts.yml",
    "git credential fill",
    "pnpm lint && git push --force origin feat/x",
    "pnpm test; gh pr merge 3",
    'bash -c "git push -f origin feat/x"',
    "SOME=1 git push origin main",
    "sudo npm publish",
  ])("blocks %s", (command) => {
    const result = runHook(command);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain("sdlc safety");
  });

  it.each([
    "git push -u origin chore/sdlc-safety-gates",
    "git push origin feat/x:feat/x",
    "git tag",
    "git tag -l 'v*'",
    "git tag --list",
    "gh pr create --base develop --title x --body y",
    "gh pr view 12",
    "gh release view v1.0.0",
    "gh release list",
    "git branch",
    "git branch -a",
    "git clean -n",
    "git worktree list",
    "git worktree add ../x -b y origin/develop",
    "npm view @visporg/visp-coder",
    "pnpm test",
    'git commit -m "docs: never git push --force or gh pr merge"',
    "echo 'npm publish happens on main only'",
    "grep -rn 'git push' docs",
  ])("allows %s", (command) => {
    const result = runHook(command);
    expect(result.status, result.stderr).toBe(0);
  });

  it("blocks a bare push from develop and allows it from a topic branch", () => {
    const develop = repoOnBranch("develop");
    const topic = repoOnBranch("feat/x");
    repos.push(develop, topic);
    expect(runHook("git push", { cwd: develop }).status).toBe(2);
    expect(runHook("git push", { cwd: topic }).status).toBe(0);
  });

  it("does nothing unless SDLC_OWNER is 1", () => {
    expect(runHook("git push --force", { owner: false }).status).toBe(0);
  });

  it("ignores tools other than Bash", () => {
    const input = { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} };
    const result = spawnSync(process.execPath, [hook], {
      input: JSON.stringify(input),
      env: { ...process.env, SDLC_OWNER: "1" },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
  });
});
