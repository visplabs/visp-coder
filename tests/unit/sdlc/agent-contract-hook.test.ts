import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reviewReport, runHook, type SdlcRepo, sdlcRepo } from "./support/sdlc-repo.js";

let fixture: SdlcRepo;

function spawnAgent(subagentType: string, prompt: string, extra: Record<string, unknown> = {}) {
  return runHook("agent-contract.mjs", {
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { subagent_type: subagentType, description: "work", prompt, ...extra },
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

function denial(result: ReturnType<typeof spawnAgent>) {
  const output = (result.json as Output | undefined)?.hookSpecificOutput;
  return output?.permissionDecision === "deny" ? (output.permissionDecisionReason ?? "") : "";
}

describe("agent contract hook", () => {
  beforeEach(() => {
    fixture = sdlcRepo();
  });
  afterEach(() => fixture.cleanup());

  it("appends the task contract to a coder's prompt", () => {
    const result = spawnAgent("coder", "Implement the worklog.\nSDLC-Task: F-12/T-13");
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

  it("drops a model or effort given on the call, so the definition decides", () => {
    const coder = spawnAgent("coder", "SDLC-Task: F-12/T-13", { model: "haiku" });
    const coderInput = (coder.json as Output).hookSpecificOutput.updatedInput ?? {};
    expect(coderInput).not.toHaveProperty("model");
    const clerk = spawnAgent("clerk", "File the task.", { model: "opus", effort: "max" });
    const output = (clerk.json as Output).hookSpecificOutput;
    expect(output.permissionDecision).toBe("allow");
    expect(output.updatedInput).not.toHaveProperty("model");
    expect(output.updatedInput).not.toHaveProperty("effort");
    expect(output.updatedInput?.prompt).toBe("File the task.");
  });

  it("leaves a call without overrides, or by an agent outside the SDLC, untouched", () => {
    expect(spawnAgent("clerk", "File the task.").json).toBeUndefined();
    expect(spawnAgent("Explore", "Look around.", { model: "haiku" }).json).toBeUndefined();
  });

  it("refuses an SDLC agent started without a task line", () => {
    const result = spawnAgent("coder", "Implement the worklog.");
    const output = (result.json as Output).hookSpecificOutput;
    expect(output.permissionDecision).toBe("deny");
    expect(output.permissionDecisionReason).toContain("SDLC-Task: VISP-12/VISP-13");
  });

  it("refuses a task that was not pulled", () => {
    const result = spawnAgent("coder", "SDLC-Task: F-12/T-99");
    const output = (result.json as Output).hookSpecificOutput;
    expect(output.permissionDecision).toBe("deny");
    expect(output.permissionDecisionReason).toContain("pnpm sdlc pull F-12");
  });

  it("refuses task work until the owner approved the spec as it is cached", () => {
    const approval = ".sdlc/features/F-12/spec/approval.yml";
    fixture.write(approval, "approved: false\nreason: the owner has not approved this spec\n");
    expect(denial(spawnAgent("coder", "SDLC-Task: F-12/T-13"))).toContain("not approved");
    fixture.write(approval, `approved: true\nhash: ${"0".repeat(64)}\n`);
    expect(denial(spawnAgent("coder", "SDLC-Task: F-12/T-13"))).toContain("not the one the owner");
  });

  it("refuses task work until the task's ticket is Ready", () => {
    fixture.write(".sdlc/features/F-12/tasks/T-13/ticket.yml", 'key: T-13\nstatus: "10021"\n');
    expect(denial(spawnAgent("coder", "SDLC-Task: F-12/T-13"))).toContain("not Ready");
  });

  it("stops coder turns at the ceiling of all three loops and counts the epic's budget", () => {
    fixture.write(".sdlc/run/loops/F-12/T-13.json", '{"coderTurns":15}');
    expect(denial(spawnAgent("coder", "SDLC-Task: F-12/T-13"))).toBe("");
    expect(denial(spawnAgent("coder", "SDLC-Task: F-12/T-13"))).toContain("ceiling of 16");
    const budget = JSON.parse(fixture.read(".sdlc/run/budget/F-12.json"));
    expect(budget).toEqual({ agentRuns: 1, coderRuns: 1 });
    fixture.write(".sdlc/run/budget/F-12.json", '{"agentRuns":40,"coderRuns":3}');
    expect(denial(spawnAgent("reviewer", "SDLC-Task: F-12/T-13"))).toContain("budget of 40");
  });

  it("stops review rounds at the inner loop's maximum", () => {
    for (let round = 1; round <= 10; round++) {
      fixture.write(
        `.sdlc/features/F-12/tasks/T-13/review-${round}.yml`,
        reviewReport(round, "changes_requested"),
      );
    }
    expect(denial(spawnAgent("reviewer", "SDLC-Task: F-12/T-13"))).toContain("maximum");
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
