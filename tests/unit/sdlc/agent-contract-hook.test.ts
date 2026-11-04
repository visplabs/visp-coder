import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHook, type SdlcRepo, sdlcRepo } from "./support/sdlc-repo.js";

let fixture: SdlcRepo;

function spawnAgent(subagentType: string, prompt: string) {
  return runHook("agent-contract.mjs", {
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { subagent_type: subagentType, description: "work", prompt },
    cwd: fixture.repo,
  });
}

type Output = {
  hookSpecificOutput: {
    permissionDecision: string;
    permissionDecisionReason?: string;
    updatedInput?: { prompt: string; subagent_type: string; description: string };
  };
};

describe("agent contract hook", () => {
  beforeEach(() => {
    fixture = sdlcRepo();
  });
  afterEach(() => fixture.cleanup());

  it("appends the task contract to a coder's prompt", () => {
    const result = spawnAgent("coder-m", "Implement the worklog.\nSDLC-Task: F-12/T-13");
    expect(result.status, result.stderr).toBe(0);
    const output = (result.json as Output).hookSpecificOutput;
    expect(output.permissionDecision).toBe("allow");
    const prompt = output.updatedInput?.prompt ?? "";
    expect(prompt.startsWith("Implement the worklog.")).toBe(true);
    expect(prompt).toContain("Work log entries are separate timestamped files.");
    expect(prompt).toContain("AC-01");
    expect(prompt).toContain("src/worklog.ts");
    expect(prompt).toContain("handoff@1");
    expect(output.updatedInput?.description).toBe("work");
  });

  it("gives the reviewer the owner's words and the finding rules", () => {
    const result = spawnAgent("reviewer", "Review T-13.\nSDLC-Task: F-12/T-13");
    const prompt = (result.json as Output).hookSpecificOutput.updatedInput?.prompt ?? "";
    expect(prompt).toContain("Work log entries are separate timestamped files.");
    expect(prompt).toContain("review@1");
    expect(prompt).toMatch(/blocking finding/i);
  });

  it("refuses an SDLC agent started without a task line", () => {
    const result = spawnAgent("coder-s", "Implement the worklog.");
    const output = (result.json as Output).hookSpecificOutput;
    expect(output.permissionDecision).toBe("deny");
    expect(output.permissionDecisionReason).toContain("SDLC-Task: F-12/T-13");
  });

  it("refuses a task that was not pulled", () => {
    const result = spawnAgent("coder-s", "SDLC-Task: F-12/T-99");
    const output = (result.json as Output).hookSpecificOutput;
    expect(output.permissionDecision).toBe("deny");
    expect(output.permissionDecisionReason).toContain("pnpm sdlc pull F-12");
  });

  it("gives qe-spec the owner's words recorded by /feature", () => {
    fixture.write(".sdlc/features/F-12/owner-text.md", "Keep a work log.\nOne file per stop.");
    const result = spawnAgent("qe-spec", "Write the spec.\nSDLC-Feature: F-12");
    const prompt = (result.json as Output).hookSpecificOutput.updatedInput?.prompt ?? "";
    expect(prompt).toContain("> Keep a work log.\n> One file per stop.");
    expect(prompt).toContain("intent@1");
  });

  it("refuses qe-spec for a feature without recorded words", () => {
    const result = spawnAgent("qe-spec", "SDLC-Feature: F-44");
    const output = (result.json as Output).hookSpecificOutput;
    expect(output.permissionDecision).toBe("deny");
    expect(output.permissionDecisionReason).toContain("/feature");
  });

  it("leaves other agents alone", () => {
    const result = spawnAgent("Explore", "Find the worklog code.");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });
});
