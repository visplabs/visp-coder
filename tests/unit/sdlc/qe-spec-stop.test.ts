import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { epicBody, type FakeJira, startFakeJira } from "./support/fake-jira.js";
import { promptEntry, runHook, type SdlcRepo, SPEC, sdlcRepo } from "./support/sdlc-repo.js";

let fixture: SdlcRepo;
let jira: FakeJira;
const OWNER_TEXT = "Work log entries are separate timestamped files.";
const yaml = (text: string) => `\`\`\`yaml\n${text}\n\`\`\``;
const REPORT = [
  "```mermaid\nmindmap\n  root((agent's own map))\n```",
  "Open questions: none.",
  yaml(SPEC["spec/intent.yml"] ?? ""),
  yaml(SPEC["spec/acceptance.yml"] ?? ""),
  yaml(SPEC["spec/test-cases.yml"] ?? ""),
].join("\n\n");

function stop(lastMessage: string) {
  fixture.transcript("q1", [promptEntry("Write the spec.\nSDLC-Feature: F-12")]);
  return runHook(
    "subagent-stop.mjs",
    {
      hook_event_name: "SubagentStop",
      agent_id: "q1",
      agent_type: "qe-spec",
      agent_transcript_path: join(fixture.sessions, "session-1", "subagents", "agent-q1.jsonl"),
      last_assistant_message: lastMessage,
      cwd: fixture.repo,
    },
    jira.env,
  );
}

const reason = (result: ReturnType<typeof stop>) =>
  result.json?.decision === "block" ? String(result.json.reason) : "";

const description = () => JSON.stringify(jira.issue("F-12").fields.description);

describe("qe-spec stop", () => {
  beforeEach(async () => {
    fixture = sdlcRepo();
    const dir = join(fixture.repo, "..", "jira");
    mkdirSync(dir);
    jira = await startFakeJira(dir);
    jira.setIssue("F-12", {
      summary: "Work log",
      body: epicBody(OWNER_TEXT, false),
      type: "10000",
    });
  });
  afterEach(() => {
    jira.stop();
    fixture.cleanup();
  });

  it("writes the validated spec and a generated mind map into the epic", () => {
    const result = stop(REPORT);
    expect(result.status, result.stderr).toBe(0);
    expect(reason(result)).toBe("");
    expect(description()).toContain(OWNER_TEXT);
    expect(description()).toContain("schema: intent@1");
    expect(description()).toContain("schema: acceptance@1");
    expect(description()).toContain("schema: test-cases@1");
    expect(description()).toContain("root((F-12");
    expect(description()).not.toContain("agent's own map");
    const put = jira.calls().find((call) => call.method === "PUT");
    expect(put?.auth).toMatch(/^Basic /);
    const worklog = join(fixture.repo, ".sdlc/worklog");
    expect(existsSync(worklog) && readdirSync(worklog).length).toBe(1);
  });

  it("keeps the agent working when it changed the owner's words", () => {
    const altered = REPORT.replace(OWNER_TEXT, "Work log entries may share one file.");
    expect(reason(stop(altered))).toContain("owner_text");
    expect(description()).not.toContain("schema: intent@1");
  });

  it("keeps the agent working when a spec block is missing", () => {
    const partial = REPORT.replace(yaml(SPEC["spec/test-cases.yml"] ?? ""), "");
    expect(reason(stop(partial))).toContain("test-cases@1");
  });

  it("keeps the agent working when a must clause has no criterion", () => {
    const gap = REPORT.replace("clauses: [I-01]", "clauses: []");
    writeFileSync(join(fixture.repo, "unused"), "");
    expect(reason(stop(gap))).toMatch(/I-01|AC-01/);
  });
});
