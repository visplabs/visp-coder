import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeJira, startFakeJira } from "./support/fake-jira.js";
import { type SdlcRepo, sdlcRepo } from "./support/sdlc-repo.js";

let fixture: SdlcRepo;
let jira: FakeJira;
const cli = join(process.cwd(), "scripts/sdlc/sdlc.mjs");

// A stand-in codex whose `login status` exits with FAKE_LOGIN (0 means logged in).
const FAKE_CODEX = `#!/bin/sh
[ "$1 $2" = "login status" ] || exit 9
exit "\${FAKE_LOGIN:-0}"
`;

function preflight(env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [cli, "preflight"], {
    cwd: fixture.repo,
    encoding: "utf8",
    env: { ...process.env, ...jira.env, SDLC_CODEX: join(fixture.repo, "fake-codex"), ...env },
  });
}

describe("sdlc preflight", () => {
  beforeEach(async () => {
    fixture = sdlcRepo();
    jira = await startFakeJira(fixture.repo);
    writeFileSync(join(fixture.repo, "fake-codex"), FAKE_CODEX);
    chmodSync(join(fixture.repo, "fake-codex"), 0o755);
  });
  afterEach(() => {
    jira.stop();
    fixture.cleanup();
  });

  it("passes when the agent's Jira token and the reviewer's Codex login both work", () => {
    const result = preflight();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("jira ok");
    expect(result.stdout).toContain("codex ok");
  });

  it("fails and says which one is broken", () => {
    const rejected = preflight({ SDLC_SECRET_CMD: "printf %s rejected@example.com:x" });
    expect(rejected.status).toBe(1);
    expect(rejected.stdout).toContain("jira failed");
    const loggedOut = preflight({ FAKE_LOGIN: "1" });
    expect(loggedOut.status).toBe(1);
    expect(loggedOut.stdout).toContain("codex failed");
  });
});
