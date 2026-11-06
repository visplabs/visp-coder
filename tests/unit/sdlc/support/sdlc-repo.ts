import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// A temporary git repository with feature F-12's spec and task T-13's contract already pulled,
// plus a place for Claude Code transcripts, for running SDLC hooks against.

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
    transcript,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function runHook(hook: string, input: unknown, env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [join(process.cwd(), "scripts/sdlc/hooks", hook)], {
    input: JSON.stringify(input),
    env: { ...process.env, SDLC_OWNER: "1", ...env },
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
