import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { featureBody, ghCalls, installFakeGh, setFakeIssue } from "./support/fake-gh.js";
import { runHook, type SdlcRepo, SPEC, sdlcRepo } from "./support/sdlc-repo.js";

let fixture: SdlcRepo;
let gh = "";
const OWNER_TEXT = "Work log entries are separate timestamped files.";
const SPEC_BLOCKS = [
  SPEC["spec/intent.yml"] ?? "",
  SPEC["spec/acceptance.yml"] ?? "",
  SPEC["spec/test-cases.yml"] ?? "",
];

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
    { SDLC_GH: gh, FAKE_DIR: fixture.repo, GH_CONFIG_DIR: "/bot-config" },
  );
}

const reason = (result: ReturnType<typeof command>) =>
  result.json?.decision === "block" ? String(result.json.reason) : "";

describe("/feature", () => {
  beforeEach(() => {
    fixture = sdlcRepo();
    gh = installFakeGh(fixture.repo);
  });
  afterEach(() => fixture.cleanup());

  it("opens a feature issue holding the owner's words verbatim and keeps a local copy", () => {
    const words =
      "Work log files\n\nEvery agent stop writes one timestamped file.\n  Keep `them` apart.";
    const result = command("feature", words);
    expect(result.status, result.stderr).toBe(0);
    expect(reason(result)).toBe("");
    const context = JSON.stringify(result.json);
    expect(context).toContain("F-20");
    expect(context).toContain("SDLC-Feature: F-20");

    const create = ghCalls(fixture.repo).find(
      (call) => call.args[0] === "issue" && call.args[1] === "create",
    );
    expect(create?.args).toEqual(
      expect.arrayContaining(["--title", "Work log files", "--label", "sdlc:feature"]),
    );
    expect(create?.body).toContain(`<!-- sdlc:owner-text -->\n${words}\n<!-- /sdlc:owner-text -->`);
    const local = join(fixture.repo, ".sdlc/features/F-20/owner-text.md");
    expect(readFileSync(local, "utf8")).toBe(words);
  });

  it("refuses an empty request", () => {
    expect(reason(command("feature", "  "))).toContain("/feature <your request>");
    expect(ghCalls(fixture.repo)).toEqual([]);
  });
});

describe("/approve", () => {
  beforeEach(() => {
    fixture = sdlcRepo();
    gh = installFakeGh(fixture.repo);
    setFakeIssue(fixture.repo, 12, featureBody(OWNER_TEXT, SPEC_BLOCKS));
  });
  afterEach(() => fixture.cleanup());

  function shownHash() {
    const shown = reason(command("approve", "F-12"));
    const match = shown.match(/\/approve F-12 ([0-9a-f]{12})/);
    return { shown, prefix: match?.[1] ?? "" };
  }

  it("first shows what would be approved, without approving", () => {
    const { shown, prefix } = shownHash();
    expect(prefix).toHaveLength(12);
    expect(shown).toContain("I-01");
    expect(shown).toContain("AC-01");
    expect(ghCalls(fixture.repo).some((call) => call.args[1] === "comment")).toBe(false);
  });

  it("approves with the shown hash as the owner, not as the agent bot", () => {
    const { prefix } = shownHash();
    const done = reason(command("approve", `F-12 ${prefix}`));
    expect(done).toContain("Approved F-12");
    const comment = ghCalls(fixture.repo).find((call) => call.args[1] === "comment");
    expect(comment?.config).toBeNull();
    expect(comment?.body).toContain("<!-- sdlc:approval -->");
    expect(comment?.body).toMatch(new RegExp(`${prefix}[0-9a-f]{52}`));
    const lock = ghCalls(fixture.repo).find((call) => call.args[1] === "lock");
    expect(lock?.config).toBeNull();
  });

  it("refuses a hash that no longer matches the issue", () => {
    shownHash();
    expect(reason(command("approve", "F-12 000000000000"))).toContain("changed");
    expect(ghCalls(fixture.repo).some((call) => call.args[1] === "comment")).toBe(false);
  });

  it("refuses a spec whose owner_text differs from the words /feature recorded", () => {
    setFakeIssue(fixture.repo, 12, featureBody("Something else entirely.", SPEC_BLOCKS));
    expect(reason(command("approve", "F-12"))).toContain("owner_text");
  });

  it("ignores other commands", () => {
    const result = command("review", "");
    expect(result.stdout.trim()).toBe("");
    expect(existsSync(join(fixture.repo, "calls.jsonl"))).toBe(false);
  });
});
