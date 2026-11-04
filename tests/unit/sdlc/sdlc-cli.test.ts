import { spawnSync } from "node:child_process";
import {
  chmodSync,
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

const cli = join(process.cwd(), "scripts/sdlc/sdlc.mjs");
const { specHash } = (await import(
  pathToFileURL(join(process.cwd(), "scripts/sdlc/lib/hash.mjs")).href
)) as { specHash(intent: unknown, acceptance: unknown): string };

const INTENT = `schema: intent@1
feature: F-12
owner_text: Work log entries are separate timestamped files.
clauses:
  - id: I-01
    text: Work log entries are separate files
    kind: must`;
const ACCEPTANCE = `schema: acceptance@1
feature: F-12
criteria:
  - id: AC-01
    clauses: [I-01]
    given: an agent finishes a stage
    when: the stop hook runs
    expect: one new worklog file exists
    level: unit`;
const TEST_CASES = `schema: test-cases@1
feature: F-12
cases:
  - id: TC-01
    title: stop hook writes one file
    criteria: [AC-01]
    test: tests/worklog.test.ts > worklog > writes one file`;

const TASK = `schema: task@1
feature: F-12
task: T-13
criteria: [AC-01]
scope:
  paths: [scripts/sdlc/lib/worklog.mjs, "tests/unit/sdlc/**"]
track: standard
size: M`;

let repo = "";

function issueBody(...blocks: string[]) {
  return ["Owner request.", ...blocks.map((block) => `\`\`\`yaml\n${block}\n\`\`\``)].join("\n\n");
}

function setIssue(body: string, number = 12, title = "Work log") {
  const issue = { title, body, updatedAt: "2026-11-02T10:00:00Z", url: `https://x/${number}` };
  writeFileSync(join(repo, `issue-${number}.json`), JSON.stringify(issue));
}

function setSubIssues(numbers: number[]) {
  writeFileSync(
    join(repo, "sub-issues.json"),
    JSON.stringify(numbers.map((number) => ({ number }))),
  );
}

function sdlc(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, SDLC_GH: join(repo, "fake-gh"), FAKE_DIR: repo },
  });
}

describe("sdlc command line", () => {
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "sdlc-cli-"));
    spawnSync("git", ["init", "-q", repo]);
    writeFileSync(
      join(repo, "fake-gh"),
      '#!/bin/sh\nif [ "$1" = api ]; then cat "$FAKE_DIR/sub-issues.json"; else cat "$FAKE_DIR/issue-$3.json"; fi\n',
    );
    chmodSync(join(repo, "fake-gh"), 0o755);
    setIssue(issueBody(INTENT, ACCEPTANCE, TEST_CASES));
    setSubIssues([]);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("pulls the spec into a read-only cache, and pulls again over it", () => {
    expect(sdlc("pull", "F-12").status).toBe(0);
    const spec = join(repo, ".sdlc/features/F-12/spec");
    for (const file of ["intent.yml", "acceptance.yml", "test-cases.yml", "source.yml"]) {
      expect(existsSync(join(spec, file)), file).toBe(true);
    }
    expect(statSync(join(spec, "intent.yml")).mode & 0o222).toBe(0);
    expect(sdlc("pull", "F-12").status).toBe(0);
  });

  it("pulls each task sub-issue's contract next to the spec", () => {
    setSubIssues([13, 14]);
    setIssue(issueBody(TASK), 13, "Write worklog files");
    setIssue("A sub-issue without a task block.", 14, "Notes");
    const result = sdlc("pull", "F-12");
    expect(result.status, result.stderr).toBe(0);
    const task = readFileSync(join(repo, ".sdlc/features/F-12/tasks/T-13/task.yml"), "utf8");
    expect(task).toContain("scripts/sdlc/lib/worklog.mjs");
    expect(result.stdout).toContain("#14 has no task@1 block");
  });

  it("pulls a feature that has the owner's words but no spec yet", () => {
    setIssue("<!-- sdlc:owner-text -->\nKeep a work log.\n<!-- /sdlc:owner-text -->");
    const result = sdlc("pull", "F-12");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("no spec yet");
    const words = readFileSync(join(repo, ".sdlc/features/F-12/owner-text.md"), "utf8");
    expect(words).toBe("Keep a work log.");
  });

  it("refuses an issue with a missing block or another feature's block", () => {
    setIssue(issueBody(INTENT, ACCEPTANCE));
    const missing = sdlc("pull", "F-12");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("test-cases@1");

    setIssue(issueBody(INTENT.replace("F-12", "F-99"), ACCEPTANCE, TEST_CASES));
    const other = sdlc("pull", "F-12");
    expect(other.status).toBe(1);
    expect(other.stderr).toContain("F-99");
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
    sdlc("pull", "F-12");
    const planned = sdlc("trace", "F-12");
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
    const failing = sdlc("trace", "F-12", "--results", "report.json");
    expect(failing.status).toBe(1);
    expect(failing.stdout).toContain("failing");
  });

  it("writes an owner packet with the clause table, the spec hash and stage reports", () => {
    setSubIssues([13]);
    setIssue(issueBody(TASK), 13, "Write worklog files");
    sdlc("pull", "F-12");
    const task = join(repo, ".sdlc/features/F-12/tasks/T-13");
    mkdirSync(task, { recursive: true });
    writeFileSync(
      join(task, "review-20261102T101530Z.yml"),
      [
        "schema: review@1",
        "id: T-13-review-20261102T101530Z",
        "feature: F-12",
        "task: T-13",
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
    const result = sdlc("packet", "F-12");
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

  it("explains its usage for an unknown command", () => {
    const result = sdlc("deploy");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage");
  });
});
