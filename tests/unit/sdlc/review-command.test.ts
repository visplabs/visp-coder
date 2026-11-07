import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { reviewReport, type SdlcRepo, sdlcRepo } from "./support/sdlc-repo.js";

let fixture: SdlcRepo;
const cli = join(process.cwd(), "scripts/sdlc/sdlc.mjs");

// A stand-in codex: records its arguments and CODEX_HOME, then writes ANSWER to the -o file,
// or fails when ANSWER is "fail".
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.CALL_FILE, JSON.stringify({ args, home: process.env.CODEX_HOME }));
if (process.env.ANSWER === "fail") process.exit(1);
fs.writeFileSync(args[args.indexOf("-o") + 1], process.env.ANSWER);
`;

const ANSWER = {
  status: "done",
  body: {
    verdict: "changes_requested",
    findings: [
      {
        id: "R-1",
        severity: "blocking",
        cites: "AC-01",
        text: "Writes two files",
        file: "src/worklog.ts",
        line: 3,
        evidence_command: "pnpm exec vitest run tests/worklog.test.ts",
      },
      {
        id: "R-2",
        severity: "advisory",
        cites: null,
        text: "Shorter name",
        file: null,
        line: null,
        evidence_command: null,
      },
    ],
    clauses: [{ clause: "I-01", status: "partial", note: null }],
    unrequested: [],
    uncaptured: [],
  },
};

function review(answer: string) {
  return spawnSync(
    process.execPath,
    [cli, "review", "--task", "F-12/T-13", "--worktree", fixture.repo],
    {
      cwd: fixture.repo,
      encoding: "utf8",
      env: {
        ...process.env,
        SDLC_CODEX: join(fixture.repo, "..", "fake-codex"),
        CALL_FILE: join(fixture.repo, "..", "call.json"),
        ANSWER: answer,
      },
    },
  );
}

const call = () =>
  JSON.parse(readFileSync(join(fixture.repo, "..", "call.json"), "utf8")) as {
    args: string[];
    home: string;
  };

describe("sdlc review", () => {
  beforeEach(() => {
    fixture = sdlcRepo();
    fixture.git("update-ref", "refs/remotes/origin/chore/sdlc-atlassian", "HEAD");
    writeFileSync(join(fixture.repo, "..", "fake-codex"), FAKE_CODEX);
    chmodSync(join(fixture.repo, "..", "fake-codex"), 0o755);
  });
  afterEach(() => fixture.cleanup());

  it("runs Codex read-only in the pipeline's own home with the config's model and schema", () => {
    const result = review(JSON.stringify(ANSWER));
    expect(result.status, result.stderr).toBe(0);
    const { args, home } = call();
    expect(home).toBe(join(homedir(), ".codex-visp"));
    expect(args.slice(0, 11)).toEqual([
      "exec",
      "--strict-config",
      "--ephemeral",
      "--ignore-rules",
      "-m",
      "gpt-6.1-sol",
      "-c",
      "model_reasoning_effort=max",
      "-s",
      "read-only",
      "--cd",
    ]);
    expect(args).toContain("--output-schema");
    const prompt = args.at(-1) ?? "";
    expect(prompt).toContain("Work log entries are separate timestamped files.");
    expect(prompt).toContain("AC-01");
    expect(prompt).toContain("first round");
  });

  it("writes a review@1 body without nulls and prints its path and sha256", () => {
    const result = review(JSON.stringify(ANSWER));
    const path = result.stdout.match(/^review_file: (.+)$/m)?.[1] ?? "";
    expect(result.stdout).toMatch(/^sha256: [0-9a-f]{64}$/m);
    const report = parse(readFileSync(path, "utf8"));
    expect(report.commit).toBe(fixture.git("rev-parse", "HEAD"));
    expect(report.body.findings[0].evidence).toEqual({
      command: "pnpm exec vitest run tests/worklog.test.ts",
    });
    expect(report.body.findings[1]).toEqual({
      id: "R-2",
      severity: "advisory",
      text: "Shorter name",
    });
  });

  it("gives a later round the commits since the last review and the earlier findings", () => {
    const reviewed = fixture.git("rev-parse", "HEAD");
    fixture.write(
      ".sdlc/features/F-12/tasks/T-13/review-1.yml",
      reviewReport(1, "changes_requested", reviewed),
    );
    review(JSON.stringify(ANSWER));
    const prompt = call().args.at(-1) ?? "";
    expect(prompt).toContain(`${reviewed}..`);
    expect(prompt).not.toContain("first round");
  });

  it("tells Codex which criteria the epic's other tasks carry", () => {
    fixture.write(
      ".sdlc/features/F-12/tasks/T-14/task.yml",
      "schema: task@1\nfeature: F-12\ntask: T-14\ncriteria: [AC-02]\nscope:\n  paths: [docs/x.md]\ntrack: trivial\nsize: S\n",
    );
    review(JSON.stringify(ANSWER));
    const prompt = call().args.at(-1) ?? "";
    expect(prompt).toContain("- T-14: AC-02");
    expect(prompt).toContain("is not a finding against this task");
  });

  it("hands Codex the stop hook's passing run at this head instead of asking it to run tests", () => {
    const head = fixture.git("rev-parse", "HEAD");
    const ran = ["pnpm build:fast", "pnpm exec vitest run --bail=1 tests/x.test.ts"];
    fixture.write(".sdlc/run/verified/F-12/T-13.json", JSON.stringify({ commit: head, ran }));
    review(JSON.stringify(ANSWER));
    const prompt = call().args.at(-1) ?? "";
    expect(prompt).toContain(`passed at ${head}:`);
    expect(prompt).toContain("- pnpm exec vitest run --bail=1 tests/x.test.ts");
    expect(prompt).toContain("Do not run vitest");
    expect(prompt).not.toContain("Run tests you need");
  });

  it("says when no passing run covers this head", () => {
    fixture.write(
      ".sdlc/run/verified/F-12/T-13.json",
      JSON.stringify({ commit: "f".repeat(40), ran: [] }),
    );
    review(JSON.stringify(ANSWER));
    expect(call().args.at(-1)).toContain("No run of the stop hook covers this head");
  });

  it("exits 3 when Codex fails, and stops the epic after two failures", () => {
    expect(review("fail").status).toBe(3);
    expect(review("fail").status).toBe(3);
    const third = review(JSON.stringify(ANSWER));
    expect(third.status).toBe(1);
    expect(third.stderr).toContain("ask the owner");
  });
});
