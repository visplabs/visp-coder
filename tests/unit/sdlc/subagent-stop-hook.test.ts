import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { promptEntry, runHook, type SdlcRepo, sdlcRepo } from "./support/sdlc-repo.js";

let fixture: SdlcRepo;
let base = "";

const HANDOFF = [
  "Done.",
  "```yaml",
  "status: done",
  "body:",
  "  summary: Adds the worklog writer",
  "  changed_files: [src/worklog.ts]",
  "  tests:",
  "    - { criterion: AC-01, test: 'tests/worklog.test.ts > worklog > writes one file' }",
  "```",
].join("\n");

function assistant(id: string, text: string, usage = { input_tokens: 100, output_tokens: 20 }) {
  return {
    type: "assistant",
    message: { id, model: "claude-sonnet-5-5", content: [{ type: "text", text }], usage },
  };
}

function stop(agentType: string, lastMessage: string | undefined) {
  const transcript = join(fixture.sessions, "session-1", "subagents", "agent-a1.jsonl");
  return runHook(
    "subagent-stop.mjs",
    {
      hook_event_name: "SubagentStop",
      stop_hook_active: false,
      agent_id: "a1",
      agent_type: agentType,
      agent_transcript_path: transcript,
      transcript_path: join(fixture.sessions, "session-1.jsonl"),
      last_assistant_message: lastMessage,
      effort: { level: "high" },
      cwd: fixture.repo,
    },
    { SDLC_BASE_REF: base, SDLC_VERIFY: "off" },
  );
}

function filed(dir: string) {
  const path = join(fixture.repo, ".sdlc/features/F-12", dir);
  return existsSync(path) ? readdirSync(path).filter((name) => name !== "task.yml") : [];
}

function worklog() {
  const root = join(fixture.repo, ".sdlc/worklog");
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((day) =>
    readdirSync(join(root, day)).map((file) => parse(readFileSync(join(root, day, file), "utf8"))),
  );
}

const blockReason = (result: ReturnType<typeof runHook>) =>
  result.json?.decision === "block" ? String(result.json.reason) : "";

describe("subagent stop hook", () => {
  beforeEach(() => {
    fixture = sdlcRepo();
    base = fixture.git("rev-parse", "HEAD");
    fixture.write("src/worklog.ts", "export const worklog = 1;\n");
    fixture.transcript("a1", [
      promptEntry("Implement it.\nSDLC-Task: F-12/T-13"),
      assistant("m1", "Working."),
      assistant("m1", "Working."),
      assistant("m2", HANDOFF, { input_tokens: 300, output_tokens: 80 }),
    ]);
  });
  afterEach(() => fixture.cleanup());

  it("files a valid handoff with an envelope taken from the hook input and transcript", () => {
    const result = stop("coder-m", HANDOFF);
    expect(result.status, result.stderr).toBe(0);
    expect(blockReason(result)).toBe("");
    const [file] = filed("tasks/T-13");
    expect(file).toMatch(/^handoff-\d{8}T\d{6}Z\.yml$/);
    const report = parse(
      readFileSync(join(fixture.repo, ".sdlc/features/F-12/tasks/T-13", file ?? ""), "utf8"),
    );
    expect(report).toMatchObject({
      schema: "handoff@1",
      feature: "F-12",
      task: "T-13",
      agent: "coder-m",
      agent_id: "a1",
      model: "claude-sonnet-5-5",
      effort: "high",
      status: "done",
      usage: { input_tokens: 400, output_tokens: 100 },
    });
    expect(worklog()).toEqual([
      expect.objectContaining({ schema: "worklog@1", task: "T-13", agent: "coder-m" }),
    ]);
  });

  it("keeps the agent working when the report is missing or invalid", () => {
    expect(blockReason(stop("coder-m", "All done, no yaml."))).toContain("yaml");
    const invalid = HANDOFF.replace("criterion: AC-01", "criterion: 1");
    expect(blockReason(stop("coder-m", invalid))).toContain("body.tests.0.criterion");
    expect(filed("tasks/T-13")).toEqual([]);
  });

  it("keeps the coder working when it changed files outside its scope", () => {
    fixture.write("src/other.ts", "export {};\n");
    expect(blockReason(stop("coder-m", HANDOFF))).toContain("src/other.ts");
  });

  it("lets the agent stop after five rejected reports and logs the failure", () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(blockReason(stop("coder-m", "no report"))).not.toBe("");
    }
    expect(blockReason(stop("coder-m", "no report"))).toBe("");
    expect(worklog().at(-1)).toMatchObject({ status: "failed" });
  });

  it("reads a reviewer's report from its SubagentHandback call", () => {
    const review = [
      "```yaml",
      "status: done",
      "body:",
      "  verdict: approve",
      "  findings: []",
      "```",
    ].join("\n");
    fixture.transcript("a1", [
      promptEntry("Review it.\nSDLC-Task: F-12/T-13"),
      {
        type: "assistant",
        message: {
          id: "m9",
          model: "claude-opus-5-5",
          content: [{ type: "tool_use", name: "SubagentHandback", input: { message: review } }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ]);
    const result = stop("reviewer", "Handed back.");
    expect(blockReason(result)).toBe("");
    expect(filed("tasks/T-13")[0]).toMatch(/^review-/);
  });

  it("ignores agents outside the SDLC", () => {
    const result = stop("Explore", "Found it.");
    expect(result.stdout.trim()).toBe("");
    expect(worklog()).toEqual([]);
  });
});
