import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { installFakeGh } from "./support/fake-gh.js";
import { epicBody, type FakeJira, startFakeJira } from "./support/fake-jira.js";
import { type SdlcRepo, SPEC, sdlcRepo } from "./support/sdlc-repo.js";

const cli = join(process.cwd(), "scripts/sdlc/sdlc.mjs");
const lib = (name: string) => pathToFileURL(join(process.cwd(), "scripts/sdlc/lib", name)).href;
const { specHash } = (await import(lib("hash.mjs"))) as {
  specHash(intent: unknown, acceptance: unknown): string;
};
const { approvalLine } = (await import(lib("approval.mjs"))) as {
  approvalLine(feature: string, hash: string): string;
};

let fixture: SdlcRepo;
let jira: FakeJira;
let gh = "";
const OWNER = "owner-account";
const OWNER_TEXT = "Work log entries are separate timestamped files.";
const TEST = "tests/worklog.test.ts > worklog > writes one file";
const CASES = SPEC["spec/test-cases.yml"] ?? "";
const HASH = specHash(
  parse(SPEC["spec/intent.yml"] ?? ""),
  parse(SPEC["spec/acceptance.yml"] ?? ""),
);
const LINKED = CASES.replace("criteria: [AC-01] }", `criteria: [AC-01], test: '${TEST}' }`);
const TASK_BODY = `\`\`\`yaml\n${SPEC["tasks/T-13/task.yml"]}\n\`\`\``;

function setEpic({ linked = true, journey = false } = {}) {
  const body = epicBody(OWNER_TEXT)
    .replace(CASES, linked ? LINKED : CASES)
    .replace("level: unit", journey ? "level: journey" : "level: unit");
  jira.setIssue("F-12", { summary: "Work log", body, type: "10000" });
  jira.setChangelog("F-12", ["2026-11-05T11:00:00.000+0000"]);
}

function approve({ author = OWNER, hash = HASH, edited = false } = {}) {
  const created = "2026-11-05T12:00:00.000+0000";
  jira.setComments("F-12", [
    {
      id: "c1",
      author,
      created,
      updated: edited ? "2026-11-05T12:30:00.000+0000" : created,
      text: approvalLine("F-12", hash),
    },
  ]);
}

const COMMITTED = "2026-11-08T09:00:00Z";

function setPr(
  body: string,
  { branch = "sdlc/agent-a1", commits = [] as string[], labels = [] as string[] } = {},
) {
  const pr = {
    body,
    headRefName: branch,
    labels: labels.map((name) => ({ name })),
    commits: [...commits, "last"].map((message) => ({
      messageHeadline: message,
      messageBody: "",
      committedDate: COMMITTED,
    })),
  };
  writeFileSync(join(fixture.repo, "pr-104.json"), JSON.stringify(pr));
}

function setResults(status: string) {
  const report = {
    testResults: [
      {
        name: join(fixture.repo, "tests/worklog.test.ts"),
        assertionResults: [{ ancestorTitles: ["worklog"], title: "writes one file", status }],
      },
    ],
  };
  writeFileSync(join(fixture.repo, "results.json"), JSON.stringify(report));
}

// The gate as CI runs it: the owner's id comes from the environment, never from the config.
function checkPr(env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [cli, "check-pr", "104", "--results", "results.json"], {
    cwd: fixture.repo,
    env: {
      ...process.env,
      ...jira.env,
      SDLC_GH: gh,
      FAKE_DIR: fixture.repo,
      SDLC_OWNER_ACCOUNT_ID: OWNER,
      SDLC_SENTRY_URL: sentryUrl,
      SENTRY_READ_TOKEN: "read-token",
      ...env,
    },
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stdout += chunk;
  });
  return new Promise<{ status: number | null; stdout: string }>((resolve) =>
    child.on("close", (status) => resolve({ status, stdout })),
  );
}

let sentry: Server;
let sentryUrl = "";
let sentryAnswer = { status: 200, count: 0 };
let sentryQueries: URLSearchParams[] = [];

function startSentry() {
  sentry = createServer((request, response) => {
    sentryQueries.push(new URL(request.url ?? "", "http://x").searchParams);
    response.writeHead(sentryAnswer.status, { "Content-Type": "application/json" });
    const count = { data: [{ "count()": sentryAnswer.count }] };
    response.end(JSON.stringify(sentryAnswer.status === 200 ? count : {}));
  });
  return new Promise<void>((resolve) =>
    sentry.listen(0, "127.0.0.1", () => {
      sentryUrl = `http://127.0.0.1:${(sentry.address() as AddressInfo).port}`;
      resolve();
    }),
  );
}

describe("sdlc check-pr", () => {
  beforeEach(async () => {
    fixture = sdlcRepo();
    sentryAnswer = { status: 200, count: 0 };
    sentryQueries = [];
    await startSentry();
    jira = await startFakeJira(fixture.repo);
    gh = installFakeGh(fixture.repo);
    jira.setIssue("T-13", { summary: "Write worklog files", body: TASK_BODY, parent: "F-12" });
    setEpic();
    approve();
    setPr("Adds the worklog.\n\nTask: T-13");
    setResults("passed");
  });
  afterEach(() => {
    sentry.close();
    jira.stop();
    fixture.cleanup();
  });

  it("passes a task PR whose spec the owner approved in Jira and whose tests pass", async () => {
    const result = await checkPr();
    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain("F-12/T-13");
    expect(result.stdout).toContain("pass");
  });

  it("finds the task line in a commit message too", async () => {
    setPr("No trailer here.", { commits: ["feat: worklog\n\nTask: T-13"] });
    expect((await checkPr()).status).toBe(0);
  });

  it("skips a pull request from outside the pipeline that names no task", async () => {
    setPr("Dependency bump.", { branch: "deps/vitest" });
    const result = await checkPr();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("skipped");
  });

  it("fails an agent pull request that names no task", async () => {
    setPr("Adds the worklog.");
    const result = await checkPr();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("sdlc/agent-a1 is an agent branch");
  });

  it("refuses to run without the owner's account id from the environment", async () => {
    const result = await checkPr({ SDLC_OWNER_ACCOUNT_ID: "" });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("SDLC_OWNER_ACCOUNT_ID");
  });

  it("fails when someone other than the owner approved", async () => {
    approve({ author: "visp-agent" });
    const result = await checkPr();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("not written by the owner");
  });

  it("fails when the approval was edited or the spec changed after it", async () => {
    approve({ edited: true });
    expect((await checkPr()).stdout).toContain("edited after posting");
    approve();
    jira.setChangelog("F-12", ["2026-11-05T13:00:00.000+0000"]);
    const result = await checkPr();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("description changed after");
  });

  it("fails when the spec no longer matches the approved hash", async () => {
    approve({ hash: "0".repeat(64) });
    const result = await checkPr();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("spec changed");
  });

  it("fails when a linked test does not pass", async () => {
    setResults("failed");
    const result = await checkPr();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("failing");
  });

  it("passes with the links the stop hook keeps in the task issue, over an unlinked spec", async () => {
    setEpic({ linked: false });
    const links = `\`\`\`yaml\nschema: test-links@1\nfeature: F-12\ntask: T-13\nlinks:\n  - { case: TC-01, test: '${TEST}' }\n\`\`\``;
    jira.setIssue("T-13", {
      summary: "Write worklog files",
      body: `${TASK_BODY}\n\n${links}`,
      parent: "F-12",
    });
    const result = await checkPr();
    expect(result.status, result.stdout).toBe(0);
  });

  it("fails when a criterion of the task has no linked test", async () => {
    setEpic({ linked: false });
    const result = await checkPr();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("TC-01");
  });

  describe("for a task with journey criteria", () => {
    const journeyHash = specHash(
      parse(SPEC["spec/intent.yml"] ?? ""),
      parse((SPEC["spec/acceptance.yml"] ?? "").replace("level: unit", "level: journey")),
    );
    beforeEach(() => {
      setEpic({ journey: true });
      approve({ hash: journeyHash });
    });

    it("passes when Sentry holds no qe event for the task since the head commit", async () => {
      const result = await checkPr();
      expect(result.status, result.stdout).toBe(0);
      expect(sentryQueries[0]?.get("query")).toBe("project:visp-coder environment:qe task:T-13");
      expect(sentryQueries[0]?.get("start")).toBe("2026-11-08T09:00:00.000Z");
    });

    it("fails when Sentry holds qe events for the task", async () => {
      sentryAnswer = { status: 200, count: 1 };
      const result = await checkPr();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("Sentry holds 1 qe event");
    });

    it("fails closed when Sentry cannot be asked, unless the owner overrides by label", async () => {
      sentryAnswer = { status: 500, count: 0 };
      const result = await checkPr();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("cannot ask Sentry");
      setPr("Adds the worklog.\n\nTask: T-13", { labels: ["sdlc-sentry-override"] });
      const overridden = await checkPr();
      expect(overridden.status, overridden.stdout).toBe(0);
      expect(overridden.stdout).toContain("overridden by the sdlc-sentry-override label");
    });
  });

  it("does not ask Sentry for a task without journey criteria", async () => {
    expect((await checkPr()).status).toBe(0);
    expect(sentryQueries).toEqual([]);
  });
});
