import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeGh } from "./support/fake-gh.js";
import { type FakeJira, startFakeJira } from "./support/fake-jira.js";
import { runHook, type SdlcRepo, sdlcRepo } from "./support/sdlc-repo.js";

let fixture: SdlcRepo;
let jira: FakeJira;
let gh = "";
const cli = join(process.cwd(), "scripts/sdlc/sdlc.mjs");
const S = { todo: "10021", ready: "10022", inProgress: "3", inReview: "10023", done: "10013" };

function setPrs(prs: { number: number; state: string; task: string }[]) {
  const list = prs.map((pr) => ({
    number: pr.number,
    state: pr.state,
    body: `Adds it.\n\nTask: ${pr.task}`,
  }));
  writeFileSync(join(fixture.repo, "pr-list.json"), JSON.stringify(list));
}

const status = (key: string) =>
  (jira.issue(key).fields as unknown as { status: { id: string } }).status.id;

function sync(feature = "F-12") {
  return spawnSync(process.execPath, [cli, "sync-status", feature], {
    cwd: fixture.repo,
    encoding: "utf8",
    env: { ...process.env, ...jira.env, SDLC_GH: gh, FAKE_DIR: fixture.repo },
  });
}

describe("ticket status from pull requests", () => {
  beforeEach(async () => {
    fixture = sdlcRepo();
    jira = await startFakeJira(join(fixture.repo, ".."));
    gh = installFakeGh(fixture.repo);
    jira.setIssue("F-12", { summary: "Work log", type: "10000", status: S.inProgress });
    jira.setIssue("T-13", { summary: "Code", parent: "F-12", status: S.inProgress });
    jira.setIssue("T-14", { summary: "Docs", parent: "F-12", status: S.inProgress });
  });
  afterEach(() => {
    jira.stop();
    fixture.cleanup();
  });

  it("moves a task with an open PR to In Review and one with a merged PR to Done", () => {
    setPrs([
      { number: 108, state: "OPEN", task: "T-13" },
      { number: 109, state: "MERGED", task: "T-14" },
    ]);
    const result = sync();
    expect(result.status, result.stderr).toBe(0);
    expect(status("T-13")).toBe(S.inReview);
    expect(status("T-14")).toBe(S.done);
    expect(status("F-12")).toBe(S.inProgress);
    expect(result.stdout).toContain("T-14 -> Done (PR #109 merged)");
  });

  it("reports a failed CI run on a task's merge commit", () => {
    // Pilot 2: Sonar failed every push to develop after #110, and nothing in the pipeline said so.
    const list = [
      { number: 109, state: "MERGED", body: "Task: T-14", mergeCommit: { oid: "4d4a5856" } },
    ];
    writeFileSync(join(fixture.repo, "pr-list.json"), JSON.stringify(list));
    const runs = [{ name: "ci", conclusion: "failure", status: "completed", url: "https://ci/9" }];
    writeFileSync(join(fixture.repo, "runs-4d4a5856.json"), JSON.stringify(runs));
    const result = sync();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("after PR #109 merged, CI ci failed on 4d4a5856: https://ci/9");
  });

  it("moves the epic to Done once every task is Done", () => {
    setPrs([
      { number: 108, state: "MERGED", task: "T-13" },
      { number: 109, state: "MERGED", task: "T-14" },
    ]);
    expect(sync().stdout).toContain("F-12 -> Done (every task is Done)");
    expect(status("F-12")).toBe(S.done);
  });

  it("never moves a ticket back, and leaves a task without a PR alone", () => {
    jira.setIssue("T-14", { summary: "Docs", parent: "F-12", status: S.done });
    setPrs([
      { number: 110, state: "OPEN", task: "T-14" },
      { number: 111, state: "OPEN", task: "T-130" },
    ]);
    sync();
    expect(status("T-14")).toBe(S.done);
    expect(status("T-13")).toBe(S.inProgress);
  });

  it("runs as a Stop hook in the manager's session, for every approved epic in the cache", () => {
    setPrs([{ number: 109, state: "MERGED", task: "T-14" }]);
    const env = { ...jira.env, SDLC_GH: gh, FAKE_DIR: fixture.repo };
    const owner = runHook("ticket-status.mjs", { hook_event_name: "Stop", cwd: fixture.repo }, env);
    expect(owner.status).toBe(0);
    expect(status("T-14")).toBe(S.inProgress);
    const manager = runHook(
      "ticket-status.mjs",
      { hook_event_name: "Stop", cwd: fixture.repo, agent_type: "manager" },
      env,
    );
    expect(manager.status, manager.stderr).toBe(0);
    expect(status("T-14")).toBe(S.done);
  });
});

describe("ticket status when a coder starts", () => {
  beforeEach(async () => {
    fixture = sdlcRepo();
    jira = await startFakeJira(join(fixture.repo, ".."));
    jira.setIssue("T-13", { summary: "Code", parent: "F-12", status: S.ready });
  });
  afterEach(() => {
    jira.stop();
    fixture.cleanup();
  });

  it("moves the task from Ready to In Progress", () => {
    const result = runHook(
      "agent-contract.mjs",
      {
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        tool_input: { subagent_type: "coder", prompt: "Build it.\nSDLC-Task: F-12/T-13" },
        cwd: fixture.repo,
        agent_type: "manager",
      },
      jira.env,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(status("T-13")).toBe(S.inProgress);
  });
});
