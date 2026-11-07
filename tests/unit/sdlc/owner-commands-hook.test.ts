import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { epicBody, type FakeJira, startFakeJira } from "./support/fake-jira.js";
import { runHook, type SdlcRepo, sdlcRepo } from "./support/sdlc-repo.js";

let fixture: SdlcRepo;
let jira: FakeJira;
const OWNER_TEXT = "Work log entries are separate timestamped files.";

function command(name: string, args: string) {
  return runHook(
    "owner-commands.mjs",
    {
      hook_event_name: "UserPromptExpansion",
      expansion_type: "slash_command",
      command_name: name,
      command_args: args,
      command_source: "project",
      prompt: `/${name} ${args}`,
      cwd: fixture.repo,
    },
    jira.env,
  );
}

const reason = (result: ReturnType<typeof command>) =>
  result.json?.decision === "block" ? String(result.json.reason) : "";

async function setUp() {
  fixture = sdlcRepo();
  const dir = join(fixture.repo, "..", "jira");
  mkdirSync(dir);
  jira = await startFakeJira(dir);
}

function tearDown() {
  jira.stop();
  fixture.cleanup();
}

describe("/feature", () => {
  beforeEach(setUp);
  afterEach(tearDown);

  it("opens an epic holding the owner's words verbatim and keeps a local copy", () => {
    const words =
      "Work log files\n\nEvery agent stop writes one timestamped file.\n  Keep `them` apart.";
    const result = command("feature", words);
    expect(result.status, result.stderr).toBe(0);
    expect(reason(result)).toBe("");
    expect(JSON.stringify(result.json)).toContain("SDLC-Feature: VISP-20");
    const epic = jira.issue("VISP-20");
    expect(epic.fields.summary).toBe("Work log files");
    expect(epic.fields.issuetype).toEqual({ id: "10000" });
    expect(JSON.stringify(epic.fields.description)).toContain(JSON.stringify(words).slice(1, -1));
    const local = join(fixture.repo, ".sdlc/features/VISP-20/owner-text.md");
    expect(readFileSync(local, "utf8")).toBe(words);
  });

  it("refuses an empty request", () => {
    expect(reason(command("feature", "  "))).toContain("/feature <your request>");
    expect(jira.calls()).toEqual([]);
  });
});

describe("/approve", () => {
  beforeEach(async () => {
    await setUp();
    jira.setIssue("F-12", { summary: "Work log", body: epicBody(OWNER_TEXT), type: "10000" });
  });
  afterEach(tearDown);

  it("shows the owner's words, the spec and the line that approves it, and writes nothing", () => {
    const shown = reason(command("approve", "F-12"));
    expect(shown).toContain(`> ${OWNER_TEXT}`);
    expect(shown).toContain("I-01");
    expect(shown).toContain("AC-01");
    expect(shown).toMatch(/^SDLC approval F-12 spec [0-9a-f]{12}$/m);
    expect(shown.split("\n")[0]).toBe(
      "F-12 is not approved yet: the owner has not approved this spec.",
    );
    const writes = jira.calls().filter((call) => call.method !== "GET");
    expect(writes.every((call) => call.path === "/rest/api/3/search/jql")).toBe(true);
  });

  it("reports the spec approved once the owner posted that line", () => {
    const line = reason(command("approve", "F-12")).match(/^SDLC approval .*$/m)?.[0] ?? "";
    const owner = "70121:c2afbcea-4dab-468f-99ed-f959f08b036a";
    const at = "2026-11-07T12:00:00.000+0000";
    jira.setComments("F-12", [{ id: "c1", author: owner, created: at, text: line }]);
    const shown = reason(command("approve", "F-12"));
    expect(shown.split("\n")[0]).toBe("F-12 is approved (comment c1). Tell the manager: Run F-12.");
    expect(shown).not.toContain("post this line");
    const approval = join(fixture.repo, ".sdlc/features/F-12/spec/approval.yml");
    expect(readFileSync(approval, "utf8")).toContain("approved: true");
  });

  it("refuses a spec whose owner_text differs from the words /feature recorded", () => {
    const body = epicBody("Something else entirely.");
    jira.setIssue("F-12", { summary: "Work log", body, type: "10000" });
    expect(reason(command("approve", "F-12"))).toContain("owner_text");
  });

  it("ignores other commands", () => {
    const result = command("review", "");
    expect(result.stdout.trim()).toBe("");
    expect(jira.calls()).toEqual([]);
  });
});
