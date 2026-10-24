import { chmod, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HARNESSES, type Harness } from "../../../src/core/constants.js";
import { ok } from "../../../src/core/result.js";
import { checkHarnessAssets } from "../../../src/doctor/installation.js";
import { defaultHooks, type HookKind, installHarness } from "../../../src/harness/install.js";
import { readInstallState } from "../../../src/harness/install-state.js";
import { mcpConfigFile } from "../../../src/harness/mcp-registration.js";
import { uninstallHarness } from "../../../src/harness/uninstall.js";
import { TestWorkspace } from "../support/workspace.js";

let workspace: TestWorkspace;
beforeEach(async () => {
  workspace = await TestWorkspace.create();
});
afterEach(async () => {
  await workspace.destroy();
});

const guardHandshake = async () => ok(undefined);

async function install(harness: Harness, extra: { hooks?: HookKind[]; force?: boolean } = {}) {
  const state = await workspace.state();
  const installed = await installHarness(
    state.paths,
    {
      harness,
      profile: "standard",
      hooks: extra.hooks ?? [...defaultHooks(harness), "ci"],
      mcp: harness !== "generic",
      ...(extra.force ? { force: true } : {}),
    },
    { guardHandshake },
  );
  if (!installed.ok) throw new Error(installed.error.message);
}

async function uninstall(harness: Harness, extra: { force?: boolean; dryRun?: boolean } = {}) {
  const state = await workspace.state();
  return uninstallHarness(state.paths, { harness, ...extra });
}

async function walk(root: string, directory = "", skip: readonly string[] = []) {
  const found: Record<string, string> = {};
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
    if (skip.includes(path)) continue;
    if (entry.isDirectory()) Object.assign(found, await walk(root, path, skip));
    else found[path] = await readFile(join(root, path), "utf8");
  }
  return found;
}

/** Everything a user could have tracked: the tree without Git's and VISP's own directories. */
const tracked = (root: string) => walk(root, "", [".git", ".visp"]);

const MCP_SEED: Record<Harness, string | undefined> = {
  "claude-code": '// project servers\n{\n  "mcpServers": { "github": { "url": "https://x" } }\n}\n',
  codex: '# mine\nmodel = "gpt"\n',
  cursor: '{\n  // mine\n  "mcpServers": { "github": { "url": "https://x" } }\n}\n',
  copilot: '{\n  "servers": { "github": { "url": "https://x" } } // keep\n}\n',
  opencode: '{\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {}\n}\n',
  generic: undefined,
};

describe("visp uninstall", () => {
  it.each(HARNESSES)("leaves the project as it was before install: %s", async (harness) => {
    await workspace.write("AGENTS.md", "# Project rules\n\nBe kind.\n");
    const seed = MCP_SEED[harness];
    if (seed !== undefined) await workspace.write(mcpConfigFile(harness), seed);
    if (harness === "claude-code") {
      await workspace.write(
        ".claude/settings.json",
        `${JSON.stringify(
          {
            permissions: { allow: ["Bash(ls)"] },
            hooks: {
              PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo" }] }],
            },
          },
          null,
          2,
        )}\n`,
      );
    }
    const before = await tracked(workspace.root);

    await install(harness);
    expect(await tracked(workspace.root)).not.toEqual(before);

    const outcome = await uninstall(harness);
    expect(outcome.ok).toBe(true);
    expect(await tracked(workspace.root)).toEqual(before);
    await expect(stat(join(workspace.root, ".git/hooks/pre-commit"))).rejects.toThrow();
    // History and settings stay.
    await expect(stat(join(workspace.root, "visp.yml"))).resolves.toBeDefined();
    await expect(stat(join(workspace.root, ".visp"))).resolves.toBeDefined();
  });

  it("does nothing on a dry run, and says what it would do", async () => {
    await install("claude-code");
    const before = await walk(workspace.root, "", [".git"]);
    const hook = await readFile(join(workspace.root, ".git/hooks/pre-commit"), "utf8");

    const preview = await uninstall("claude-code", { dryRun: true });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.dryRun).toBe(true);
    const paths = preview.value.changes.map((change) => change.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "AGENTS.visp.md",
        "CLAUDE.md",
        ".claude/settings.json",
        ".mcp.json",
        ".git/hooks/pre-commit",
        ".github/workflows/visp.yml",
      ]),
    );
    expect(await walk(workspace.root, "", [".git"])).toEqual(before);
    expect(await readFile(join(workspace.root, ".git/hooks/pre-commit"), "utf8")).toBe(hook);
  });

  it("keeps a file the user edited, and removes it with --force", async () => {
    await install("codex");
    await workspace.write("AGENTS.visp.md", "# my own rules\n");

    const kept = await uninstall("codex");
    expect(kept.ok).toBe(true);
    if (!kept.ok) return;
    expect(kept.value.kept.map((entry) => entry.path)).toContain("AGENTS.visp.md");
    expect(await readFile(join(workspace.root, "AGENTS.visp.md"), "utf8")).toBe("# my own rules\n");
    await expect(stat(join(workspace.root, ".codex/hooks.json"))).rejects.toThrow();

    const forced = await uninstall("codex", { force: true });
    expect(forced.ok).toBe(true);
    await expect(stat(join(workspace.root, "AGENTS.visp.md"))).rejects.toThrow();
  });

  it("removes a command guide an earlier build left at the project root", async () => {
    await install("claude-code");
    const guide = await readFile(join(workspace.root, ".visp/VISP.commands.md"), "utf8");
    await workspace.write("VISP.commands.md", guide);

    const removed = await uninstall("claude-code");
    expect(removed.ok).toBe(true);
    await expect(stat(join(workspace.root, "VISP.commands.md"))).rejects.toThrow();
    await expect(stat(join(workspace.root, ".visp/VISP.commands.md"))).rejects.toThrow();
  });

  it("keeps an edited CI workflow and a customized MCP entry", async () => {
    await install("cursor");
    await workspace.write(".github/workflows/visp.yml", "name: mine\n");
    const config = JSON.parse(await readFile(join(workspace.root, ".cursor/mcp.json"), "utf8"));
    config.mcpServers.visp = { command: "other" };
    await workspace.write(".cursor/mcp.json", JSON.stringify(config));

    const outcome = await uninstall("cursor");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.kept.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([".github/workflows/visp.yml", ".cursor/mcp.json"]),
    );
    expect(await readFile(join(workspace.root, ".github/workflows/visp.yml"), "utf8")).toBe(
      "name: mine\n",
    );
    expect(await readFile(join(workspace.root, ".cursor/mcp.json"), "utf8")).toBe(
      JSON.stringify(config),
    );
  });

  it("edits only VISP's keys in shared configuration, keeping comments and layout", async () => {
    await install("claude-code");
    const settingsPath = join(workspace.root, ".claude/settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    const own = { matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] };
    settings.hooks.PreToolUse.push(own);
    await writeFile(
      settingsPath,
      `{\n    "permissions": {"allow":["Bash(ls)"]},\n    "env": { "A": "1" },\n    "hooks": ${JSON.stringify(settings.hooks)}\n}\n`,
    );
    const mcpPath = join(workspace.root, ".mcp.json");
    const mcp = JSON.parse(await readFile(mcpPath, "utf8"));
    await writeFile(
      mcpPath,
      `// project servers\n{\n\t"mcpServers": {\n\t\t"github": {"url":"x"}, // mine\n\t\t"visp": ${JSON.stringify(mcp.mcpServers.visp)}\n\t}\n}\n`,
    );

    const outcome = await uninstall("claude-code");
    expect(outcome.ok).toBe(true);

    const after = await readFile(settingsPath, "utf8");
    expect(after).toContain(
      '{\n    "permissions": {"allow":["Bash(ls)"]},\n    "env": { "A": "1" },\n',
    );
    expect(JSON.parse(after).hooks).toEqual({ PreToolUse: [own] });
    expect(await readFile(mcpPath, "utf8")).toBe(
      '// project servers\n{\n\t"mcpServers": {\n\t\t"github": {"url":"x"} // mine\n\t}\n}\n',
    );
    // The text VISP changed is kept outside the repository's tracked files.
    expect(Object.keys(await walk(workspace.root, ".visp/state/backups"))).not.toHaveLength(0);
  });

  it("restores a pre-commit hook that install chained", async () => {
    const hook = join(workspace.root, ".git/hooks/pre-commit");
    await writeFile(hook, "#!/bin/sh\necho theirs\n");
    await chmod(hook, 0o755);
    await install("generic", { hooks: ["git"], force: true });
    expect(await readFile(`${hook}.local`, "utf8")).toContain("theirs");

    const outcome = await uninstall("generic");
    expect(outcome.ok).toBe(true);
    expect(await readFile(hook, "utf8")).toBe("#!/bin/sh\necho theirs\n");
    expect((await stat(hook)).mode & 0o111).not.toBe(0);
    await expect(stat(`${hook}.local`)).rejects.toThrow();
  });

  it("leaves a pre-commit hook that is not VISP's", async () => {
    await install("generic", { hooks: ["git"] });
    const hook = join(workspace.root, ".git/hooks/pre-commit");
    await writeFile(hook, "#!/bin/sh\necho mine\n");

    const outcome = await uninstall("generic");
    expect(outcome.ok).toBe(true);
    expect(await readFile(hook, "utf8")).toBe("#!/bin/sh\necho mine\n");
  });

  it("refuses while a slice is authorized, even with --force", async () => {
    await install("codex", { hooks: ["git"] });
    await workspace.write(".visp/state/implement-allowed/T001.json", "{}\n");

    for (const force of [false, true]) {
      const refused = await uninstall("codex", { force });
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.error.message).toMatch(/authorized/);
        expect(refused.error.recovery).toMatch(/visp done/);
      }
    }
    await expect(stat(join(workspace.root, "AGENTS.visp.md"))).resolves.toBeDefined();
    await expect(stat(join(workspace.root, ".git/hooks/pre-commit"))).resolves.toBeDefined();

    await rm(join(workspace.root, ".visp/state/implement-allowed/T001.json"));
    expect((await uninstall("codex")).ok).toBe(true);
  });

  it("refuses to uninstall a host other than the installed one", async () => {
    await install("claude-code");
    const before = await walk(workspace.root, "", [".git"]);
    const refused = await uninstall("codex");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.message).toContain("installed for claude-code");
      expect(refused.error.recovery).toContain("--harness claude-code");
    }
    expect(await walk(workspace.root, "", [".git"])).toEqual(before);
  });

  it("keeps an edited VISP pre-commit hook, and removes it with --force after saving it", async () => {
    await install("generic", { hooks: ["git"] });
    const hook = join(workspace.root, ".git/hooks/pre-commit");
    const edited = `${await readFile(hook, "utf8")}\necho extra\n`;
    await writeFile(hook, edited);

    const kept = await uninstall("generic");
    expect(kept.ok && kept.value.kept.map((entry) => entry.path)).toContain(
      ".git/hooks/pre-commit",
    );
    expect(await readFile(hook, "utf8")).toBe(edited);

    expect((await uninstall("generic", { force: true })).ok).toBe(true);
    await expect(stat(hook)).rejects.toThrow();
    const saved = await walk(workspace.root, ".visp/state/backups/.git/hooks");
    expect(Object.values(saved)).toEqual([edited]);
  });

  it("keeps a hook entry the user customized, and only removes the generated ones", async () => {
    await install("claude-code");
    const path = join(workspace.root, ".claude/settings.json");
    const settings = JSON.parse(await readFile(path, "utf8"));
    const generated = settings.hooks.Stop[0];
    const custom = {
      hooks: [
        { type: "command", command: `echo before; ${generated.hooks[0].command}`, timeout: 5 },
      ],
    };
    settings.hooks.Stop = [custom, generated];
    await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`);

    const outcome = await uninstall("claude-code");
    expect(outcome.ok && outcome.value.kept.map((entry) => entry.path)).toContain(
      ".claude/settings.json",
    );
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ hooks: { Stop: [custom] } });
  });

  it("keeps a configuration file the project already had, even when it is left empty", async () => {
    await workspace.write(".mcp.json", "{}\n");
    await install("claude-code", { hooks: [] });
    expect((await uninstall("claude-code")).ok).toBe(true);
    expect(JSON.parse(await readFile(join(workspace.root, ".mcp.json"), "utf8"))).toEqual({
      mcpServers: {},
    });
  });

  it("restores CRLF instruction files and TOML exactly", async () => {
    await workspace.write("AGENTS.md", "# Rules\r\n\r\nBe kind.\r\n");
    await workspace.write(".codex/config.toml", 'model = "x"\n\n\n\n[a]\nb = 1\n');
    const before = await tracked(workspace.root);
    await install("codex", { hooks: [] });
    expect((await uninstall("codex")).ok).toBe(true);
    expect(await tracked(workspace.root)).toEqual(before);
  });

  it("makes doctor report the harness as not installed, and a second run is a no-op", async () => {
    await install("opencode");
    const state = await workspace.state();
    expect((await readInstallState(state.paths, state.files)).ok).toBe(true);

    expect((await uninstall("opencode")).ok).toBe(true);

    const after = await workspace.state();
    const recorded = await readInstallState(after.paths, after.files);
    expect(recorded.ok && recorded.value).toBeUndefined();
    const check = await checkHarnessAssets({
      ...after,
      config: { ...after.config, harness: "opencode" },
    });
    expect(check.status).toBe("warn");
    expect(check.detail).toMatch(/Missing/);

    const again = await uninstall("opencode");
    expect(again.ok && again.value.changes).toEqual([]);
  });

  it("applies nothing when the transaction fails", async () => {
    await install("copilot");
    const before = await walk(workspace.root, "", [".git"]);
    const state = await workspace.state();
    const failed = await uninstallHarness(
      state.paths,
      { harness: "copilot" },
      {
        applyTransaction: async () => ({
          ok: false,
          error: { code: "IO_ERROR", message: "disk full" },
        }),
      },
    );
    expect(failed.ok).toBe(false);
    expect(await walk(workspace.root, "", [".git"])).toEqual(before);
  });
});
