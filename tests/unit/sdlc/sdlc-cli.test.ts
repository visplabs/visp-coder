import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeJira, startFakeJira } from "./support/fake-jira.js";

const cli = join(process.cwd(), "scripts/sdlc/sdlc.mjs");
const { adfToBody } = (await import(
  pathToFileURL(join(process.cwd(), "scripts/sdlc/lib/adf.mjs")).href
)) as { adfToBody(adf: unknown): string };
const { specHash } = (await import(
  pathToFileURL(join(process.cwd(), "scripts/sdlc/lib/hash.mjs")).href
)) as { specHash(intent: unknown, acceptance: unknown): string };

const INTENT = `schema: intent@1
feature: VISP-12
owner_text: Work log entries are separate timestamped files.
clauses:
  - id: I-01
    text: Work log entries are separate files
    kind: must`;
const ACCEPTANCE = `schema: acceptance@1
feature: VISP-12
criteria:
  - id: AC-01
    clauses: [I-01]
    given: an agent finishes a stage
    when: the stop hook runs
    expect: one new worklog file exists
    level: unit`;
const TEST_CASES = `schema: test-cases@1
feature: VISP-12
cases:
  - id: TC-01
    title: stop hook writes one file
    criteria: [AC-01]
    test: tests/worklog.test.ts > worklog > writes one file`;

const TASK = `schema: task@1
feature: VISP-12
task: VISP-13
criteria: [AC-01]
scope:
  paths: [scripts/sdlc/lib/worklog.mjs, "tests/unit/sdlc/**"]
track: standard
size: M`;

let repo = "";
let jira: FakeJira;

function issueBody(...blocks: string[]) {
  return ["Owner request.", ...blocks.map((block) => `\`\`\`yaml\n${block}\n\`\`\``)].join("\n\n");
}

function setEpic(body: string) {
  jira.setIssue("VISP-12", { summary: "Work log", body, type: "10000" });
}

function setTask(key: string, body: string, summary: string) {
  jira.setIssue(key, { summary, body, parent: "VISP-12", status: "10022" });
}

function sdlc(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...jira.env },
  });
}

describe("sdlc command line", () => {
  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "sdlc-cli-"));
    spawnSync("git", ["init", "-q", repo]);
    writeFileSync(
      join(repo, "sdlc.config.json"),
      readFileSync(join(process.cwd(), "sdlc.config.json"), "utf8"),
    );
    mkdirSync(join(repo, "jira"));
    jira = await startFakeJira(join(repo, "jira"));
    setEpic(issueBody(INTENT, ACCEPTANCE, TEST_CASES));
  });
  afterEach(() => {
    jira.stop();
    rmSync(repo, { recursive: true, force: true });
  });

  it("pulls the spec into a read-only cache, and pulls again over it", () => {
    expect(sdlc("pull", "VISP-12").status).toBe(0);
    const spec = join(repo, ".sdlc/features/VISP-12/spec");
    for (const file of [
      "intent.yml",
      "acceptance.yml",
      "test-cases.yml",
      "source.yml",
      "approval.yml",
    ]) {
      expect(existsSync(join(spec, file)), file).toBe(true);
    }
    expect(statSync(join(spec, "intent.yml")).mode & 0o222).toBe(0);
    expect(sdlc("pull", "VISP-12").status).toBe(0);
  });

  it("pulls each task's contract and ticket next to the spec", () => {
    setTask("VISP-13", issueBody(TASK), "Write worklog files");
    setTask("VISP-14", "A task without a task block.", "Notes");
    const result = sdlc("pull", "VISP-12");
    expect(result.status, result.stderr).toBe(0);
    const dir = join(repo, ".sdlc/features/VISP-12/tasks/VISP-13");
    expect(readFileSync(join(dir, "task.yml"), "utf8")).toContain("scripts/sdlc/lib/worklog.mjs");
    expect(readFileSync(join(dir, "ticket.yml"), "utf8")).toContain('status: "10022"');
    expect(result.stdout).toContain("VISP-14 has no task@1 block");
    const auth = jira.calls()[0]?.auth ?? "";
    expect(Buffer.from(auth.replace("Basic ", ""), "base64").toString()).toBe(
      "visp-agent@example.com:test-token",
    );
  });

  it("pulls a feature that has the owner's words but no spec yet", () => {
    setEpic(
      "## The owner's words\n\n<!-- sdlc:owner-text -->\nKeep a work log.\n<!-- /sdlc:owner-text -->",
    );
    const result = sdlc("pull", "VISP-12");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("no spec yet");
    const words = readFileSync(join(repo, ".sdlc/features/VISP-12/owner-text.md"), "utf8");
    expect(words).toBe("Keep a work log.");
  });

  it("refuses an issue with a missing block or another feature's block", () => {
    setEpic(issueBody(INTENT, ACCEPTANCE));
    const missing = sdlc("pull", "VISP-12");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("test-cases@1");

    setEpic(issueBody(INTENT.replace("VISP-12", "VISP-99"), ACCEPTANCE, TEST_CASES));
    const other = sdlc("pull", "VISP-12");
    expect(other.status).toBe(1);
    expect(other.stderr).toContain("VISP-99");
  });

  it("validates files and names the bad field", () => {
    writeFileSync(join(repo, "good.yml"), INTENT);
    writeFileSync(join(repo, "bad.yml"), INTENT.replace("kind: must", "kind: maybe"));
    expect(sdlc("validate", "good.yml").status).toBe(0);
    const bad = sdlc("validate", "good.yml", "bad.yml");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("clauses.0.kind");
  });

  it("traces planned clauses, then fails on a failing linked test", () => {
    sdlc("pull", "VISP-12");
    const planned = sdlc("trace", "VISP-12");
    expect(planned.status, planned.stderr).toBe(0);
    expect(planned.stdout).toMatch(/I-01\s+must\s+planned/);

    const report = {
      testResults: [
        {
          name: join(repo, "tests/worklog.test.ts"),
          assertionResults: [
            { ancestorTitles: ["worklog"], title: "writes one file", status: "failed" },
          ],
        },
      ],
    };
    writeFileSync(join(repo, "report.json"), JSON.stringify(report));
    const failing = sdlc("trace", "VISP-12", "--results", "report.json");
    expect(failing.status).toBe(1);
    expect(failing.stdout).toContain("failing");
  });

  it("writes an owner packet with the clause table, the spec hash and stage reports", () => {
    setTask("VISP-13", issueBody(TASK), "Write worklog files");
    sdlc("pull", "VISP-12");
    const task = join(repo, ".sdlc/features/VISP-12/tasks/VISP-13");
    mkdirSync(task, { recursive: true });
    writeFileSync(
      join(task, "review-20261102T101530Z.yml"),
      [
        "schema: review@1",
        "id: VISP-13-review-20261102T101530Z",
        "feature: VISP-12",
        "task: VISP-13",
        "agent: reviewer",
        "created_at: 2026-11-02T10:15:30Z",
        "status: done",
        "usage: { input_tokens: 1200, output_tokens: 300 }",
        "body:",
        "  verdict: approve",
        "  findings:",
        "    - { id: R-1, severity: advisory, text: Consider a shorter name }",
      ].join("\n"),
    );
    const result = sdlc("packet", "VISP-12");
    expect(result.status, result.stderr).toBe(0);
    const packet = readFileSync(result.stdout.trim(), "utf8");
    expect(packet).toContain("| I-01 | must | planned | AC-01 |");
    expect(packet).toMatch(/Spec hash: `[0-9a-f]{64}`/);
    expect(packet).toContain("Consider a shorter name");
    expect(packet).toContain("1,500 tokens");
    expect(packet).not.toContain("task@1");
    expect(packet).not.toContain("invalid report");
  });

  it("hashes the spec the same way whatever the key order", () => {
    const a = specHash({ b: 1, a: [{ y: 2, x: 1 }] }, { c: "z" });
    const b = specHash({ a: [{ x: 1, y: 2 }], b: 1 }, { c: "z" });
    expect(a).toBe(b);
    expect(a).not.toBe(specHash({ a: [{ x: 1, y: 3 }], b: 1 }, { c: "z" }));
  });

  it("lets the clerk create a task under the epic, move it and comment on it", () => {
    writeFileSync(
      join(repo, "task.yml"),
      "criteria: [AC-01]\nscope:\n  paths: [docs/x.md]\ntrack: standard\nsize: S\n",
    );
    const created = sdlc(
      "jira",
      "create-task",
      "VISP-12",
      "--title",
      "Docs",
      "--task-file",
      "task.yml",
    );
    expect(created.status, created.stderr).toBe(0);
    expect(created.stdout).toContain("created VISP-20 under VISP-12");
    expect(sdlc("jira", "move", "VISP-20", "ready").status).toBe(0);
    writeFileSync(join(repo, "note.md"), "Coder started.");
    expect(sdlc("jira", "comment", "VISP-20", "--body-file", "note.md").status).toBe(0);
    const pulled = sdlc("pull", "VISP-12");
    expect(pulled.status, pulled.stderr).toBe(0);
    const dir = join(repo, ".sdlc/features/VISP-12/tasks/VISP-20");
    expect(readFileSync(join(dir, "task.yml"), "utf8")).toContain("task: VISP-20");
    expect(readFileSync(join(dir, "ticket.yml"), "utf8")).toContain('status: "10022"');
    expect(sdlc("jira", "show", "VISP-20").stdout).toContain("VISP-20 Docs");
  });

  it("warns when the agent's Jira token expires within 30 days, and not before", () => {
    const config = JSON.parse(readFileSync(join(repo, "sdlc.config.json"), "utf8"));
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    config.jira.secret.expires = soon;
    writeFileSync(join(repo, "sdlc.config.json"), JSON.stringify(config));
    const shown = sdlc("pull", "VISP-12");
    expect(shown.status, shown.stderr).toBe(0);
    expect(shown.stderr).toContain(`the Jira token for visp-agent expires on ${soon}`);
    config.jira.secret.expires = "2099-01-01";
    writeFileSync(join(repo, "sdlc.config.json"), JSON.stringify(config));
    expect(sdlc("pull", "VISP-12").stderr).not.toContain("expires");
  });

  it("pulls a task's test links and traces with them over the spec's", () => {
    writeFileSync(
      join(repo, "task.yml"),
      "criteria: [AC-01]\nscope:\n  paths: [docs/x.md]\ntrack: standard\nsize: S\n",
    );
    sdlc("jira", "create-task", "VISP-12", "--title", "Docs", "--task-file", "task.yml");
    const issue = jira.issue("VISP-20");
    const body = `${adfToBody(issue.fields.description)}\n\n\`\`\`yaml\nschema: test-links@1\nfeature: VISP-12\ntask: VISP-20\nlinks:\n  - { case: TC-01, test: 'tests/linked.test.ts > linked > works' }\n\`\`\``;
    jira.setIssue("VISP-20", { summary: "Docs", body, parent: "VISP-12", status: "10022" });
    expect(sdlc("pull", "VISP-12").status).toBe(0);
    const links = readFileSync(
      join(repo, ".sdlc/features/VISP-12/tasks/VISP-20/links.yml"),
      "utf8",
    );
    expect(links).toContain("tests/linked.test.ts > linked > works");
    expect(sdlc("trace", "VISP-12").stdout).not.toContain("TC-01 has no test");
  });

  it("refuses a task contract that does not validate, naming the field", () => {
    writeFileSync(join(repo, "task.yml"), "criteria: []\n");
    const result = sdlc(
      "jira",
      "create-task",
      "VISP-12",
      "--title",
      "Docs",
      "--task-file",
      "task.yml",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scope");
    expect(jira.calls().some((call) => call.method === "POST")).toBe(false);
  });

  it("explains its usage for an unknown command", () => {
    const result = sdlc("deploy");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage");
  });
});
