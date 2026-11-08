import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SdlcRepo, sdlcRepo } from "./support/sdlc-repo.js";

let fixture: SdlcRepo;
let sentry: Server;
let sentryUrl = "";
let answer: { status: number; issues: { title: string; permalink: string }[] };
let requests: { url: URL; auth: string }[] = [];

function startSentry() {
  sentry = createServer((request, response) => {
    const url = new URL(request.url ?? "", "http://x");
    requests.push({ url, auth: request.headers.authorization ?? "" });
    // Sentry's project issue list takes only these stats periods and answers 400 to any other.
    if (!["", "24h", "14d"].includes(url.searchParams.get("statsPeriod") ?? "")) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ detail: "Invalid stats_period" }));
      return;
    }
    response.writeHead(answer.status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(answer.status === 200 ? answer.issues : { detail: "down" }));
  });
  return new Promise<void>((resolve) =>
    sentry.listen(0, "127.0.0.1", () => {
      sentryUrl = `http://127.0.0.1:${(sentry.address() as AddressInfo).port}`;
      resolve();
    }),
  );
}

function releaseCheck(version: string) {
  const cli = join(process.cwd(), "scripts/sdlc/sdlc.mjs");
  const child = spawn(process.execPath, [cli, "release-check", version], {
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

describe("sdlc release-check", () => {
  beforeEach(async () => {
    fixture = sdlcRepo();
    answer = { status: 200, issues: [] };
    requests = [];
    await startSentry();
  });
  afterEach(() => {
    sentry.close();
    fixture.cleanup();
  });

  it("passes a release with no new Sentry issue in bench, dogfood or QE runs", async () => {
    const result = await releaseCheck("0.6.0");
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("no new Sentry issues for visp-coder@0.6.0");
    const { url, auth } = requests[0] ?? { url: new URL("http://x"), auth: "" };
    expect(url.pathname).toBe("/api/0/projects/visplabs/visp-coder/issues/");
    expect(url.searchParams.get("query")).toBe("is:unresolved firstRelease:visp-coder@0.6.0");
    expect(url.searchParams.getAll("environment")).toEqual(["bench", "dogfood", "qe"]);
    expect(auth).toBe("Bearer read-token");
  });

  it("fails a release that brought new issues, and lists them", async () => {
    answer.issues = [
      { title: "TypeError in guard", permalink: "https://sentry/1" },
      { title: "EPIPE in capture", permalink: "https://sentry/2" },
    ];
    const result = await releaseCheck("0.6.0");
    expect(result.status).toBe(1);
    expect(result.output).toContain("2 new Sentry issues for visp-coder@0.6.0");
    expect(result.output).toContain("TypeError in guard https://sentry/1");
  });

  it("fails when Sentry cannot be asked, and refuses a version that is not one", async () => {
    answer.status = 500;
    expect((await releaseCheck("0.6.0")).output).toContain("cannot ask Sentry");
    expect((await releaseCheck("latest")).status).toBe(1);
  });
});
