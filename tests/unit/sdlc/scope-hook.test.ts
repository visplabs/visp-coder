import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promptEntry, runHook, type SdlcRepo, sdlcRepo } from "./support/sdlc-repo.js";

let fixture: SdlcRepo;

function toolCall(toolName: string, toolInput: Record<string, unknown>, agentType = "coder") {
  return runHook("scope.mjs", {
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    cwd: fixture.repo,
    agent_id: "a1",
    agent_type: agentType,
    transcript_path: join(fixture.sessions, "session-1.jsonl"),
  });
}

function decision(result: ReturnType<typeof runHook>) {
  const output = result.json?.hookSpecificOutput as { permissionDecision?: string } | undefined;
  return output?.permissionDecision ?? "none";
}

describe("scope hook", () => {
  beforeEach(() => {
    fixture = sdlcRepo();
    fixture.transcript("a1", [promptEntry("Implement it.\nSDLC-Task: F-12/T-13")]);
  });
  afterEach(() => fixture.cleanup());

  it("lets a coder edit files inside its task scope", () => {
    expect(decision(toolCall("Write", { file_path: join(fixture.repo, "src/worklog.ts") }))).toBe(
      "none",
    );
    expect(decision(toolCall("Edit", { file_path: "tests/unit/worklog.test.ts" }))).toBe("none");
  });

  it("refuses edits outside the scope, naming the allowed paths", () => {
    const result = toolCall("Write", { file_path: join(fixture.repo, "src/other.ts") });
    expect(decision(result)).toBe("deny");
    expect(JSON.stringify(result.json)).toContain("src/worklog.ts");
  });

  it("refuses protected files even when the scope matches them", () => {
    fixture.write(
      ".sdlc/features/F-12/tasks/T-13/task.yml",
      "schema: task@1\nfeature: F-12\ntask: T-13\ncriteria: [AC-01]\nscope: { paths: ['**'] }\ntrack: standard\nsize: M\n",
    );
    for (const path of ["biome.json", "scripts/sdlc/sdlc.mjs", ".claude/settings.json"]) {
      expect(decision(toolCall("Edit", { file_path: path })), path).toBe("deny");
    }
    expect(decision(toolCall("Edit", { file_path: "tests/golden/__snapshots__/a.txt" }))).toBe(
      "deny",
    );
  });

  it("refuses shell writes to files outside the scope and allows other commands", () => {
    expect(decision(toolCall("Bash", { command: "echo {} > biome.json" }))).toBe("deny");
    expect(decision(toolCall("Bash", { command: "rm -f scripts/sdlc/sdlc.mjs" }))).toBe("deny");
    expect(decision(toolCall("Bash", { command: "sed -i s/a/b/ src/other.ts" }))).toBe("deny");
    expect(decision(toolCall("Bash", { command: "pnpm exec vitest run tests/unit" }))).toBe("none");
    expect(decision(toolCall("Bash", { command: "echo ok > src/worklog.ts" }))).toBe("none");
  });

  it("says a path held in a shell variable cannot be checked", () => {
    // Pilot 2: "$f is outside this task's scope" read as if $f were a file name.
    for (const command of ['for f in a b; do rm "$f"; done', "cp a.ts $P", "touch `x`"]) {
      const result = toolCall("Bash", { command });
      expect(decision(result), command).toBe("deny");
      expect(JSON.stringify(result.json), command).toContain("shell variable");
    }
  });

  it("judges a copy into a folder by the file it creates there", () => {
    // Pilot 2: `cp x.md docs/adr` was refused under scope docs/adr/**.
    fixture.write(
      ".sdlc/features/F-12/tasks/T-13/task.yml",
      "schema: task@1\nfeature: F-12\ntask: T-13\ncriteria: [AC-01]\nscope: { paths: [src/worklog.ts, 'docs/adr/**'] }\ntrack: standard\nsize: M\n",
    );
    fixture.write("docs/adr/README.md", "# ADRs\n");
    fixture.write("src/other.ts", "");
    expect(decision(toolCall("Bash", { command: "cp /tmp/0003-x.md docs/adr" }))).toBe("none");
    expect(decision(toolCall("Bash", { command: "cp /tmp/0003-x.md docs/adr/" }))).toBe("none");
    expect(decision(toolCall("Bash", { command: "mv /tmp/a.ts /tmp/b.ts src" }))).toBe("deny");
  });

  it("keeps the architect's ADR drafts out of the repository", () => {
    // Pilot 2: the architect wrote ADR 0003 into the owner's main checkout.
    const result = toolCall("Write", { file_path: "docs/adr/0003-x.md" }, "architect");
    expect(decision(result)).toBe("deny");
    expect(JSON.stringify(result.json)).toContain(join(tmpdir(), "sdlc-adr"));
    const draft = join(tmpdir(), "sdlc-adr", "VISP-5", "0003-x.md");
    expect(decision(toolCall("Write", { file_path: draft }, "architect"))).toBe("none");
  });

  it("refuses a coder whose transcript names no task", () => {
    fixture.transcript("a1", [promptEntry("Implement it.")]);
    expect(decision(toolCall("Write", { file_path: "src/worklog.ts" }))).toBe("deny");
  });

  it("leaves non-coder agents and the main session alone outside SDLC state", () => {
    expect(decision(toolCall("Write", { file_path: "biome.json" }, "reviewer"))).toBe("none");
    expect(decision(toolCall("Write", { file_path: "sdlc.config.json" }, ""))).toBe("none");
  });

  it("keeps every agent away from SDLC state: settings, config, hooks and .sdlc", () => {
    const state = [
      ".claude/settings.local.json",
      "sdlc.config.json",
      "scripts/sdlc/hooks/scope.mjs",
      join(fixture.repo, ".sdlc/run/agents/a1.json"),
    ];
    for (const agent of ["manager", "clerk", "reviewer", "qe-verify", "architect"]) {
      for (const path of state) {
        expect(decision(toolCall("Write", { file_path: path }, agent)), `${agent} ${path}`).toBe(
          "deny",
        );
      }
      const command = `echo '{}' > ${join(fixture.repo, ".sdlc/run/loops.json")}`;
      expect(decision(toolCall("Bash", { command }, agent)), agent).toBe("deny");
    }
    expect(decision(toolCall("Edit", { file_path: "sdlc.config.json" }))).toBe("deny");
  });
});
