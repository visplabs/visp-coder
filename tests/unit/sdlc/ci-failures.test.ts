import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeGh } from "./support/fake-gh.js";
import { type SdlcRepo, sdlcRepo } from "./support/sdlc-repo.js";

let fixture: SdlcRepo;
let gh = "";
const cli = join(process.cwd(), "scripts/sdlc/sdlc.mjs");

function ciFailures(...args: string[]) {
  return spawnSync(process.execPath, [cli, "ci-failures", ...args], {
    cwd: fixture.repo,
    encoding: "utf8",
    env: { ...process.env, SDLC_GH: gh, FAKE_DIR: fixture.repo },
  });
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
  beforeEach(() => {
    fixture = sdlcRepo();
    gh = installFakeGh(fixture.repo);
  });
  afterEach(() => fixture.cleanup());

  it("logs each failed check of a task's pull request to the mistake log and prints it", () => {
    setChecks([
      { name: "test (1)", bucket: "fail", link: "https://ci/1" },
      { name: "check", bucket: "fail", link: "https://ci/2" },
      { name: "lint", bucket: "pass", link: "https://ci/3" },
    ]);
    const result = ciFailures("109", "--task", "VISP-3");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("test (1) https://ci/1");
    expect(log()).toEqual([
      expect.objectContaining({ hook: "ci", reason: "VISP-3 CI check test (1) failed on PR #109" }),
      expect.objectContaining({ hook: "ci", reason: "VISP-3 CI check check failed on PR #109" }),
    ]);
  });

  it("logs nothing when no check failed", () => {
    setChecks([{ name: "lint", bucket: "pass", link: "https://ci/3" }]);
    expect(ciFailures("109", "--task", "VISP-3").stdout).toContain("no failed checks");
    expect(() => fixture.read(".sdlc/mistakes.jsonl")).toThrow();
  });
});
