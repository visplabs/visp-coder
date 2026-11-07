import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeJira, startFakeJira } from "./support/fake-jira.js";
import { promptEntry, runHook, type SdlcRepo, SPEC, sdlcRepo } from "./support/sdlc-repo.js";

let fixture: SdlcRepo;
let jira: FakeJira;
const STARTED = "2026-11-08T10:00:00.000Z";

function qeReport(verdict: string, crashes?: number) {
  const lines = [
    "```yaml",
    "status: done",
    "body:",
    `  verdict: ${verdict}`,
    "  cases: [{ id: TC-01, result: pass, evidence: 'pnpm test:browser', test: 'tests/browser/worklog.test.ts > worklog > journey' }]",
    ...(crashes === undefined ? [] : [`  crashes: ${crashes}`]),
    "```",
  ];
  fixture.transcript("q1", [
    { ...promptEntry("Verify it.\nSDLC-Task: F-12/T-13"), timestamp: STARTED },
    {
      type: "assistant",
      message: {
        id: "m1",
        model: "claude-opus-5-5",
        content: [
          { type: "tool_use", name: "SubagentHandback", input: { message: lines.join("\n") } },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
  ]);
}

function crash(at: string, tags: Record<string, string> = { task: "T-13" }) {
  const log = join(fixture.repo, ".sdlc/run/crashes.jsonl");
  mkdirSync(dirname(log), { recursive: true });
  appendFileSync(log, `${JSON.stringify({ at, command: "guard", tags, message: "boom" })}\n`);
}

function stopQe() {
  const result = runHook(
    "subagent-stop.mjs",
    {
      hook_event_name: "SubagentStop",
      agent_id: "q1",
      agent_type: "qe-verify",
      agent_transcript_path: join(fixture.sessions, "session-1", "subagents", "agent-q1.jsonl"),
      cwd: fixture.repo,
    },
    { SDLC_VERIFY: "off", SDLC_TRANSCRIPT_WAIT_MS: "0", ...jira.env },
  );
  return result.json?.decision === "block" ? String(result.json.reason) : "";
}

function filed() {
  const dir = join(fixture.repo, ".sdlc/features/F-12/tasks/T-13");
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith("qe-report")) : [];
}

describe("the crash-log check on a qe-verify report", () => {
  beforeEach(async () => {
    fixture = sdlcRepo();
    jira = await startFakeJira(join(fixture.repo, ".."));
    const task = `\`\`\`yaml\n${SPEC["tasks/T-13/task.yml"]}\n\`\`\``;
    jira.setIssue("T-13", { summary: "Worklog", body: task, parent: "F-12" });
    const journey = (SPEC["spec/acceptance.yml"] ?? "").replace("level: unit", "level: journey");
    fixture.write(".sdlc/features/F-12/spec/acceptance.yml", journey);
  });
  afterEach(() => {
    jira.stop();
    fixture.cleanup();
  });

  it("files a passing report when VISP logged no crash since the run began", () => {
    crash("2026-11-08T09:00:00.000Z");
    qeReport("pass", 0);
    expect(stopQe()).toBe("");
    expect(filed()).toHaveLength(1);
  });

  it("refuses a passing report when the crash log holds crashes for the task or untagged", () => {
    crash("2026-11-08T10:05:00.000Z");
    crash("2026-11-08T10:06:00.000Z", {});
    crash("2026-11-08T10:07:00.000Z", { task: "T-99" });
    qeReport("pass", 0);
    expect(stopQe()).toContain("VISP crashed 2 times");
    expect(filed()).toEqual([]);
  });

  it("files a failing report that counts the crashes, for the verify loop", () => {
    crash("2026-11-08T10:05:00.000Z");
    qeReport("fail", 1);
    expect(stopQe()).toBe("");
    expect(filed()).toHaveLength(1);
  });

  it("refuses a report without a crash count", () => {
    qeReport("pass");
    expect(stopQe()).toContain("crashes");
  });

  it("does not check crashes for a task without journey criteria", () => {
    fixture.write(".sdlc/features/F-12/spec/acceptance.yml", SPEC["spec/acceptance.yml"] ?? "");
    crash("2026-11-08T10:05:00.000Z");
    qeReport("pass");
    expect(stopQe()).toBe("");
  });
});
