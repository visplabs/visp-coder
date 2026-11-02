import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const gate = join(process.cwd(), "scripts/sdlc/golden-gate.mjs");
let repo = "";

function git(...args: string[]) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

function commitFile(path: string, content: string, message: string) {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), content);
  git("add", path);
  git("commit", "-q", "-m", message);
}

function startRepo() {
  repo = mkdtempSync(join(tmpdir(), "sdlc-golden-"));
  git("init", "-q", "-b", "develop");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  commitFile("tests/golden/__snapshots__/loop/step.txt", "before\n", "test: base");
  git("switch", "-q", "-c", "feat/x");
}

function runGate() {
  return spawnSync(process.execPath, [gate, "develop"], { cwd: repo, encoding: "utf8" });
}

describe("golden gate", () => {
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("passes when no snapshot changed", () => {
    startRepo();
    commitFile("src/a.ts", "export {};\n", "refactor: a\n\nKind (a).");
    const result = runGate();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("kind (a)");
  });

  it("fails when a snapshot changed and no commit declares kind (b)", () => {
    startRepo();
    commitFile("tests/golden/__snapshots__/loop/step.txt", "after\n", "fix: wording");
    const result = runGate();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tests/golden/__snapshots__/loop/step.txt");
  });

  it("passes when a snapshot changed and a commit declares kind (b)", () => {
    startRepo();
    commitFile(
      "tests/golden/__snapshots__/loop/step.txt",
      "after\n",
      "feat: clearer reply\n\nKind (b): loop/step.txt changes its wording.",
    );
    const result = runGate();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("kind (b)");
  });
});
