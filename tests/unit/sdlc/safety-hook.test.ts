import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const hook = join(process.cwd(), "scripts/sdlc/hooks/safety.mjs");
const scratch = mkdtempSync(join(tmpdir(), "sdlc-safety-log-"));

function runHook(
  command: string,
  options: { owner?: boolean; cwd?: string; agentType?: string } = {},
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SDLC_MISTAKE_LOG: join(scratch, "mistakes.jsonl"),
  };
  delete env.SDLC_OWNER;
  if (options.owner !== false) env.SDLC_OWNER = "1";
  const input = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    cwd: options.cwd ?? process.cwd(),
    ...(options.agentType ? { agent_id: "a1", agent_type: options.agentType } : {}),
  };
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify(input),
    env,
    encoding: "utf8",
  });
}

// The repository's own mistake log, which a test run must leave alone.
function realLogLines(): number {
  const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
  }).stdout.trim();
  const log = join(common, "..", ".sdlc", "mistakes.jsonl");
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").length : 0;
}

describe("the mistake log in tests", () => {
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it("keeps refusals out of the repository's own log", () => {
    const before = realLogLines();
    expect(runHook("git push --force origin topic").status).toBe(2);
    expect(realLogLines()).toBe(before);
  });
});

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
    "GH_CONFIG_DIR= gh issue comment 12 --body x",
    "env -u GH_CONFIG_DIR gh pr create",
    "unset GH_CONFIG_DIR",
    "export GH_TOKEN=abc",
    "gh issue edit 12 --body x",
    "gh issue edit 12 --body-file spec.md",
    "gh issue delete 12",
    "gh issue unlock 12",
    "gh api -X PATCH repos/o/r/issues/12",
    "gh api --method DELETE repos/o/r/issues/comments/5",
    "cat ~/.codex-visp/auth.json",
    "cp /home/u/.codex/auth.json /tmp/a",
    "CODEX_HOME=/tmp/x pnpm sdlc review --task VISP-2/VISP-3 --round 1",
    "export CODEX_HOME=/tmp/x",
    "export CLAUDE_CODE_SUBAGENT_MODEL_FORCE=claude-haiku-5-5",
    "CLAUDE_CODE_SUBAGENT_MODEL=haiku claude -p hi",
    "CLAUDE_CODE_EFFORT_LEVEL=low claude -p hi",
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
    "gh issue create --title t --body b --label sdlc:task",
    "gh issue comment 12 --body 'task T-13 done'",
    "gh issue edit 13 --add-label sdlc:task",
    "gh api repos/{owner}/{repo}/issues/12/sub_issues",
    "gh api -X POST repos/o/r/issues/12/sub_issues -F sub_issue_id=7",
  ])("allows %s", (command) => {
    const result = runHook(command);
    expect(result.status, result.stderr).toBe(0);
  });

  it("lets an agent remove a worktree it made in the temp folder, and no other", () => {
    // Pilot 2: qe-verify added a base worktree for a comparison and could not remove it.
    const temporary = join(tmpdir(), "sdlc-qe", "base-wt");
    expect(runHook(`git worktree remove --force ${temporary}`).status).toBe(0);
    expect(runHook(`git worktree remove ${join(tmpdir(), "..", "home", "x")}`).status).toBe(2);
    expect(runHook("git worktree remove .claude/worktrees/agent-x").status).toBe(2);
  });

  it.each([
    ["coder", "codex exec --full-auto fix it"],
    ["reviewer", "codex exec -s danger-full-access review"],
    ["coder", "pnpm sdlc review --task VISP-2/VISP-3 --round 1"],
    ["manager", "node scripts/sdlc/sdlc.mjs review --task VISP-2/VISP-3 --round 1"],
    ["manager", "pnpm sdlc jira transition VISP-3 Ready"],
    ["coder", "pnpm run sdlc jira comment VISP-3 --body x"],
    ["reviewer", "./scripts/sdlc/sdlc.mjs jira create --type Task"],
  ])("blocks %s from running %s", (agentType, command) => {
    const result = runHook(command, { agentType });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain("sdlc safety");
  });

  it.each([
    ["reviewer", "pnpm sdlc review --task VISP-2/VISP-3 --round 1"],
    ["clerk", "pnpm sdlc jira transition VISP-3 Ready"],
    ["clerk", "node scripts/sdlc/sdlc.mjs jira comment VISP-3 --body x"],
    ["coder", "pnpm sdlc jira show VISP-3"],
    ["manager", "pnpm sdlc pull VISP-2"],
  ])("allows %s to run %s", (agentType, command) => {
    const result = runHook(command, { agentType });
    expect(result.status, result.stderr).toBe(0);
  });

  it("leaves codex, review and Jira writes to the owner's own session", () => {
    for (const command of [
      "codex exec hi",
      "pnpm sdlc review --task VISP-2/VISP-3 --round 1",
      "pnpm sdlc jira transition VISP-3 Ready",
    ]) {
      expect(runHook(command).status, command).toBe(0);
    }
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
