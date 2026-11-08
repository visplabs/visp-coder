import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

const { specHash } = (await import(
  pathToFileURL(join(process.cwd(), "scripts/sdlc/lib/hash.mjs")).href
)) as { specHash(intent: unknown, acceptance: unknown): string };

// A temporary git repository with feature F-12's spec and task T-13's contract already pulled,
// the spec approved by the owner and the task's ticket Ready, plus a place for Claude Code
// transcripts, for running SDLC hooks against.

export const SPEC: Record<string, string> = {
  "spec/intent.yml": `schema: intent@1
feature: F-12
owner_text: Work log entries are separate timestamped files.
clauses:
  - { id: I-01, text: Work log entries are separate files, kind: must }`,
  "spec/acceptance.yml": `schema: acceptance@1
feature: F-12
criteria:
  - id: AC-01
    clauses: [I-01]
    given: an agent finishes a stage
    when: the stop hook runs
    expect: one new worklog file exists
    level: unit`,
  "spec/test-cases.yml": `schema: test-cases@1
feature: F-12
cases:
  - { id: TC-01, title: stop hook writes one file, criteria: [AC-01] }`,
  "spec/source.yml": "issue: https://x/12\ntitle: Work log\nupdated_at: 2026-11-02T10:00:00Z\n",
  "tasks/T-13/task.yml": `schema: task@1
feature: F-12
task: T-13
criteria: [AC-01]
scope:
  paths: [src/worklog.ts, "tests/**"]
track: standard
size: M`,
};

export type SdlcRepo = {
  repo: string;
  sessions: string;
  git(...args: string[]): string;
  write(path: string, content: string): void;
  read(path: string): string;
  transcript(agentId: string, entries: unknown[]): string;
  cleanup(): void;
};

export function sdlcRepo(): SdlcRepo {
  const root = mkdtempSync(join(tmpdir(), "sdlc-hooks-"));
  const repo = join(root, "repo");
  const sessions = join(root, "sessions");
  mkdirSync(repo);
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  git("init", "-q", "-b", "feat/x");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  write("README.md", "test\n");
  write(".gitignore", ".sdlc/\n");
  write("sdlc.config.json", readFileSync(join(process.cwd(), "sdlc.config.json"), "utf8"));
  git("add", ".");
  git("commit", "-q", "-m", "base");
  for (const [path, content] of Object.entries(SPEC)) write(`.sdlc/features/F-12/${path}`, content);
  write(".sdlc/features/F-12/spec/approval.yml", `approved: true\nhash: ${approvedHash()}\n`);
  write(".sdlc/features/F-12/tasks/T-13/ticket.yml", 'key: T-13\nstatus: "10022"\n');
  const transcript = (agentId: string, entries: unknown[]) => {
    const path = join(sessions, "session-1", "subagents", `agent-${agentId}.jsonl`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n"));
    return path;
  };
  return {
    repo,
    sessions,
    git,
    write,
    read: (path: string) => readFileSync(join(repo, path), "utf8"),
    transcript,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// A filed review report of T-13, as subagent-stop writes it.
export function reviewReport(round: number, verdict: string, commit?: string) {
  return [
    "schema: review@1",
    `id: T-13-review-${round}`,
    "feature: F-12",
    "task: T-13",
    "agent: reviewer",
    ...(commit ? [`commit: ${commit}`] : []),
    `created_at: 2026-11-07T10:${String(round).padStart(2, "0")}:00Z`,
    "status: done",
    "body:",
    `  verdict: ${verdict}`,
    "  findings: []",
  ].join("\n");
}

// The hash of SPEC's intent and acceptance, as the owner approved them.
export function approvedHash(): string {
  return specHash(parse(SPEC["spec/intent.yml"] ?? ""), parse(SPEC["spec/acceptance.yml"] ?? ""));
}

export function runHook(hook: string, input: unknown, env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [join(process.cwd(), "scripts/sdlc/hooks", hook)], {
    input: JSON.stringify(input),
    // A hook that reaches Jira gets a closed port unless the test starts a fake one, so no test
    // talks to the real site with the keyring's token.
    env: {
      ...process.env,
      SDLC_OWNER: "1",
      SDLC_JIRA_URL: "http://127.0.0.1:9",
      SDLC_SECRET_CMD: "printf %s test@example.com:test",
      ...env,
    },
    encoding: "utf8",
  });
  const json = result.stdout.trim() ? safeJson(result.stdout) : undefined;
  return { ...result, json };
}

function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

// The first user turn of a subagent transcript, as the contract hook leaves it.
export function promptEntry(text: string) {
  return { type: "user", message: { role: "user", content: text } };
}
