import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHook, type SdlcRepo, sdlcRepo } from "./support/sdlc-repo.js";

let fixture: SdlcRepo;

function mcpCall(toolName: string, agentType?: string) {
  return runHook("mcp-guard.mjs", {
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: {},
    cwd: fixture.repo,
    ...(agentType ? { agent_id: "a1", agent_type: agentType } : {}),
  });
}

function decision(result: ReturnType<typeof runHook>) {
  const output = result.json?.hookSpecificOutput as { permissionDecision?: string } | undefined;
  return output?.permissionDecision ?? "none";
}

describe("MCP guard hook", () => {
  beforeEach(() => {
    fixture = sdlcRepo();
  });
  afterEach(() => fixture.cleanup());

  it("refuses an SDLC agent an MCP tool its config entry does not list", () => {
    const jira = "mcp__6465b1b8__addOrEditJiraIssueComment";
    for (const agent of ["coder", "clerk", "manager", "reviewer", "qe-verify"]) {
      expect(decision(mcpCall(jira, agent)), agent).toBe("deny");
    }
  });

  it("allows a tool the agent's entry lists by prefix", () => {
    const config = JSON.parse(fixture.git("show", "HEAD:sdlc.config.json"));
    config.agents["qe-verify"].mcp = ["mcp__sentry__search_"];
    fixture.write("sdlc.config.json", JSON.stringify(config));
    expect(decision(mcpCall("mcp__sentry__search_errors", "qe-verify"))).toBe("none");
    expect(decision(mcpCall("mcp__sentry__update_issue", "qe-verify"))).toBe("deny");
  });

  it("leaves the owner's session and agents outside the SDLC alone", () => {
    expect(decision(mcpCall("mcp__x__getJiraIssue"))).toBe("none");
    expect(decision(mcpCall("mcp__x__getJiraIssue", "Explore"))).toBe("none");
  });

  it("keeps MCP closed when the config cannot be read", () => {
    fixture.write("sdlc.config.json", "{");
    expect(decision(mcpCall("mcp__x__getJiraIssue", "manager"))).toBe("deny");
  });
});

describe("config guard hook", () => {
  beforeEach(() => {
    fixture = sdlcRepo();
  });
  afterEach(() => fixture.cleanup());

  function change(source: string, agentType?: string) {
    return runHook("config-guard.mjs", {
      hook_event_name: "ConfigChange",
      source,
      cwd: fixture.repo,
      ...(agentType ? { agent_type: agentType } : {}),
    });
  }

  it("blocks settings and skill changes during a pipeline session", () => {
    for (const source of ["project_settings", "local_settings", "user_settings", "skills"]) {
      expect(change(source, "manager").json?.decision, source).toBe("block");
    }
  });

  it("lets managed policy and the owner's own sessions change settings", () => {
    expect(change("policy_settings", "manager").json).toBeUndefined();
    expect(change("local_settings").json).toBeUndefined();
  });
});
