import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SPEC } from "./sdlc-repo.js";

const { bodyToAdf } = (await import(
  pathToFileURL(join(process.cwd(), "scripts/sdlc/lib/adf.mjs")).href
)) as { bodyToAdf(body: string): unknown };

// Starts fake-jira-server.mjs on a free port with its state in `dir`, and gives tests the env a
// hook or command needs to reach it as the agent service account.

// An epic body as /feature and the qe-spec stop hook leave it, with sdlc-repo's spec blocks.
export function epicBody(ownerText: string, withSpec = true) {
  const blocks = ["spec/intent.yml", "spec/acceptance.yml", "spec/test-cases.yml"]
    .map((file) => `\`\`\`yaml\n${SPEC[file] ?? ""}\n\`\`\``)
    .join("\n\n");
  return [
    "## The owner's words",
    "",
    "<!-- sdlc:owner-text -->",
    ownerText,
    "<!-- /sdlc:owner-text -->",
    "",
    "## Spec",
    "",
    "<!-- sdlc:spec -->",
    withSpec ? blocks : "_No spec yet._",
    "<!-- /sdlc:spec -->",
  ].join("\n");
}

export type FakeJira = {
  env: Record<string, string>;
  setIssue(key: string, fields: IssueFields): void;
  setComments(key: string, comments: Comment[]): void;
  setChangelog(key: string, created: string[]): void;
  issue(key: string): { fields: IssueFields & { description: unknown; issuetype: { id: string } } };
  calls(): { method: string; path: string; auth?: string; body?: unknown }[];
  stop(): void;
};

type IssueFields = {
  summary: string;
  body?: string;
  status?: string;
  type?: string;
  parent?: string;
  updated?: string;
};

export type Comment = {
  id: string;
  author: string;
  updateAuthor?: string;
  created: string;
  updated?: string;
  text: string;
};

export async function startFakeJira(dir: string): Promise<FakeJira> {
  const server: ChildProcess = spawn(
    process.execPath,
    [join(import.meta.dirname, "fake-jira-server.mjs"), dir],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const port = await new Promise<string>((resolve, reject) => {
    server.stdout?.once("data", (data: Buffer) => resolve(data.toString().trim()));
    server.once("error", reject);
  });
  const statePath = join(dir, "state.json");
  const state = () =>
    existsSync(statePath)
      ? JSON.parse(readFileSync(statePath, "utf8"))
      : { issues: {}, comments: {}, changelog: {}, next: 20 };
  const save = (value: unknown) => writeFileSync(statePath, JSON.stringify(value));
  return {
    env: {
      SDLC_JIRA_URL: `http://127.0.0.1:${port}`,
      SDLC_SECRET_CMD: "printf %s visp-agent@example.com:test-token",
    },
    setIssue(key, fields) {
      const value = state();
      value.issues[key] = {
        key,
        fields: {
          summary: fields.summary,
          description: bodyToAdf(fields.body ?? ""),
          status: { id: fields.status ?? "10021" },
          issuetype: { id: fields.type ?? "10017" },
          ...(fields.parent ? { parent: { key: fields.parent } } : {}),
          updated: fields.updated ?? "2026-11-07T09:00:00.000+0000",
        },
      };
      save(value);
    },
    setComments(key, comments) {
      const value = state();
      value.comments[key] = comments.map((c) => ({
        id: c.id,
        author: { accountId: c.author },
        updateAuthor: { accountId: c.updateAuthor ?? c.author },
        created: c.created,
        updated: c.updated ?? c.created,
        body: bodyToAdf(c.text),
      }));
      save(value);
    },
    setChangelog(key, created) {
      const value = state();
      value.changelog[key] = created.map((at) => ({
        created: at,
        items: [{ field: "description" }],
      }));
      save(value);
    },
    issue(key) {
      return state().issues[key];
    },
    calls() {
      const path = join(dir, "calls.jsonl");
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
    stop() {
      server.kill();
    },
  };
}
