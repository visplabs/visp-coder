import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, runJson } from "./support/cli.js";

describe("CLI input boundary", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "visp-cli-input-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("rejects an unknown init harness before writing project files", async () => {
    const result = await runJson(root, "init", "--harness", "not-a-harness");

    expect(result.exitCode).toBe(2);
    expect(result.envelope.error?.code).toBe("UNSUPPORTED");
    expect(await readdir(root)).toEqual([".git"]);
  });

  it("reports when initialization preserves an authored configuration", async () => {
    await writeFile(join(root, "visp.yml"), "# authored\nharness: generic\n", "utf8");

    const result = await runCli(root, "init", "--harness", "generic");

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Kept your existing visp.yml");
    expect(await readFile(join(root, "visp.yml"), "utf8")).toBe("# authored\nharness: generic\n");
  });

  it.each([
    ["go.mod", "module example.test/app\n"],
    ["Cargo.toml", '[package]\nname = "fixture"\nversion = "0.1.0"\n'],
  ])("warns when the %s preset has no structural parser", async (marker, content) => {
    await writeFile(join(root, marker), content, "utf8");

    const result = await runCli(root, "init", "--harness", "generic");

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "The repository index parses TypeScript, JavaScript and Python only",
    );
  });

  it.each([
    ["--harness", "not-a-harness"],
    ["--profile", "oversized"],
    ["--hooks", "git", "editor"],
  ])("rejects invalid install choices without changing configuration", async (...choice) => {
    expect((await runCli(root, "init", "--harness", "generic")).exitCode).toBe(0);
    const before = await readFile(join(root, "visp.yml"), "utf8");

    const result = await runJson(root, "install", ...choice);

    expect(result.exitCode).toBe(2);
    expect(result.envelope.error?.code).toBe("UNSUPPORTED");
    expect(await readFile(join(root, "visp.yml"), "utf8")).toBe(before);
  });

  it("rejects an unknown risk before creating a feature", async () => {
    expect((await runCli(root, "init", "--harness", "generic")).exitCode).toBe(0);

    const result = await runJson(root, "feature", "do work", "--risk", "extreme");

    expect(result.exitCode).toBe(2);
    expect(result.envelope.error?.code).toBe("UNSUPPORTED");
    expect(await readdir(join(root, ".visp"))).not.toContain("features");
  });

  it("rejects an unknown workflow mode before creating a feature", async () => {
    expect((await runCli(root, "init", "--harness", "generic")).exitCode).toBe(0);

    const result = await runJson(root, "feature", "do work", "--workflow", "magic");

    expect(result.exitCode).toBe(2);
    expect(result.envelope.error?.code).toBe("UNSUPPORTED");
    expect(await readdir(join(root, ".visp"))).not.toContain("features");
  });

  it.each([
    ["brief", "--feature", "../../outside"],
    ["work", "--task", "../../T001"],
    ["guard", "--task", "../../T001", "--path", "src/app.ts"],
  ])("reports malformed artifact identifiers consistently", async (...args) => {
    expect((await runCli(root, "init", "--harness", "generic")).exitCode).toBe(0);

    const result = await runJson(root, ...args);

    expect(result.exitCode).toBe(1);
    expect(result.envelope.error?.code).toBe("ARTIFACT_INVALID");
  });

  it.each([["usage", "import", "--source", "codex", "--file", "/tmp/rollout.jsonl"]])(
    "rejects an external file argument before changing project bytes",
    async (...args) => {
      expect((await runCli(root, "init", "--harness", "generic")).exitCode).toBe(0);
      const outside = join(root, "..", `visp-input-sentinel-${Date.now()}.txt`);
      await writeFile(outside, "unchanged\n", "utf8");
      const before = await projectBytes(root);
      try {
        const result = await runJson(root, ...args);

        expect(result.envelope.error?.code).toBe("ARTIFACT_INVALID");
        expect(await projectBytes(root)).toEqual(before);
        expect(await readFile(outside, "utf8")).toBe("unchanged\n");
      } finally {
        await rm(outside, { force: true });
      }
    },
  );
});

async function projectBytes(directory: string, relative = ""): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
    if (relative === "" && entry.name === ".git") continue;
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      Object.assign(snapshot, await projectBytes(directory, path));
      continue;
    }
    const metadata = await lstat(join(directory, path));
    snapshot[path] =
      `${metadata.mode & 0o777}:${(await readFile(join(directory, path))).toString("base64")}`;
  }
  return snapshot;
}
