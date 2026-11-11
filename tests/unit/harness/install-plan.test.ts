import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vispError } from "../../../src/core/errors.js";
import type { ProjectFileSystem } from "../../../src/core/fs.js";
import { err, ok } from "../../../src/core/result.js";
import { installHarness } from "../../../src/harness/install.js";
import { buildInstallPlan, planConfigBackup } from "../../../src/harness/install-plan.js";
import type { InstallOptions } from "../../../src/harness/install-types.js";
import { TestWorkspace } from "../support/workspace.js";

let workspace: TestWorkspace;
beforeEach(async () => {
  workspace = await TestWorkspace.create();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await workspace.destroy();
});

const handshake = { guardHandshake: async () => ok(undefined) };
const FAULTED = [
  "readTextIfExists",
  "metadata",
  "readMetadata",
  "readBytes",
  "listEntries",
] as const;

/** Fails the nth filesystem read made while planning; `undefined` only counts them. */
function failNthRead(files: ProjectFileSystem, nth: number | undefined) {
  const counter = { calls: 0 };
  for (const method of FAULTED) {
    const original = files[method].bind(files) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(files, method).mockImplementation((async (...args: unknown[]) => {
      counter.calls += 1;
      if (counter.calls === nth) return err(vispError("IO_ERROR", `injected read failure ${nth}`));
      return original(...args);
    }) as never);
  }
  return counter;
}

async function sweep(options: InstallOptions): Promise<void> {
  const state = await workspace.state();
  const profile = options.profile ?? "standard";
  const counter = failNthRead(state.files, undefined);
  const clean = await buildInstallPlan(state.paths, options, profile, state.files);
  if (!clean.ok) throw new Error(clean.error.message);
  const total = counter.calls;
  expect(total).toBeGreaterThan(10);
  for (let nth = 1; nth <= total; nth++) {
    vi.restoreAllMocks();
    failNthRead(state.files, nth);
    const result = await buildInstallPlan(state.paths, options, profile, state.files);
    expect(result.ok, `read ${nth} of ${total}`).toBe(false);
    expect(!result.ok && result.error.message, `read ${nth}`).toBe(`injected read failure ${nth}`);
  }
}

describe("install plan read failures", () => {
  it("stops at the first unreadable file when pruning a previous harness", async () => {
    const state = await workspace.state();
    const previous = await installHarness(
      state.paths,
      { harness: "claude-code", profile: "standard", hooks: ["claude", "git", "ci"], mcp: true },
      handshake,
    );
    if (!previous.ok) throw new Error(previous.error.message);
    await sweep({
      harness: "cursor",
      profile: "minimal",
      hooks: ["claude", "git", "ci"],
      mcp: true,
      prunePreviousHarness: true,
      configUpdates: { harness: "cursor", profile: "minimal" },
    });
  });
});

async function plan(options: InstallOptions) {
  const state = await workspace.state();
  const built = await buildInstallPlan(
    state.paths,
    options,
    options.profile ?? "minimal",
    state.files,
  );
  if (!built.ok) throw new Error(built.error.message);
  return built.value;
}

describe("Codex MCP registration the installer cannot merge", () => {
  const codex = { harness: "codex", profile: "minimal", hooks: [], mcp: true } as const;

  it.each([
    [
      "a customized table",
      '[mcp_servers.visp]\ncommand = "visp"\nargs = ["serve", "--mcp"]\n',
      "customized",
    ],
    ["an unreadable table", "[mcp_servers.visp]\ncommand = node\n", "customized"],
    ["an inline mcp_servers value", "mcp_servers = {}\n", "malformed"],
    ["an unterminated string", 'notes = """never closed\n', "malformed"],
  ])("leaves %s for the user and installs the rest", async (_name, text, status) => {
    await workspace.write(".codex/config.toml", text);
    const planned = await plan(codex);
    expect(planned.mcp).toBe(status);
    expect(planned.mcpConfigFile).toBe(".codex/config.toml");
    expect(planned.mutations.map((mutation) => mutation.path)).not.toContain(".codex/config.toml");
    const step = planned.manualSteps.find((line) => line.startsWith(".codex/config.toml"));
    expect(step).toContain("Other installation assets will still be installed.");
    if (status === "malformed") expect(step).toContain("add [mcp_servers.visp] manually");
    else expect(step).not.toContain("could not be merged");
  });

  it("creates the file and records it so uninstall may delete it", async () => {
    const planned = await plan(codex);
    expect(planned.mcp).toBe("added");
    expect(Object.keys(planned.created)).toEqual([".codex/config.toml"]);
    // A file the project already had is only edited back, never recorded as created.
    await workspace.write(".codex/config.toml", 'model = "gpt-6"\n');
    expect((await plan(codex)).created).toEqual({});
  });
});

describe("JSON host MCP registration the installer cannot merge", () => {
  const cursor = { harness: "cursor", profile: "minimal", hooks: [], mcp: true } as const;

  it("refuses unparseable configuration even with --force", async () => {
    await workspace.write(".cursor/mcp.json", "{not json");
    const state = await workspace.state();
    const result = await buildInstallPlan(
      state.paths,
      { ...cursor, force: true },
      "minimal",
      state.files,
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "ARTIFACT_INVALID",
        message: expect.stringContaining("is not a safely mergeable MCP configuration"),
        recovery: expect.stringContaining("--force never replaces unparseable configuration"),
      },
    });
  });

  it("refuses a customized VISP registration until forced, then backs the file up", async () => {
    const custom =
      '{"mcpServers":{"visp":{"command":"visp","args":["serve","--mcp","--extra"]}}}\n';
    await workspace.write(".cursor/mcp.json", custom);
    const state = await workspace.state();
    const refused = await buildInstallPlan(state.paths, cursor, "minimal", state.files);
    expect(refused).toMatchObject({
      ok: false,
      error: {
        message: expect.stringContaining("contains a customized VISP registration"),
        recovery: expect.stringContaining("rerun visp install --force"),
      },
    });
    const forced = await plan({ ...cursor, force: true });
    const backup = forced.mutations.find((mutation) => mutation.path.includes("/backups/"));
    expect(backup).toMatchObject({ kind: "write", content: custom });
  });
});

describe("moving from the old Claude MCP location to Cursor", () => {
  it("removes the old VISP entry from .mcp.json after backing it up", async () => {
    const state = await workspace.state();
    const claude = await installHarness(
      state.paths,
      { harness: "claude-code", profile: "minimal", hooks: [], mcp: true },
      handshake,
    );
    if (!claude.ok) throw new Error(claude.error.message);
    const old = await readFile(join(workspace.root, ".mcp.json"), "utf8");
    const planned = await plan({ harness: "cursor", profile: "minimal", hooks: [], mcp: true });
    expect(planned.assets).toContainEqual({
      path: ".mcp.json (old VISP registration)",
      status: "removed",
    });
    expect(
      planned.mutations.find((mutation) => mutation.path.includes("/backups/.mcp.json.")),
    ).toMatchObject({ content: old });
    expect(planned.mutations.find((mutation) => mutation.path === ".mcp.json")).toMatchObject({
      kind: "write",
    });
  });

  it("leaves .mcp.json alone when it holds no VISP entry", async () => {
    await workspace.write(".mcp.json", '{"mcpServers":{"other":{"command":"x"}}}\n');
    const planned = await plan({ harness: "cursor", profile: "minimal", hooks: [], mcp: true });
    expect(planned.mutations.map((mutation) => mutation.path)).not.toContain(".mcp.json");
  });
});

describe("assets left by a previous harness", () => {
  async function installClaude() {
    const state = await workspace.state();
    const claude = await installHarness(
      state.paths,
      { harness: "claude-code", profile: "minimal", hooks: ["claude"], mcp: true },
      handshake,
    );
    if (!claude.ok) throw new Error(claude.error.message);
    return claude.value.assets.map((asset) => asset.path);
  }
  const cursor = { harness: "cursor", profile: "minimal", hooks: ["claude"], mcp: true } as const;

  it("names fingerprint-matched leftovers and how to prune them", async () => {
    await installClaude();
    const planned = await plan(cursor);
    const step = planned.manualSteps.find((line) => line.startsWith("Fingerprint-matched assets"));
    expect(step).toContain("Use --prune-previous-harness to remove only VISP-owned copies.");
    expect(planned.removals).toEqual([]);
  });

  it("leaves an edited leftover for the user, also when pruning the rest", async () => {
    const written = await installClaude();
    const owned = written.find((path) => path.startsWith(".claude/") && path.endsWith(".md"));
    if (!owned) throw new Error("no markdown asset installed");
    await writeFile(join(workspace.root, owned), "edited by the user\n");
    const edited = await plan(cursor);
    expect(edited.manualSteps.join("\n")).toContain(
      "Edited assets from another harness were left alone",
    );
    const pruned = await plan({ ...cursor, prunePreviousHarness: true });
    expect(pruned.removals).not.toContain(owned);
    expect(pruned.removals.length).toBeGreaterThan(0);
  });

  it("leaves a registration that changed between inspection and planning", async () => {
    await installClaude();
    const state = await workspace.state();
    const original = state.files.readTextIfExists.bind(state.files);
    vi.spyOn(state.files, "readTextIfExists").mockImplementation(async (path) => {
      const read = await original(path);
      return read.ok && (path === ".mcp.json" || path === ".claude/settings.json")
        ? ok("{}\n")
        : read;
    });
    const built = await buildInstallPlan(
      state.paths,
      { ...cursor, hooks: [], prunePreviousHarness: true },
      "minimal",
      state.files,
    );
    if (!built.ok) throw new Error(built.error.message);
    expect(built.value.manualSteps.join("\n")).toContain(
      "changed during installation and was left alone",
    );
  });

  it("removes an activation block, or keeps an edited one", async () => {
    const state = await workspace.state();
    const codex = await installHarness(
      state.paths,
      { harness: "codex", profile: "minimal", hooks: [], mcp: false },
      handshake,
    );
    if (!codex.ok) throw new Error(codex.error.message);
    const next = { harness: "claude-code", profile: "minimal", hooks: [], mcp: false } as const;
    const kept = await plan(next);
    expect(kept.manualSteps.join("\n")).toContain("AGENTS.md still activates a previous harness");
    const pruned = await plan({ ...next, prunePreviousHarness: true });
    expect(pruned.assets).toContainEqual({ path: "AGENTS.md (VISP block)", status: "removed" });
    await writeFile(
      join(workspace.root, "AGENTS.md"),
      `${await readFile(join(workspace.root, "AGENTS.md"), "utf8")}\nmine\n`,
    );
    const text = await readFile(join(workspace.root, "AGENTS.md"), "utf8");
    await writeFile(join(workspace.root, "AGENTS.md"), text.replace(/visp/i, "visp edited"));
    const edited = await plan(next);
    expect(edited.manualSteps.join("\n")).toContain(
      "AGENTS.md contains an edited VISP block and was left alone.",
    );
  });
});

describe("executable drift", () => {
  it("rewrites a hook script that lost its executable bit", async () => {
    const state = await workspace.state();
    const options = {
      harness: "claude-code",
      profile: "minimal",
      hooks: ["claude"],
      mcp: false,
    } as const;
    const first = await installHarness(state.paths, options, handshake);
    if (!first.ok) throw new Error(first.error.message);
    const script = first.value.assets
      .map((asset) => asset.path)
      .find((path) => path.endsWith(".sh") || path.includes("hooks/"));
    if (!script) throw new Error("no hook script installed");
    await chmod(join(workspace.root, script), 0o644);
    const planned = await plan(options);
    expect(planned.assets).toContainEqual({ path: script, status: "written" });
    expect(planned.mutations.find((mutation) => mutation.path === script)).toMatchObject({
      mode: 0o755,
    });
  });
});

describe("host configuration backups", () => {
  async function backup(text: string | undefined) {
    const state = await workspace.state();
    const mutations: Parameters<typeof planConfigBackup>[3]["mutations"] = [];
    const result = await planConfigBackup(state.files, "host/mcp.json", text, { mutations });
    if (!result.ok) throw new Error(result.error.message);
    return mutations;
  }
  const dir = ".visp/state/backups/host";

  it.each([undefined, "", "  \n"])("keeps nothing for %j", async (text) => {
    expect(await backup(text)).toEqual([]);
  });

  it("numbers backups after the newest, ignores strangers, and trims to five", async () => {
    const first = await backup("one");
    expect(first).toHaveLength(1);
    const firstPath = first[0]?.path ?? "";
    expect(firstPath).toMatch(
      /^\.visp\/state\/backups\/host\/mcp\.json\.0000000000001-[0-9a-f]{12}$/,
    );
    const fingerprint = firstPath.slice(-12);
    await mkdir(join(workspace.root, dir, "mcp.json.subdir"), { recursive: true });
    await writeFile(join(workspace.root, dir, "other.json.0000000000099-aaaaaaaaaaaa"), "x");
    await writeFile(join(workspace.root, dir, "mcp.json.notanumber"), "x");
    for (const n of [2, 3, 4, 5, 6]) {
      await writeFile(
        join(workspace.root, dir, `mcp.json.${String(n).padStart(13, "0")}-${"b".repeat(11)}${n}`),
        "x",
      );
    }
    // The same text again changes nothing.
    await writeFile(join(workspace.root, firstPath), "one");
    expect(await backup("one")).toEqual([]);
    expect(fingerprint).toHaveLength(12);

    const next = await backup("two");
    const removed = next
      .filter((mutation) => mutation.kind === "remove")
      .map((mutation) => mutation.path.split("/").pop());
    expect(removed).toEqual([
      expect.stringMatching(/^mcp\.json\.0000000000001-/),
      "mcp.json.0000000000002-bbbbbbbbbbb2",
      "mcp.json.0000000000003-bbbbbbbbbbb3",
    ]);
    const written = next.find((mutation) => mutation.kind === "write");
    expect(written?.path).toMatch(/mcp\.json\.0000000000007-[0-9a-f]{12}$/);
  });
});

describe("a Git hooks path outside the worktree", () => {
  it("names the configured value and what each way out costs", async () => {
    workspace.git("config", "core.hooksPath", "/opt/shared-hooks");
    const state = await workspace.state();
    const result = await buildInstallPlan(
      state.paths,
      { harness: "claude-code", profile: "minimal", hooks: ["claude", "git"], mcp: false },
      "minimal",
      state.files,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("STAGE_BLOCKED");
    expect(result.error.message).toContain("core.hooksPath is /opt/shared-hooks");
    expect(result.error.recovery).toContain("--no-hooks");
    expect(result.error.recovery).toContain("cannot authorize coding");
    expect(result.error.recovery).toContain("core.hooksPath .visp/hooks/git");
  });
});
