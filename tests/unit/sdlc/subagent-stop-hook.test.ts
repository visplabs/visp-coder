import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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

function stopEvent(agentType: string, lastMessage: string | undefined) {
  return {
    hook_event_name: "SubagentStop",
    stop_hook_active: false,
    agent_id: "a1",
    agent_type: agentType,
    agent_transcript_path: join(fixture.sessions, "session-1", "subagents", "agent-a1.jsonl"),
    transcript_path: join(fixture.sessions, "session-1.jsonl"),
    last_assistant_message: lastMessage,
    effort: { level: "high" },
    cwd: fixture.repo,
  };
}

const HOOK_ENV = { SDLC_VERIFY: "off", SDLC_TRANSCRIPT_WAIT_MS: "0" };

function stop(agentType: string, lastMessage: string | undefined) {
  return runHook("subagent-stop.mjs", stopEvent(agentType, lastMessage), {
    ...HOOK_ENV,
    SDLC_BASE_REF: base,
  });
}

// The hook as Claude Code runs it: started while the transcript may still lack the last lines.
function stopWhileWriting(agentType: string, write: () => void) {
  const child = spawn(
    process.execPath,
    [join(process.cwd(), "scripts/sdlc/hooks/subagent-stop.mjs")],
    {
      env: {
        ...process.env,
        SDLC_OWNER: "1",
        ...HOOK_ENV,
        SDLC_BASE_REF: base,
        SDLC_TRANSCRIPT_WAIT_MS: "3000",
      },
    },
  );
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stdin.end(JSON.stringify(stopEvent(agentType, undefined)));
  setTimeout(write, 400);
  return new Promise<string>((resolve) => child.on("close", () => resolve(stdout)));
}

function filed(dir: string) {
  const path = join(fixture.repo, ".sdlc/features/F-12", dir);
  return existsSync(path)
    ? readdirSync(path).filter((name) => name !== "task.yml" && name !== "ticket.yml")
    : [];
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
    const result = stop("coder", HANDOFF);
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
      agent: "coder",
      agent_id: "a1",
      model: "claude-sonnet-5-5",
      effort: "high",
      status: "done",
      usage: { input_tokens: 400, output_tokens: 100 },
    });
    expect(worklog()).toEqual([
      expect.objectContaining({ schema: "worklog@1", task: "T-13", agent: "coder" }),
    ]);
  });

  it("keeps the agent working when the report is missing or invalid", () => {
    expect(blockReason(stop("coder", "All done, no yaml."))).toContain("yaml");
    const invalid = HANDOFF.replace("criterion: AC-01", "criterion: 1");
    expect(blockReason(stop("coder", invalid))).toContain("body.tests.0.criterion");
    expect(filed("tasks/T-13")).toEqual([]);
  });

  it("keeps the coder working when it changed files outside its scope", () => {
    fixture.write("src/other.ts", "export {};\n");
    expect(blockReason(stop("coder", HANDOFF))).toContain("src/other.ts");
  });

  it("lets the agent stop after five rejected reports and logs the failure", () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(blockReason(stop("coder", "no report"))).not.toBe("");
    }
    expect(blockReason(stop("coder", "no report"))).toBe("");
    expect(worklog().at(-1)).toMatchObject({ status: "failed" });
  });

  function handback(model: string, message: string) {
    fixture.transcript("a1", [
      promptEntry("Review it.\nSDLC-Task: F-12/T-13"),
      {
        type: "assistant",
        message: {
          id: "m9",
          model,
          content: [{ type: "tool_use", name: "SubagentHandback", input: { message } }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ]);
  }

  function filedReport() {
    const [file] = filed("tasks/T-13");
    expect(file).toMatch(/^review-/);
    const dir = join(fixture.repo, ".sdlc/features/F-12/tasks/T-13");
    return parse(readFileSync(join(dir, file ?? ""), "utf8"));
  }

  it("files the fallback reviewer's report from its SubagentHandback call", () => {
    const review = [
      "```yaml",
      "status: done",
      "body:",
      "  verdict: approve",
      "  findings: []",
      "```",
    ];
    handback("claude-opus-5-5", review.join("\n"));
    expect(blockReason(stop("reviewer-fallback", "Handed back."))).toBe("");
    expect(filedReport().commit).toBe(fixture.git("rev-parse", "HEAD"));
  });

  it("waits for a SubagentHandback the transcript has not written yet", async () => {
    fixture.transcript("a1", [promptEntry("Review it.\nSDLC-Task: F-12/T-13")]);
    const review = "```yaml\nstatus: done\nbody:\n  verdict: approve\n  findings: []\n```";
    const stdout = await stopWhileWriting("reviewer-fallback", () =>
      handback("claude-opus-5-5", review),
    );
    expect(stdout).not.toContain("block");
    expect(filedReport().body.verdict).toBe("approve");
  });

  it("files a handback whose yaml report has no fence", () => {
    handback("claude-opus-5-5", "status: done\nbody:\n  verdict: approve\n  findings: []\n");
    expect(blockReason(stop("reviewer-fallback", "Handed back."))).toBe("");
    expect(filedReport().body.verdict).toBe("approve");
  });

  it("files one report per round, however often the agent stops", () => {
    expect(blockReason(stop("coder", HANDOFF))).toBe("");
    fixture.transcript("a1", [
      promptEntry("Implement it.\nSDLC-Task: F-12/T-13"),
      assistant("m3", "The wait finished; my report was already delivered."),
    ]);
    const again = stop("coder", "The wait finished; my report was already delivered.");
    expect(blockReason(again)).toBe("");
    expect(filed("tasks/T-13")).toHaveLength(1);
    expect(worklog()).toHaveLength(1);
  });

  it("files again after a resume starts a new round", () => {
    expect(blockReason(stop("coder", HANDOFF))).toBe("");
    const resume = runHook("resume-guard.mjs", {
      hook_event_name: "PreToolUse",
      tool_name: "SendMessage",
      tool_input: { to: "a1", message: "Fix the findings." },
      cwd: fixture.repo,
      agent_type: "manager",
    });
    expect(resume.status, resume.stderr).toBe(0);
    expect(blockReason(stop("coder", HANDOFF))).toBe("");
    expect(filed("tasks/T-13")).toHaveLength(2);
  });

  it("files the Codex review from the file sdlc review wrote, checked by its sha256", () => {
    const commit = "a".repeat(40);
    const text = `status: done\ncommit: ${commit}\nbody:\n  verdict: approve\n  findings: []\n`;
    fixture.write(".sdlc/run/reviews/T-13-1.yml", text);
    const path = join(fixture.repo, ".sdlc/run/reviews/T-13-1.yml");
    const sha = createHash("sha256").update(text).digest("hex");
    handback(
      "claude-haiku-5-5",
      `\`\`\`yaml\nreview_file: ${path}\nsha256: ${"0".repeat(64)}\n\`\`\``,
    );
    expect(blockReason(stop("reviewer", "Handed back."))).toContain("sha256 does not match");
    handback("claude-haiku-5-5", `\`\`\`yaml\nreview_file: /etc/passwd\nsha256: ${sha}\n\`\`\``);
    expect(blockReason(stop("reviewer", "Handed back."))).toContain("review_file");
    handback("claude-haiku-5-5", `\`\`\`yaml\nreview_file: ${path}\nsha256: ${sha}\n\`\`\``);
    expect(blockReason(stop("reviewer", "Handed back."))).toBe("");
    expect(filedReport()).toMatchObject({ commit, body: { verdict: "approve" } });
  });

  it("files nothing from an agent that ran on another model than the config sets", () => {
    const result = stop("qe-verify", HANDOFF);
    expect(blockReason(result)).toBe("");
    expect(filed("tasks/T-13")).toEqual([]);
    expect(worklog().at(-1)).toMatchObject({ status: "failed" });
    expect(worklog().at(-1)?.body.summary).toContain(
      "ran on claude-sonnet-5-5, but sdlc.config.json sets claude-opus-5-5",
    );
  });

  it("ignores agents outside the SDLC", () => {
    const result = stop("Explore", "Found it.");
    expect(result.stdout.trim()).toBe("");
    expect(worklog()).toEqual([]);
  });
});
