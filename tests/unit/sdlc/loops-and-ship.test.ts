import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reviewReport, runHook, type SdlcRepo, sdlcRepo } from "./support/sdlc-repo.js";

let fixture: SdlcRepo;

function resume(to: string, sender = "manager") {
  const result = runHook("resume-guard.mjs", {
    hook_event_name: "PreToolUse",
    tool_name: "SendMessage",
    tool_input: { to, message: "Fix the findings." },
    cwd: fixture.repo,
    agent_type: sender,
  });
  const output = result.json?.hookSpecificOutput as
    | { permissionDecision?: string; permissionDecisionReason?: string }
    | undefined;
  return output?.permissionDecision === "deny" ? (output.permissionDecisionReason ?? "") : "";
}

function bash(command: string, agentType?: string) {
  return runHook("safety.mjs", {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    cwd: fixture.repo,
    ...(agentType ? { agent_id: "m1", agent_type: agentType } : {}),
  });
}

const PR = "gh pr create --base chore/sdlc-atlassian --title Worklog --body";

function fileReview(round: number, verdict: string, commit?: string) {
  fixture.write(
    `.sdlc/features/F-12/tasks/T-13/review-${round}.yml`,
    reviewReport(round, verdict, commit),
  );
}

describe("resuming a task agent", () => {
  beforeEach(() => {
    fixture = sdlcRepo();
    fixture.write(
      ".sdlc/run/agents/c1.json",
      JSON.stringify({ feature: "F-12", task: "T-13", type: "coder", blocks: 4 }),
    );
  });
  afterEach(() => fixture.cleanup());

  it("counts the resume as a coder turn and starts a fresh round of refusals", () => {
    expect(resume("c1")).toBe("");
    expect(JSON.parse(fixture.read(".sdlc/run/loops/F-12/T-13.json"))).toEqual({
      coderTurns: 1,
    });
    expect(JSON.parse(fixture.read(".sdlc/run/agents/c1.json")).blocks).toBe(0);
  });

  it("refuses a resume past the task's ceiling", () => {
    fixture.write(".sdlc/run/loops/F-12/T-13.json", '{"coderTurns":16}');
    expect(resume("c1")).toContain("ceiling of 16");
  });

  it("refuses the manager a resume of an agent the SDLC does not know", () => {
    expect(resume("someone-else")).toContain("not a known SDLC agent");
    expect(resume("someone-else", "clerk")).toBe("");
  });
});

describe("opening a task's pull request", () => {
  beforeEach(() => {
    fixture = sdlcRepo();
  });
  afterEach(() => fixture.cleanup());

  it("refuses an agent's PR that names no task", () => {
    expect(bash(`${PR} 'Adds the worklog.'`, "manager").stderr).toContain("Task: VISP-13");
  });

  it("refuses a PR before the inner loop's minimum of two review rounds", () => {
    fileReview(1, "approve", fixture.git("rev-parse", "HEAD"));
    const result = bash(`${PR} 'Adds it.\nTask: T-13'`, "manager");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("needs at least 2");
  });

  it("refuses a PR whose head the last approving review did not see", () => {
    const reviewed = fixture.git("rev-parse", "HEAD");
    fileReview(1, "changes_requested", reviewed);
    fileReview(2, "approve", reviewed);
    fixture.write("src/fix.ts", "export {};\n");
    fixture.git("add", ".");
    fixture.git("commit", "-q", "-m", "fix after review");
    expect(bash(`${PR} 'Adds it.\nTask: T-13'`, "manager").stderr).toContain("review the fixes");
  });

  it("allows the PR once two rounds ran and the last one approved the head", () => {
    const head = fixture.git("rev-parse", "HEAD");
    fileReview(1, "changes_requested", head);
    fileReview(2, "approve", head);
    const result = bash(`${PR} 'Adds it.\nTask: T-13'`, "manager");
    expect(result.status, result.stderr).toBe(0);
  });

  it("leaves the owner's own PRs alone", () => {
    expect(bash(`${PR} 'Owner change.'`).status).toBe(0);
  });
});
