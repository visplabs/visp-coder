import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promptEntry, type SdlcRepo, SPEC, sdlcRepo } from "./support/sdlc-repo.js";

let fixture: SdlcRepo;
let sentry: Server;
let sentryUrl = "";
let answer = { status: 200, count: 0 };
let requests: { url: string; auth: string }[] = [];

// A Sentry events API that answers every count query with `answer`.
function startSentry() {
  sentry = createServer((request, response) => {
    requests.push({ url: request.url ?? "", auth: request.headers.authorization ?? "" });
    response.writeHead(answer.status, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify(answer.status === 200 ? { data: [{ "count()": answer.count }] } : {}),
    );
  });
  return new Promise<void>((resolve) =>
    sentry.listen(0, "127.0.0.1", () => {
      sentryUrl = `http://127.0.0.1:${(sentry.address() as AddressInfo).port}`;
      resolve();
    }),
  );
}

function qeReport(verdict: string, events?: number) {
  const lines = [
    "```yaml",
    "status: done",
    "body:",
    `  verdict: ${verdict}`,
    "  cases: [{ id: TC-01, result: pass, evidence: 'pnpm test:browser' }]",
    ...(events === undefined ? [] : [`  sentry_events: ${events}`]),
    "```",
  ];
  fixture.transcript("q1", [
    { ...promptEntry("Verify it.\nSDLC-Task: F-12/T-13"), timestamp: "2026-11-08T10:00:00.000Z" },
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

// The stop hook for the qe-verify agent, run without blocking this process's Sentry server.
function stopQe() {
  const event = {
    hook_event_name: "SubagentStop",
    agent_id: "q1",
    agent_type: "qe-verify",
    agent_transcript_path: join(fixture.sessions, "session-1", "subagents", "agent-q1.jsonl"),
    cwd: fixture.repo,
  };
  const child = spawn(
    process.execPath,
    [join(process.cwd(), "scripts/sdlc/hooks/subagent-stop.mjs")],
    {
      env: {
        ...process.env,
        SDLC_OWNER: "1",
        SDLC_VERIFY: "off",
        SDLC_TRANSCRIPT_WAIT_MS: "0",
        SDLC_SENTRY_SETTLE_MS: "0",
        SDLC_SENTRY_URL: sentryUrl,
        SENTRY_READ_TOKEN: "read-token",
        SDLC_MISTAKE_LOG: join(fixture.repo, "..", "mistakes.jsonl"),
      },
    },
  );
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stdin.end(JSON.stringify(event));
  return new Promise<string>((resolve) => child.on("close", () => resolve(stdout)));
}

const blockReason = (stdout: string) =>
  stdout.trim() ? String((JSON.parse(stdout) as { reason?: string }).reason ?? "") : "";

function filed() {
  const dir = join(fixture.repo, ".sdlc/features/F-12/tasks/T-13");
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith("qe-report")) : [];
}

function journeyTask() {
  const journey = (SPEC["spec/acceptance.yml"] ?? "").replace("level: unit", "level: journey");
  fixture.write(".sdlc/features/F-12/spec/acceptance.yml", journey);
}

describe("the Sentry zero-events check on a qe-verify report", () => {
  beforeEach(async () => {
    fixture = sdlcRepo();
    answer = { status: 200, count: 0 };
    requests = [];
    await startSentry();
    journeyTask();
  });
  afterEach(() => {
    sentry.close();
    fixture.cleanup();
  });

  it("files a passing report when Sentry holds no qe event for the task since the run began", async () => {
    qeReport("pass", 0);
    expect(blockReason(await stopQe())).toBe("");
    expect(filed()).toHaveLength(1);
    const query = new URL(requests[0]?.url ?? "", sentryUrl).searchParams;
    expect(query.get("query")).toBe("project:visp-coder environment:qe task:T-13");
    expect(query.get("start")).toBe("2026-11-08T10:00:00.000Z");
    expect(requests[0]?.auth).toBe("Bearer read-token");
  });

  it("refuses a passing report when Sentry holds events the report did not count", async () => {
    answer = { status: 200, count: 2 };
    qeReport("pass", 0);
    expect(blockReason(await stopQe())).toContain("Sentry holds 2 qe events");
    expect(filed()).toEqual([]);
  });

  it("files a failing report that counts the events, for the verify loop", async () => {
    answer = { status: 200, count: 2 };
    qeReport("fail", 2);
    expect(blockReason(await stopQe())).toBe("");
    expect(filed()).toHaveLength(1);
  });

  it("refuses a report without sentry_events", async () => {
    qeReport("pass");
    expect(blockReason(await stopQe())).toContain("sentry_events");
  });

  it("fails closed when Sentry cannot be asked", async () => {
    answer = { status: 500, count: 0 };
    qeReport("pass", 0);
    expect(blockReason(await stopQe())).toContain("cannot ask Sentry");
  });

  it("does not ask Sentry for a task without journey criteria", async () => {
    fixture.write(".sdlc/features/F-12/spec/acceptance.yml", SPEC["spec/acceptance.yml"] ?? "");
    qeReport("pass");
    expect(blockReason(await stopQe())).toBe("");
    expect(requests).toEqual([]);
  });
});

describe("sdlc sentry-events", () => {
  beforeEach(async () => {
    fixture = sdlcRepo();
    answer = { status: 200, count: 3 };
    requests = [];
    await startSentry();
  });
  afterEach(() => {
    sentry.close();
    fixture.cleanup();
  });

  function sentryEvents(...args: string[]) {
    const cli = join(process.cwd(), "scripts/sdlc/sdlc.mjs");
    const child = spawn(process.execPath, [cli, "sentry-events", ...args], {
      cwd: fixture.repo,
      env: { ...process.env, SDLC_SENTRY_URL: sentryUrl, SENTRY_READ_TOKEN: "read-token" },
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    return new Promise<{ status: number | null; output: string }>((resolve) =>
      child.on("close", (status) => resolve({ status, output })),
    );
  }

  it("prints the count of qe events for a task since a time, without showing the token", async () => {
    const result = await sentryEvents("--task", "VISP-3", "--since", "2026-11-08T10:00:00Z");
    expect(result.status, result.output).toBe(0);
    expect(result.output.trim()).toBe("sentry_events: 3");
    expect(result.output).not.toContain("read-token");
    expect(new URL(requests[0]?.url ?? "", sentryUrl).searchParams.get("query")).toContain(
      "task:VISP-3",
    );
  });

  it("refuses a task that is not a Jira key or a time that does not parse", async () => {
    expect((await sentryEvents("--task", "x", "--since", "2026-11-08T10:00:00Z")).status).toBe(1);
    expect((await sentryEvents("--task", "VISP-3", "--since", "yesterday")).status).toBe(1);
  });
});
