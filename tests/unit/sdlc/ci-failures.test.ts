import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeGh } from "./support/fake-gh.js";
import { type SdlcRepo, sdlcRepo } from "./support/sdlc-repo.js";

let fixture: SdlcRepo;
let gh = "";
let sonar: Server;
let sonarUrl = "";
let sonarIssues: { rule: string; component: string; line?: number; message: string }[] = [];
let sonarQueries: URLSearchParams[] = [];
const cli = join(process.cwd(), "scripts/sdlc/sdlc.mjs");

function startSonar() {
  sonar = createServer((request, response) => {
    sonarQueries.push(new URL(request.url ?? "", "http://x").searchParams);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ total: sonarIssues.length, issues: sonarIssues }));
  });
  return new Promise<void>((resolve) =>
    sonar.listen(0, "127.0.0.1", () => {
      sonarUrl = `http://127.0.0.1:${(sonar.address() as AddressInfo).port}`;
      resolve();
    }),
  );
}

function ciFailures(...args: string[]) {
  const child = spawn(process.execPath, [cli, "ci-failures", ...args], {
    cwd: fixture.repo,
    env: { ...process.env, SDLC_GH: gh, FAKE_DIR: fixture.repo, SDLC_SONAR_URL: sonarUrl },
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

function setChecks(checks: { name: string; bucket: string; link: string }[]) {
  writeFileSync(join(fixture.repo, "checks-109.json"), JSON.stringify(checks));
}

const log = () =>
  fixture
    .read(".sdlc/mistakes.jsonl")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

describe("sdlc ci-failures", () => {
  beforeEach(async () => {
    fixture = sdlcRepo();
    gh = installFakeGh(fixture.repo);
    sonarIssues = [];
    sonarQueries = [];
    await startSonar();
  });
  afterEach(() => {
    sonar.close();
    fixture.cleanup();
  });

  it("logs each failed check of a task's pull request to the mistake log and prints it", async () => {
    setChecks([
      { name: "test (1)", bucket: "fail", link: "https://ci/1" },
      { name: "check", bucket: "fail", link: "https://ci/2" },
      { name: "lint", bucket: "pass", link: "https://ci/3" },
    ]);
    const result = await ciFailures("109", "--task", "VISP-3");
    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain("test (1) https://ci/1");
    expect(log()).toEqual([
      expect.objectContaining({ hook: "ci", reason: "VISP-3 CI check test (1) failed on PR #109" }),
      expect.objectContaining({ hook: "ci", reason: "VISP-3 CI check check failed on PR #109" }),
    ]);
  });

  it("prints the PR's new Sonar issues with file and line, and logs each rule for the retro", async () => {
    setChecks([{ name: "sonar", bucket: "fail", link: "https://ci/4" }]);
    sonarIssues = [
      {
        rule: "typescript:S2871",
        component: "visplabs_visp-coder:src/a.ts",
        line: 12,
        message: "Provide a compare function",
      },
      {
        rule: "typescript:S3776",
        component: "visplabs_visp-coder:src/b.ts",
        message: "Reduce complexity",
      },
    ];
    const result = await ciFailures("109", "--task", "VISP-3");
    expect(result.stdout).toContain(
      "sonar typescript:S2871 src/a.ts:12 Provide a compare function",
    );
    expect(result.stdout).toContain("sonar typescript:S3776 src/b.ts Reduce complexity");
    expect(sonarQueries[0]?.get("pullRequest")).toBe("109");
    expect(sonarQueries[0]?.get("componentKeys")).toBe("visplabs_visp-coder");
    const sonarEntries = log().filter((entry) => entry.hook.startsWith("sonar"));
    expect(sonarEntries.map((entry) => entry.hook)).toEqual([
      "sonar typescript:S2871",
      "sonar typescript:S3776",
    ]);
    expect(sonarEntries[0].signature).not.toBe(sonarEntries[1].signature);
  });

  it("logs nothing when no check failed and Sonar found nothing", async () => {
    setChecks([{ name: "lint", bucket: "pass", link: "https://ci/3" }]);
    expect((await ciFailures("109", "--task", "VISP-3")).stdout).toContain("no failed checks");
    expect(() => fixture.read(".sdlc/mistakes.jsonl")).toThrow();
  });
});
