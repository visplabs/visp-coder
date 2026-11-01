import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DERIVED_STATE_PATHS } from "../../../../src/core/constants.js";
import { vispError } from "../../../../src/core/errors.js";
import { err, ok } from "../../../../src/core/result.js";
import { withStateLock } from "../../../../src/core/state-lock.js";
import { reviewerModel } from "../../../../src/workflow/product/reviewer-model.js";
import { runInit } from "../../../../src/workflow/stages/init.js";
import { loadWorkspace } from "../../../../src/workflow/state.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runInit reviewer launch", () => {
  // Recall of earlier decisions needs a reviewer VISP launches (batch B3: 94% against 41%).
  it.each([
    ["claude-code", "claude-exec"],
    ["codex", "codex-exec"],
  ] as const)(
    "gives a fresh %s project a launched reviewer, so recall is available",
    async (harness, launch) => {
      const root = await fixture();

      const result = await runInit({ root, harness });

      expect(result.ok).toBe(true);
      const workspace = await loadWorkspace(root);
      if (!workspace.ok) throw new Error(workspace.error.message);
      expect(workspace.value.config.critic?.launch).toBe(launch);
      expect(workspace.value.config.memory.recall).toBe(true);
      expect(await reviewerModel(workspace.value)).toMatchObject({ launch });
    },
  );

  it.each(["cursor", "copilot", "opencode", "generic"] as const)(
    "leaves a fresh %s project without a launched reviewer",
    async (harness) => {
      const root = await fixture();

      expect((await runInit({ root, harness })).ok).toBe(true);
      const workspace = await loadWorkspace(root);
      if (!workspace.ok) throw new Error(workspace.error.message);

      expect(await reviewerModel(workspace.value)).toBeUndefined();
    },
  );
});

describe("runInit trust boundary", () => {
  it("skips unavailable npm tools instead of persisting a failing validation command", async () => {
    const root = await fixture();
    await write(
      root,
      "package.json",
      JSON.stringify({ scripts: { test: "visp-missing-test-tool" } }),
    );

    const result = await runInit({ root, harness: "generic" });

    expect(result.ok).toBe(true);
    expect(await readFile(join(root, "visp.yml"), "utf8")).toContain("validationCommands: []");
    expect(result.ok && result.value.skippedValidationCommands).toEqual([
      { command: "npm run test", reason: "test: executable visp-missing-test-tool was not found" },
    ]);
  });

  it("writes the Python preset for a tracked Python majority with JavaScript tooling", async () => {
    const root = await fixture();
    await write(root, "app.py", "");
    await write(root, "models.py", "");
    await write(root, "lint.js", "");
    execFileSync("git", ["add", "."], { cwd: root });

    const result = await runInit({ root, harness: "generic" });

    expect(result.ok && result.value.preset).toBe("python");
    expect(await readFile(join(root, "visp.yml"), "utf8")).toContain("preset: python");
  });

  it("initializes a root containing only empty coordination ancestry", async () => {
    const root = await fixture();
    expect(await withStateLock(root, async () => ok(undefined))).toEqual(ok(undefined));

    const result = await runInit({ root, harness: "generic" });

    expect(result.ok).toBe(true);
    const project = JSON.parse(await readFile(join(root, ".visp/project.json"), "utf8"));
    expect(project.kind).toBe("project");
  });

  it.each([".visp/unrelated.json", ".visp/state/unrelated.json", ".visp/other/.keep"])(
    "refuses unrelated state at %s without changing it",
    async (path) => {
      const root = await fixture();
      await write(root, path, "preserved\n");

      const result = await runInit({ root, harness: "generic" });

      expect(!result.ok && result.error.code).toBe("ALREADY_INITIALIZED");
      expect(await readFile(join(root, path), "utf8")).toBe("preserved\n");
      await expect(readFile(join(root, ".visp/project.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("refuses a directory that is not a Git repository without writing state", async () => {
    const root = await fixture(false);

    const result = await runInit({ root, harness: "generic" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("STAGE_BLOCKED");
    await expect(readFile(join(root, ".visp/project.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses a repository-shaped directory that Git cannot use", async () => {
    const root = await fixture(false);
    await mkdir(join(root, ".git"));

    const result = await runInit({ root, harness: "generic" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("STAGE_BLOCKED");
      expect(result.error.message).toContain(".git path exists");
    }
  });

  it("refuses a second initialization unless force is explicit", async () => {
    const root = await fixture();
    expect((await runInit({ root, harness: "generic" })).ok).toBe(true);

    const repeated = await runInit({ root, harness: "generic" });

    expect(repeated.ok).toBe(false);
    if (!repeated.ok) expect(repeated.error.code).toBe("ALREADY_INITIALIZED");
  });

  it("preserves an existing config and a legacy whole-state ignore", async () => {
    const root = await fixture();
    await write(root, "visp.yml", "# authored\nharness: codex\n");
    await write(root, ".gitignore", ".visp/\n");

    const result = await runInit({ root, harness: "codex" });

    expect(result.ok && result.value.createdConfig).toBe(false);
    expect(await readFile(join(root, "visp.yml"), "utf8")).toBe("# authored\nharness: codex\n");
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(".visp/\n");
  });

  it("does not duplicate an already-complete derived-state ignore", async () => {
    const root = await fixture();
    const ignored = `${DERIVED_STATE_PATHS.join("\n")}\n`;
    await write(root, ".gitignore", ignored);

    const result = await runInit({ root, harness: "generic" });

    expect(result.ok).toBe(true);
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(ignored);
  });

  it("separates derived ignores from an authored final line", async () => {
    const root = await fixture();
    await write(root, ".gitignore", "build-cache/");

    const result = await runInit({ root, harness: "generic" });

    expect(result.ok).toBe(true);
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(
      `build-cache/\n${DERIVED_STATE_PATHS.join("\n")}\n`,
    );
  });

  it("returns an injected transaction failure without claiming initialization", async () => {
    const root = await fixture();

    const result = await runInit(
      { root, harness: "generic" },
      {
        applyTransaction: async () => err(vispError("IO_ERROR", "injected apply failure")),
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("injected apply failure");
  });

  it.each([
    { blocked: ".visp/project.json", force: true },
    { blocked: ".visp/status.json", force: true },
    { blocked: "visp.yml", force: false },
    { blocked: ".gitignore", force: false },
  ])("rejects a symlinked planning target at $blocked", async ({ blocked, force }) => {
    const root = await fixture();
    const outside = join(root, "outside.txt");
    await writeFile(outside, "outside", "utf8");
    await mkdir(dirname(join(root, blocked)), { recursive: true });
    await symlink(outside, join(root, blocked));

    const result = await runInit({ root, harness: "generic", force });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("IO_ERROR");
    expect(await readFile(outside, "utf8")).toBe("outside");
  });

  it("requires an explicit harness before reading or mutating project state", async () => {
    const root = await fixture();

    const result = await runInit({ root });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNSUPPORTED");
      expect(result.error.recovery).toContain("--harness");
    }
    await expect(readFile(join(root, ".visp/project.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps generic available when it is selected explicitly", async () => {
    const root = await fixture();

    const result = await runInit({ root, harness: "generic" });

    expect(result.ok && result.value.harness).toBe("generic");
    await expect(readFile(join(root, "visp.yml"), "utf8")).resolves.toContain("harness: generic");
  });
});

async function fixture(git = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "visp-init-boundary-"));
  roots.push(root);
  await write(root, "package.json", '{"name":"init-boundary"}\n');
  if (git) execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  return root;
}

async function write(root: string, path: string, content: string): Promise<void> {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
}
