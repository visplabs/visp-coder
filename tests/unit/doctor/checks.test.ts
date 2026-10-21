import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { applyFileTransaction } from "../../../src/core/file-transaction.js";
import { err, ok } from "../../../src/core/result.js";
import { markOwner } from "../../../src/core/stale-temp.js";
import { runtimeIdentity } from "../../../src/core/version.js";
import { type Check, type DoctorRuntime, runChecks } from "../../../src/doctor/checks.js";
import { applyFixes } from "../../../src/doctor/fix.js";
import { indexRepository } from "../../../src/graph/index.js";
import { ACTIVATION_END } from "../../../src/harness/activation.js";
import { CLAUDE_PRE_TOOL_USE_HOOK } from "../../../src/harness/claude-settings.js";
import {
  assetFingerprint,
  CLAUDE_SETTINGS_REGISTRATION,
  inspectForeignHarnessAssets,
  installHarness,
} from "../../../src/harness/install.js";
import { readInstallState } from "../../../src/harness/install-state.js";
import { CODEX_CONFIG_FILE } from "../../../src/harness/mcp-registration.js";
import { planFor } from "../../../src/harness/targets.js";
import { upsert } from "../../../src/skills/store.js";
import { now } from "../../../src/workflow/artifacts/common.js";
import { updateProductBrief } from "../../../src/workflow/product/index.js";
import { legacyStore } from "../support/legacy-store.js";
import { productWorkspace } from "../support/product-workspace.js";
import { TestWorkspace, task } from "../support/workspace.js";
import { registerPreToolUseHook } from "../support/writers.js";

/**
 * Doctor is the report a project trusts when deciding whether it is protected,
 * so the cases that matter are the ones where it would be tempting to say yes.
 */

let workspace: TestWorkspace;
const healthyGuard = async () => ok(undefined);
const healthyDoctorRuntime: DoctorRuntime = { guardHandshake: healthyGuard };

beforeEach(async () => {
  workspace = await TestWorkspace.create({ "src/app.ts": "export const a = 1;\n" });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await workspace.destroy();
});

it("warns when an active browser journey has no available browser", async () => {
  await workspace.destroy();
  const product = await productWorkspace();
  workspace = product.workspace;
  const revised = await updateProductBrief(await workspace.state(), {
    brief: {
      ...product.brief,
      checks: [
        ...product.brief.checks,
        {
          id: "C002",
          outcomes: ["O001"],
          command: {
            kind: "browser-journey" as const,
            journey: { url: "http://localhost/", actions: [] },
          },
        },
      ],
    },
    reason: "Check the browser journey",
  });
  expect(revised.ok).toBe(true);
  vi.stubEnv("CHROME_BIN", "/missing/chrome-for-doctor");
  expect(await check("browser")).toMatchObject({
    status: "warn",
    recovery: expect.stringContaining("CHROME_BIN"),
  });
});

it("lists only the other host's files VISP leaves out of the product", async () => {
  await workspace.destroy();
  const product = await productWorkspace();
  workspace = product.workspace;
  await setConfigScalar((await workspace.state()).paths, "harness", "claude-code");
  workspace.commit("configure Claude Code");
  const revised = await updateProductBrief(await workspace.state(), {
    brief: {
      ...product.brief,
      slices: product.brief.slices.map((slice) => ({
        ...slice,
        scope: { ...slice.scope, allowed: [...slice.scope.allowed, "AGENTS.md"] },
      })),
    },
    reason: "The request asks for an AGENTS.md",
  });
  expect(revised.ok).toBe(true);
  await workspace.write("AGENTS.md", "# Requested\n");
  await workspace.write("GEMINI.md", "# Imported\n");
  // Committing them would make them product and deleting them removes another app's files.
  expect(await check("other host files")).toEqual({
    name: "other host files",
    status: "ok",
    detail: "VISP ignores these as product: GEMINI.md; no action needed",
  });
});

it("lists another host's files under the light path's catch-all scope", async () => {
  await workspace.destroy();
  const product = await productWorkspace();
  workspace = product.workspace;
  await setConfigScalar((await workspace.state()).paths, "harness", "claude-code");
  workspace.commit("configure Claude Code");
  const revised = await updateProductBrief(await workspace.state(), {
    brief: {
      ...product.brief,
      slices: product.brief.slices.map((slice) => ({
        ...slice,
        scope: { ...slice.scope, allowed: ["**"] },
      })),
    },
    reason: "Work the whole request as one slice",
  });
  expect(revised.ok).toBe(true);
  await workspace.write("AGENTS.md", "# Imported\n");
  expect(await check("other host files")).toMatchObject({
    status: "ok",
    detail: "VISP ignores these as product: AGENTS.md; no action needed",
  });
});

it("reports Codex hook trust as unknown until the project and hooks are trusted", async () => {
  await setConfigScalar((await workspace.state()).paths, "harness", "codex");
  const codexHome = join(workspace.root, "codex-home");
  await mkdir(codexHome);
  vi.stubEnv("CODEX_HOME", codexHome);
  expect(await check("codex hooks trust")).toMatchObject({ status: "unknown" });
  const hook = `${workspace.root}/.codex/hooks.json`;
  const trust = (entries: string[]) =>
    writeFile(
      join(codexHome, "config.toml"),
      [
        `[projects.${JSON.stringify(workspace.root)}]`,
        'trust_level = "trusted"',
        ...entries.flatMap((entry) => [
          `[hooks.state.${JSON.stringify(`${hook}:${entry}:0`)}]`,
          'trusted_hash = "sha256:test"',
        ]),
      ].join("\n"),
    );
  // A project trusted before the apply_patch entry existed: the new edit hook does not run.
  await trust(["user_prompt_submit:0", "pre_tool_use:0", "stop:0"]);
  expect(await check("codex hooks trust")).toMatchObject({
    status: "unknown",
    detail: expect.stringContaining("edit hook"),
    recovery: expect.stringContaining("/hooks"),
  });
  await trust(["user_prompt_submit:0", "pre_tool_use:0", "pre_tool_use:1", "stop:0"]);
  expect(await check("codex hooks trust")).toMatchObject({ status: "ok" });
});

// The Codex edit hook lets an apply_patch call through when it cannot find the patch, so
// doctor says that scope was checked only at commit and by \`visp done\`.
it("warns when the Codex edit hook could not find a patch in an apply_patch call", async () => {
  expect(await check("codex edit hook")).toMatchObject({
    status: "ok",
    detail: "Codex is not the selected coding host",
  });
  await setConfigScalar((await workspace.state()).paths, "harness", "codex");
  expect(await check("codex edit hook")).toMatchObject({ status: "ok" });
  const session = join(workspace.root, ".visp", "session");
  await mkdir(session, { recursive: true });
  await writeFile(
    join(session, "apply-patch-unrecognized.json"),
    JSON.stringify({ at: "2026-10-21T00:00:00.000Z", fields: ["patch_text"] }),
  );
  expect(await check("codex edit hook")).toMatchObject({
    status: "warn",
    detail: expect.stringContaining("apply_patch payload shape not recognized"),
  });
  await writeFile(join(session, "apply-patch-unrecognized.json"), "{}");
  expect(await check("codex edit hook")).toMatchObject({
    status: "warn",
    detail: expect.stringContaining("tool_input fields: none"),
  });
});

// A killed reviewer's sign-in copy should not wait for the next review to be removed.
it("removes a sign-in copy left by a reviewer that has ended only with --fix", async () => {
  const temporary = join(workspace.root, "tmp-sandbox");
  const home = join(temporary, "visp-critic-aBc123", "codex-home");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "auth.json"), "{}");
  const ended = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], {
    encoding: "utf8",
  });
  await markOwner(home, Number(ended.stdout.trim()));
  vi.stubEnv("TMPDIR", temporary);
  // Plain doctor reports; it changes nothing on disk.
  const report = await runChecks(await workspace.state(), healthyDoctorRuntime);
  expect(existsSync(home)).toBe(true);
  await applyFixes(await workspace.state(), report.checks, { guardHandshake: healthyGuard });
  expect(existsSync(home)).toBe(false);
});

it("repeats the manual activation step for a generic host", async () => {
  expect(await check("harness activation")).toMatchObject({
    status: "warn",
    recovery: expect.stringContaining("AGENTS.visp.md"),
  });
});

it("warns when codex-exec is selected but the Codex CLI is unavailable", async () => {
  const state = await workspace.state();
  const config = parse(await readFile(state.paths.config, "utf8"));
  config.critic = { ...(config.critic ?? {}), harness: "codex", launch: "codex-exec" };
  await writeFile(state.paths.config, stringify(config));
  vi.stubEnv("PATH", "");
  expect(await check("codex critic CLI")).toMatchObject({ status: "warn" });
});

async function check(name: string, runtime: DoctorRuntime = healthyDoctorRuntime): Promise<Check> {
  const report = await runChecks(await workspace.state(), runtime);
  const found = report.checks.find((entry) => entry.name === name);
  if (!found) throw new Error(`no check named ${name}: ${report.checks.map((c) => c.name)}`);
  return found;
}

async function installEverything(): Promise<void> {
  const state = await workspace.state();
  const result = await installHarness(
    state.paths,
    {
      harness: "claude-code",
      hooks: ["claude", "git"],
      mcp: true,
    },
    { guardHandshake: healthyGuard },
  );
  if (!result.ok) throw new Error(result.error.message);
}

describe("the enforcement check", () => {
  it("detects and restores missing Claude prompt, Stop and Bash registrations", async () => {
    await setConfigScalar((await workspace.state()).paths, "harness", "claude-code");
    await installEverything();
    const path = join(workspace.root, ".claude/settings.json");
    const settings = JSON.parse(await readFile(path, "utf8"));
    settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(
      (entry: { matcher?: string }) => entry.matcher !== "Bash",
    );
    delete settings.hooks.UserPromptSubmit;
    delete settings.hooks.Stop;
    await writeFile(path, JSON.stringify(settings));
    expect(await check("enforcement")).toMatchObject({ status: "warn" });
    const state = await workspace.state();
    await applyFixes(state, [await check("enforcement")], { guardHandshake: healthyGuard });
    expect(await check("enforcement")).toMatchObject({ status: "ok" });
  });
  // nvm, npx or a local node_modules install the same build at another path.
  it("counts hooks the same build wrote from another install path as installed", async () => {
    await setConfigScalar((await workspace.state()).paths, "harness", "claude-code");
    await installEverything();
    await workspace.write("elsewhere/cli.js", await readFile(runtimeIdentity().executable, "utf8"));
    const elsewhere = join(workspace.root, "elsewhere/cli.js");
    for (const hook of [CLAUDE_PRE_TOOL_USE_HOOK, ".git/hooks/pre-commit"]) {
      const path = join(workspace.root, hook);
      const content = await readFile(path, "utf8");
      await writeFile(path, content.replaceAll(runtimeIdentity().executable, elsewhere));
    }
    expect(await check("enforcement")).toMatchObject({
      status: "ok",
      detail: expect.stringContaining("pre-commit"),
    });
    // Another build replaced that install: its guard answers are refused, so not healthy.
    await workspace.write("elsewhere/cli.js", "// another build\n");
    expect(await check("enforcement")).toMatchObject({ status: "warn" });
  });
  // The committed settings still run; without the script they refuse writes only while a
  // slice may be authorized, which "not installed" would misdescribe.
  it("names a deleted edit hook script that settings still run, and restores it", async () => {
    await setConfigScalar((await workspace.state()).paths, "harness", "claude-code");
    await installEverything();
    await rm(join(workspace.root, CLAUDE_PRE_TOOL_USE_HOOK));
    const result = await check("enforcement");
    expect(result).toMatchObject({ status: "warn", recovery: "visp doctor --fix" });
    expect(result.detail).toContain("script missing");
    expect(result.detail).toContain("refuses writes while a slice is authorized");
    await applyFixes(await workspace.state(), [result], { guardHandshake: healthyGuard });
    expect(await check("enforcement")).toMatchObject({ status: "ok" });
  });
  // An earlier build's `node … || exit 2` has no fallback: without the script every edit fails.
  it("says an earlier build's settings command fails every edit without the script", async () => {
    await setConfigScalar((await workspace.state()).paths, "harness", "claude-code");
    await installEverything();
    const path = join(workspace.root, ".claude/settings.json");
    const settings = JSON.parse(await readFile(path, "utf8"));
    settings.hooks.PreToolUse[0].hooks[0].command =
      'node "$CLAUDE_PROJECT_DIR/.visp/hooks/claude-pretooluse.mjs" || exit 2';
    await writeFile(path, JSON.stringify(settings));
    await rm(join(workspace.root, CLAUDE_PRE_TOOL_USE_HOOK));
    const result = await check("enforcement");
    expect(result.detail).toContain("earlier VISP command");
    expect(result.detail).not.toContain("while a slice is authorized");
    await applyFixes(await workspace.state(), [result], { guardHandshake: healthyGuard });
    expect(await check("enforcement")).toMatchObject({ status: "ok" });
  });
  it("detects and repairs a deleted Codex MCP registration", async () => {
    await setConfigScalar((await workspace.state()).paths, "harness", "codex");
    const state = await workspace.state();
    const installed = await installHarness(state.paths, { harness: "codex", hooks: [], mcp: true });
    expect(installed.ok).toBe(true);
    await rm(join(workspace.root, CODEX_CONFIG_FILE));
    expect(await check("mcp registration")).toMatchObject({ status: "warn" });
    const refreshed = await workspace.state();
    const repairs = await applyFixes(refreshed, [await check("mcp registration")]);
    expect(repairs.some((repair) => repair.done)).toBe(true);
    expect(await check("mcp registration")).toMatchObject({ status: "ok" });
  });

  // `doctor --fix` cannot rewrite a table VISP did not write, so advising it looped.
  it("accepts a hand-added Codex MCP table and ends its advice for one it cannot use", async () => {
    await setConfigScalar((await workspace.state()).paths, "harness", "codex");
    const state = await workspace.state();
    const installed = await installHarness(state.paths, { harness: "codex", hooks: [], mcp: true });
    expect(installed.ok).toBe(true);
    const config = join(workspace.root, CODEX_CONFIG_FILE);
    const cli = JSON.stringify(runtimeIdentity().executable);
    await writeFile(
      config,
      `[mcp_servers.visp]\ncommand = "node"\nargs = [${cli}, "serve", "--mcp"]\n`,
    );
    expect(await check("mcp registration")).toMatchObject({ status: "ok" });

    await writeFile(config, '[mcp_servers.visp]\ncommand = "visp"\nargs = ["serve", "--mcp"]\n');
    const result = await check("mcp registration");
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("[mcp_servers.visp]");
    expect(result.recovery).not.toContain("--fix");
    expect(result.recovery).toContain(`args = [${cli}, "serve", "--mcp"]`);
    const repairs = await applyFixes(await workspace.state(), [result]);
    const detail = repairs.map((repair) => repair.detail).join(" ");
    expect(detail).not.toContain("add [mcp_servers.visp] manually");
    expect(detail).toContain(`args = [${cli}, "serve", "--mcp"]`);

    // A table VISP cannot read is not said to start another build.
    await writeFile(config, '[mcp_servers.visp]\ncommand = "node"\nenv.TOKEN = "x"\n');
    const unreadable = await check("mcp registration");
    expect(unreadable.detail).toContain("VISP could not read");
    expect(unreadable.detail).not.toContain("does not start this VISP build");
    const repaired = await applyFixes(await workspace.state(), [unreadable]);
    expect(repaired.map((repair) => repair.detail).join(" ")).toContain("VISP could not read");
  });

  it("keeps a project or environment recovery instead of prescribing a global reinstall", async () => {
    await installEverything();
    const result = await check("enforcement", {
      guardHandshake: async () =>
        err({
          code: "COMMAND_FAILED",
          message: "Guard subprocess denied by host policy",
          recovery: "Run the guard with the host's permitted execution settings",
        }),
    });
    expect(result).toMatchObject({
      status: "fail",
      recovery: "Run the guard with the host's permitted execution settings",
    });
  });
  /** The finding the audit was about: nothing refusing anything, reported healthy. */
  it("says plainly when nothing is enforcing scope", async () => {
    const result = await check("enforcement");

    expect(result.status).toBe("warn");
    expect(result.detail).toContain("Nothing enforces scope");
  });

  it("reports the surfaces once they are installed", async () => {
    await setConfigScalar((await workspace.state()).paths, "harness", "claude-code");
    await installEverything();

    const result = await check("enforcement");

    expect(result.status).toBe("ok");
    expect(result.detail).toContain("edit hook");
    expect(result.detail).toContain("pre-commit");
    expect(result.detail).not.toContain("mcp");
  });

  it("does not count OpenCode's project MCP registration as enforcement", async () => {
    const state = await workspace.state();
    await setConfigScalar(state.paths, "harness", "opencode");
    const installed = await installHarness(
      state.paths,
      {
        harness: "opencode",
        hooks: ["git"],
        mcp: true,
      },
      { guardHandshake: healthyGuard },
    );
    if (!installed.ok) throw new Error(installed.error.message);
    await expect(readFile(join(workspace.root, "opencode.json"), "utf8")).resolves.toContain(
      '"visp"',
    );
    await expect(readFile(join(workspace.root, ".mcp.json"), "utf8")).rejects.toThrow();

    const result = await check("enforcement");

    expect(result.detail).toContain("pre-commit");
    expect(result.detail).not.toContain("mcp");
  });

  it("does not report an MCP-only installation as locally enforced", async () => {
    const state = await workspace.state();
    await setConfigScalar(state.paths, "harness", "codex");
    const installed = await installHarness(state.paths, {
      harness: "codex",
      hooks: [],
      mcp: true,
    });
    if (!installed.ok) throw new Error(installed.error.message);

    const result = await check("enforcement");

    expect(result.status).toBe("warn");
    expect(result.detail).toContain("Nothing enforces scope");
    expect(result.detail).not.toContain("mcp");
  });

  it("warns that Codex scope checks happen at commit time", async () => {
    const state = await workspace.state();
    await setConfigScalar(state.paths, "harness", "codex");
    const installed = await installHarness(
      state.paths,
      {
        harness: "codex",
        hooks: ["git"],
        mcp: false,
      },
      { guardHandshake: healthyGuard },
    );
    if (!installed.ok) throw new Error(installed.error.message);
    const result = await check("enforcement");
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("commit-time only");
  });

  /**
   * The script on disk does nothing on its own: Claude Code runs the hooks its
   * settings file names, so an unwired script is not an installed surface.
   */
  it("does not count the edit hook when settings do not name it", async () => {
    await setConfigScalar((await workspace.state()).paths, "harness", "claude-code");
    await installEverything();
    await writeFile(join(workspace.root, ".claude/settings.json"), "{}\n", "utf8");

    const result = await check("enforcement");
    expect(result.detail).toContain("not wired into settings");
  });

  it("reports settings it cannot parse rather than assuming either way", async () => {
    await setConfigScalar((await workspace.state()).paths, "harness", "claude-code");
    await installEverything();
    await writeFile(join(workspace.root, ".claude/settings.json"), "{ not json", "utf8");

    const result = await check("enforcement");
    expect(result.detail).toContain("not valid JSON");
  });

  it("does not claim a foreign pre-commit hook as its own", async () => {
    await writeFile(join(workspace.root, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 0\n", "utf8");

    const result = await check("enforcement");
    expect(result.detail).toContain("not this one");
  });

  it("does not count a non-executable pre-commit hook as active", async () => {
    await installEverything();
    await chmod(join(workspace.root, ".git/hooks/pre-commit"), 0o644);

    const result = await check("enforcement");

    expect(result.status).toBe("warn");
    expect(result.detail).toContain("not executable");
  });

  it("does not count a stale VISP hook as active", async () => {
    await installEverything();
    const path = join(workspace.root, ".git/hooks/pre-commit");
    await writeFile(path, `${await readFile(path, "utf8")}\n# edited\n`, "utf8");

    const result = await check("enforcement");

    expect(result.status).toBe("warn");
    expect(result.detail).toContain("stale or edited");
  });

  it("uses Git's configured hooks path", async () => {
    workspace.git("config", "core.hooksPath", ".githooks");
    await installEverything();

    await expect(readFile(join(workspace.root, ".githooks/pre-commit"), "utf8")).resolves.toContain(
      "managed by visp",
    );
    const result = await check("enforcement");
    expect(result.detail).toContain("pre-commit");
    expect(result.detail).not.toContain("pre-commit (not installed)");
  });

  /**
   * Installed but unrunnable is worse than not installed: the edit hook then
   * denies every write, and the pre-commit hook lets every commit through.
   */
  it("checks the pinned guard while reporting a missing PATH visp separately", async () => {
    // A host with edit hooks, so enforcement can be fully "ok" (generic hosts are Git-only and warn).
    await setConfigScalar((await workspace.state()).paths, "harness", "claude-code");
    await installEverything();

    const original = process.env.PATH;
    process.env.PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
    try {
      const result = await check("enforcement", {});
      expect(result.status, result.detail).toBe("ok");
      expect((await check("PATH visp")).status).toBe("warn");
    } finally {
      process.env.PATH = original;
    }
  });
});

describe("the harness assets check", () => {
  it("reports assets that were never installed", async () => {
    const result = await check("harness assets");

    expect(result.status).toBe("warn");
    expect(result.detail).toContain("Missing");
  });

  it("reports a clean install as installed", async () => {
    // The check compares against the configured harness's plan; the guide for
    // claude-code is a pointer while generic's is the full text, so the two no
    // longer coincide by accident.
    await setConfigScalar((await workspace.state()).paths, "harness", "claude-code");
    await installEverything();

    const result = await check("harness assets");
    expect(result.status).toBe("ok");
  });

  it("recognizes a custom Codex critic agent as installed", async () => {
    const paths = (await workspace.state()).paths;
    await setConfigScalar(paths, "harness", "codex");
    const config = parse(await readFile(paths.config, "utf8"));
    config.critic = {
      harness: "codex",
      enabled: true,
      model: "gpt-6-astra",
      reasoningEffort: "low",
      maxCalls: 2,
      timeoutMs: 180_000,
      maxImageBytes: 4 * 1024 * 1024,
    };
    await writeFile(paths.config, stringify(config), "utf8");

    const state = await workspace.state();
    const installed = await installHarness(state.paths, {
      harness: "codex",
      profile: state.config.profile,
      hooks: [],
      mcp: false,
    });
    if (!installed.ok) throw new Error(installed.error.message);

    const result = await check("harness assets");
    expect(result.status).toBe("ok");
  });

  it("treats a CRLF checkout of a generated text asset as installed", async () => {
    await setConfigScalar((await workspace.state()).paths, "harness", "claude-code");
    await installEverything();
    const path = join(workspace.root, "AGENTS.visp.md");
    const generated = await readFile(path, "utf8");
    await writeFile(path, generated.replace(/\n/g, "\r\n"), "utf8");

    const result = await check("harness assets");
    expect(result.status).toBe("ok");
  });

  /** A file the user changed is theirs; reinstalling over it would discard it. */
  it("leaves a file the user edited alone, and says it did", async () => {
    await installEverything();
    await writeFile(join(workspace.root, "AGENTS.visp.md"), "# mine now\n", "utf8");

    const result = await check("harness assets");
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("AGENTS.visp.md");
    expect(result.detail).toContain("edited by you, left alone");
    expect(result.recovery).toContain("Review");
    expect(result.recovery).toContain("--force");
  });

  it("notices an asset that is gone", async () => {
    await installEverything();
    await rm(join(workspace.root, "AGENTS.visp.md"));

    const result = await check("harness assets");
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("AGENTS.visp.md");
  });

  it("distinguishes an obsolete generated asset from a user edit", async () => {
    await installEverything();
    const state = await workspace.state();
    const previousTemplate = "# previous generated guide\n";
    await writeFile(join(workspace.root, "AGENTS.visp.md"), previousTemplate, "utf8");
    const manifest = JSON.parse(await readFile(state.paths.assetManifest, "utf8"));
    manifest["AGENTS.visp.md"] = assetFingerprint(previousTemplate);
    await writeFile(state.paths.assetManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const result = await check("harness assets");

    expect(result.status).toBe("warn");
    expect(result.detail).toContain("Stale");
    expect(result.detail).toContain("AGENTS.visp.md");
    expect(result.recovery).toContain("--force");
  });
});

describe("harness activation and residue", () => {
  it("reports activation separately from installed assets", async () => {
    await setConfigScalar((await workspace.state()).paths, "harness", "codex");

    expect((await check("harness activation")).status).toBe("warn");

    const state = await workspace.state();
    const installed = await installHarness(state.paths, { harness: "codex", hooks: [] });
    if (!installed.ok) throw new Error(installed.error.message);

    expect((await check("harness activation")).status).toBe("ok");
  });

  it("warns about owned previous-harness assets and prunes them explicitly", async () => {
    await setConfigScalar((await workspace.state()).paths, "harness", "claude-code");
    await installEverything();
    await setConfigScalar((await workspace.state()).paths, "harness", "codex");
    let state = await workspace.state();
    const switched = await installHarness(state.paths, { harness: "codex", hooks: [] });
    if (!switched.ok) throw new Error(switched.error.message);

    expect((await check("previous harness assets")).status).toBe("warn");

    state = await workspace.state();
    const pruned = await installHarness(state.paths, {
      harness: "codex",
      hooks: [],
      prunePreviousHarness: true,
    });
    if (!pruned.ok) throw new Error(pruned.error.message);

    expect((await check("previous harness assets")).status).toBe("ok");
    await expect(
      readFile(join(workspace.root, ".claude/commands/visp-next.md"), "utf8"),
    ).rejects.toThrow();
  });

  it.each([
    {
      from: "opencode" as const,
      to: "codex" as const,
      previousFile: "opencode.json",
      previousContainer: "mcp",
      currentFile: CODEX_CONFIG_FILE,
    },
  ])(
    "prunes only the generated MCP registration when switching $from to $to",
    async ({ from, to, previousFile, previousContainer, currentFile }) => {
      await setConfigScalar((await workspace.state()).paths, "harness", from);
      let state = await workspace.state();
      const installed = await installHarness(state.paths, { harness: from, hooks: [], mcp: true });
      if (!installed.ok) throw new Error(installed.error.message);

      const previousPath = join(workspace.root, previousFile);
      const previous = JSON.parse(await readFile(previousPath, "utf8"));
      previous.projectSetting = "preserve";
      previous[previousContainer].other = { command: "other-tool" };
      await writeFile(previousPath, `${JSON.stringify(previous, null, 2)}\n`, "utf8");

      await setConfigScalar((await workspace.state()).paths, "harness", to);
      state = await workspace.state();
      const switched = await installHarness(state.paths, {
        harness: to,
        hooks: [],
        mcp: true,
        prunePreviousHarness: true,
      });
      if (!switched.ok) throw new Error(switched.error.message);

      const preserved = JSON.parse(await readFile(previousPath, "utf8"));
      expect(preserved.projectSetting).toBe("preserve");
      expect(preserved[previousContainer].other).toEqual({ command: "other-tool" });
      expect(preserved[previousContainer].visp).toBeUndefined();
      const current = await readFile(join(workspace.root, currentFile), "utf8");
      expect(current).toContain("[mcp_servers.visp]");
      expect((await check("previous harness assets")).status).toBe("ok");
    },
  );

  it("prunes a legacy Codex JSON registration when switching harnesses", async () => {
    await setConfigScalar((await workspace.state()).paths, "harness", "claude-code");
    const legacy = JSON.stringify({
      mcpServers: {
        visp: { command: "visp", args: ["serve", "--mcp"] },
        other: { command: "other" },
      },
      projectSetting: "preserve",
    });
    await writeFile(join(workspace.root, ".mcp.json"), `${legacy}\n`, "utf8");

    await setConfigScalar((await workspace.state()).paths, "harness", "codex");
    const state = await workspace.state();
    const switched = await installHarness(state.paths, {
      harness: "codex",
      hooks: [],
      mcp: true,
      prunePreviousHarness: true,
    });
    if (!switched.ok) throw new Error(switched.error.message);

    const preserved = JSON.parse(await readFile(join(workspace.root, ".mcp.json"), "utf8"));
    expect(preserved.mcpServers.visp).toBeUndefined();
    expect(preserved.mcpServers.other).toEqual({ command: "other" });
    expect(preserved.projectSetting).toBe("preserve");
    expect(await readFile(join(workspace.root, CODEX_CONFIG_FILE), "utf8")).toContain(
      "[mcp_servers.visp]",
    );
  });

  it("preserves and warns about a customized previous-harness MCP registration", async () => {
    await setConfigScalar((await workspace.state()).paths, "harness", "opencode");
    let state = await workspace.state();
    const installed = await installHarness(state.paths, {
      harness: "opencode",
      hooks: [],
      mcp: true,
    });
    if (!installed.ok) throw new Error(installed.error.message);
    const previousPath = join(workspace.root, "opencode.json");
    const previous = JSON.parse(await readFile(previousPath, "utf8"));
    previous.mcp.visp.command[0] = "/custom/visp";
    const customized = `${JSON.stringify(previous, null, 2)}\n`;
    await writeFile(previousPath, customized, "utf8");

    await setConfigScalar((await workspace.state()).paths, "harness", "codex");
    state = await workspace.state();
    const switched = await installHarness(state.paths, {
      harness: "codex",
      hooks: [],
      mcp: true,
      prunePreviousHarness: true,
    });
    if (!switched.ok) throw new Error(switched.error.message);

    expect(switched.value.manualSteps.join(" ")).toContain("opencode.json");
    await expect(readFile(previousPath, "utf8")).resolves.toBe(customized);
    const residue = await check("previous harness assets");
    expect(residue.status).toBe("warn");
    expect(residue.detail).toContain("opencode.json");
  });

  it("preserves and warns about an unrecognized previous-harness MCP registration", async () => {
    await setConfigScalar((await workspace.state()).paths, "harness", "opencode");
    let state = await workspace.state();
    const installed = await installHarness(state.paths, {
      harness: "opencode",
      hooks: [],
      mcp: true,
    });
    if (!installed.ok) throw new Error(installed.error.message);
    const previousPath = join(workspace.root, "opencode.json");
    const malformed = '{"mcp":{"visp":\n';
    await writeFile(previousPath, malformed, "utf8");

    await setConfigScalar((await workspace.state()).paths, "harness", "codex");
    state = await workspace.state();
    const switched = await installHarness(state.paths, {
      harness: "codex",
      hooks: [],
      mcp: true,
      prunePreviousHarness: true,
    });
    if (!switched.ok) throw new Error(switched.error.message);

    expect(switched.value.manualSteps.join(" ")).toContain("opencode.json");
    await expect(readFile(previousPath, "utf8")).resolves.toBe(malformed);
    const residue = await check("previous harness assets");
    expect(residue.status).toBe("warn");
    expect(residue.detail).toContain("opencode.json");
  });

  it("warns about and prunes Claude's generated hook and exact settings registration", async () => {
    await setConfigScalar((await workspace.state()).paths, "harness", "claude-code");
    await installEverything();
    const settingsPath = join(workspace.root, ".claude/settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    settings.model = "opus";
    settings.hooks.PreToolUse.unshift({
      matcher: "Bash",
      hooks: [{ type: "command", command: "./project-audit.sh" }],
    });
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

    await setConfigScalar((await workspace.state()).paths, "harness", "codex");
    let state = await workspace.state();
    const switched = await installHarness(state.paths, { harness: "codex", hooks: [] });
    if (!switched.ok) throw new Error(switched.error.message);

    const beforePrune = await check("previous harness assets");
    expect(beforePrune.status).toBe("warn");
    expect(beforePrune.detail).toContain(".visp/hooks/claude-pretooluse.mjs");
    expect(beforePrune.detail).toContain(".claude/settings.json");

    state = await workspace.state();
    const pruned = await installHarness(state.paths, {
      harness: "codex",
      hooks: [],
      prunePreviousHarness: true,
    });
    if (!pruned.ok) throw new Error(pruned.error.message);

    await expect(
      readFile(join(workspace.root, ".visp/hooks/claude-pretooluse.mjs"), "utf8"),
    ).rejects.toThrow();
    const preserved = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(preserved.model).toBe("opus");
    expect(preserved.hooks.PreToolUse).toEqual([
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: "./project-audit.sh" }],
      },
    ]);
    expect((await check("previous harness assets")).status).toBe("ok");
  });

  it("preserves edited Claude hook residue and a customized settings registration", async () => {
    await setConfigScalar((await workspace.state()).paths, "harness", "claude-code");
    await installEverything();
    const hookPath = join(workspace.root, ".visp/hooks/claude-pretooluse.mjs");
    const settingsPath = join(workspace.root, ".claude/settings.json");
    await writeFile(hookPath, `${await readFile(hookPath, "utf8")}\n// project edit\n`, "utf8");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    settings.hooks.PreToolUse[0].hooks[0].command += " || true";
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await setConfigScalar((await workspace.state()).paths, "harness", "codex");

    const beforePrune = await check("previous harness assets");
    expect(beforePrune.status).toBe("warn");
    expect(beforePrune.detail).toContain(".visp/hooks/claude-pretooluse.mjs");
    expect(beforePrune.detail).toContain(".claude/settings.json");

    const state = await workspace.state();
    const inspected = await inspectForeignHarnessAssets(state.paths, "codex");
    expect(inspected.ok && inspected.value.edited).toContain(CLAUDE_SETTINGS_REGISTRATION);
    const pruned = await installHarness(state.paths, {
      harness: "codex",
      hooks: [],
      prunePreviousHarness: true,
    });
    if (!pruned.ok) throw new Error(pruned.error.message);

    expect(pruned.value.manualSteps.join(" ")).toContain(".visp/hooks/claude-pretooluse.mjs");
    expect(pruned.value.manualSteps.join(" ")).toContain(".claude/settings.json");
    await expect(readFile(hookPath, "utf8")).resolves.toContain("project edit");
    await expect(readFile(settingsPath, "utf8")).resolves.toContain("|| true");
    expect((await check("previous harness assets")).status).toBe("warn");
  });

  it("never prunes an unrecognized file at Claude's generated hook path", async () => {
    await setConfigScalar((await workspace.state()).paths, "harness", "codex");
    const hookPath = join(workspace.root, CLAUDE_PRE_TOOL_USE_HOOK);
    await mkdir(dirname(hookPath), { recursive: true });
    await writeFile(hookPath, "// project-owned hook\n", "utf8");
    const registered = await registerPreToolUseHook(
      workspace.root,
      CLAUDE_PRE_TOOL_USE_HOOK,
      false,
    );
    if (!registered.ok) throw new Error(registered.error.message);

    const beforePrune = await check("previous harness assets");
    expect(beforePrune.status).toBe("warn");
    expect(beforePrune.detail).toContain(CLAUDE_PRE_TOOL_USE_HOOK);
    expect(beforePrune.detail).toContain(".claude/settings.json");

    const state = await workspace.state();
    const pruned = await installHarness(state.paths, {
      harness: "codex",
      hooks: [],
      prunePreviousHarness: true,
    });
    if (!pruned.ok) throw new Error(pruned.error.message);

    expect(pruned.value.manualSteps.join(" ")).toContain(CLAUDE_PRE_TOOL_USE_HOOK);
    await expect(readFile(hookPath, "utf8")).resolves.toBe("// project-owned hook\n");
    const settings = JSON.parse(
      await readFile(join(workspace.root, ".claude/settings.json"), "utf8"),
    );
    expect(settings.hooks.PreToolUse).toEqual([]);
    expect((await check("previous harness assets")).status).toBe("warn");
  });

  it("never prunes an edited previous-harness asset", async () => {
    await setConfigScalar((await workspace.state()).paths, "harness", "claude-code");
    await installEverything();
    const edited = join(workspace.root, ".claude/commands/visp-next.md");
    await writeFile(edited, "my command\n", "utf8");
    await setConfigScalar((await workspace.state()).paths, "harness", "codex");

    const beforePrune = await check("previous harness assets");
    expect(beforePrune.status).toBe("warn");
    expect(beforePrune.detail).toMatch(/edited or unrecognized/i);
    expect(beforePrune.detail).toContain(".claude/commands/visp-next.md");

    const state = await workspace.state();
    const result = await installHarness(state.paths, {
      harness: "codex",
      hooks: [],
      prunePreviousHarness: true,
    });
    if (!result.ok) throw new Error(result.error.message);

    expect(result.value.manualSteps.join(" ")).toContain(".claude/commands/visp-next.md");
    expect(result.value.manualSteps.join(" ")).toContain("left alone");
    await expect(readFile(edited, "utf8")).resolves.toBe("my command\n");
    expect((await check("previous harness assets")).status).toBe("warn");
  });

  it("warns about an unrecognized previous-harness asset and never prunes it", async () => {
    await setConfigScalar((await workspace.state()).paths, "harness", "codex");
    const unrecognized = join(workspace.root, ".claude/commands/visp-next.md");
    await mkdir(dirname(unrecognized), { recursive: true });
    await writeFile(unrecognized, "project command\n", "utf8");

    const beforePrune = await check("previous harness assets");
    expect(beforePrune.status).toBe("warn");
    expect(beforePrune.detail).toMatch(/edited or unrecognized/i);

    const state = await workspace.state();
    const result = await installHarness(state.paths, {
      harness: "codex",
      hooks: [],
      prunePreviousHarness: true,
    });
    if (!result.ok) throw new Error(result.error.message);

    expect(result.value.manualSteps.join(" ")).toContain(".claude/commands/visp-next.md");
    await expect(readFile(unrecognized, "utf8")).resolves.toBe("project command\n");
  });

  it("warns when an edited activation block remains for a previous harness", async () => {
    await setConfigScalar((await workspace.state()).paths, "harness", "codex");
    let state = await workspace.state();
    const codex = await installHarness(state.paths, { harness: "codex", hooks: [] });
    if (!codex.ok) throw new Error(codex.error.message);
    const agents = join(workspace.root, "AGENTS.md");
    const original = await readFile(agents, "utf8");
    expect(original).toContain(ACTIVATION_END);
    await writeFile(
      agents,
      original.replace(ACTIVATION_END, `Project-owned edit.\n${ACTIVATION_END}`),
      "utf8",
    );
    await setConfigScalar((await workspace.state()).paths, "harness", "claude-code");

    const residue = await check("previous harness assets");
    expect(residue.status).toBe("warn");
    expect(residue.detail).toContain("edited");
    expect(residue.detail).toContain("AGENTS.md");

    state = await workspace.state();
    const switched = await installHarness(state.paths, {
      harness: "claude-code",
      hooks: [],
      prunePreviousHarness: true,
    });
    if (!switched.ok) throw new Error(switched.error.message);
    expect(switched.value.manualSteps.join(" ")).toContain("edited VISP block");
    await expect(readFile(agents, "utf8")).resolves.toContain("Project-owned edit.");
  });
});

describe("transaction recovery", () => {
  it("reports and repairs an interrupted file update", async () => {
    const interrupted = await applyFileTransaction(
      workspace.root,
      "doctor-test",
      [{ kind: "write", path: "interrupted.txt", content: "partial\n" }],
      {
        afterMutation() {
          throw new Error("simulated process exit");
        },
        leavePreparedOnError: true,
      },
    );
    expect(interrupted.ok).toBe(false);
    expect((await check("file transactions")).status).toBe("fail");

    const state = await workspace.state();
    const repairs = await applyFixes(state, (await runChecks(state, healthyDoctorRuntime)).checks, {
      guardHandshake: healthyGuard,
    });

    expect(repairs.find((repair) => repair.name === "file transactions")?.done).toBe(true);
    expect((await check("file transactions")).status).toBe("ok");
    await expect(readFile(join(workspace.root, "interrupted.txt"), "utf8")).rejects.toThrow();
  });
});

describe("authorization recovery", () => {
  it("reports and transactionally removes a marker for a completed task", async () => {
    await workspace.withFeature("001-closed", [task({ id: "T001", status: "done" })]);
    const state = await workspace.state();
    const written = await legacyStore(state).writeImplementMarker({
      kind: "implement-marker",
      createdAt: now(),
      feature: "001-closed",
      task: "T001",
      allowedFiles: ["src/**"],
      expectedFiles: [],
      forbiddenFiles: [],
    });
    expect(written.ok).toBe(true);
    expect((await check("authorization markers")).status).toBe("warn");

    const repairs = await applyFixes(state, (await runChecks(state, healthyDoctorRuntime)).checks, {
      guardHandshake: healthyGuard,
    });

    expect(repairs.find((repair) => repair.name === "authorization markers")?.done).toBe(true);
    expect((await check("authorization markers")).status).toBe("ok");
    const marker = await (await workspace.state()).store.readImplementMarker("T001");
    expect(marker.ok && marker.value).toBeUndefined();
  });
});

describe("the validation commands check", () => {
  it("recognizes active product checks without requiring legacy configuration", async () => {
    await workspace.destroy();
    ({ workspace } = await productWorkspace());
    const result = await check("validation commands");
    expect(result).toMatchObject({ status: "ok" });
    expect(result.detail).toContain("C001");
    expect(result.recovery).toBeUndefined();
  });

  it("explains configured execution while warning about missing product outcome checks", async () => {
    await workspace.destroy();
    const product = await productWorkspace();
    workspace = product.workspace;
    const updated = await updateProductBrief(await workspace.state(), {
      brief: {
        ...product.brief,
        checks: [],
        slices: product.brief.slices.map((slice) => ({ ...slice, checks: [] })),
      },
      reason: "Reconsider the verification approach",
    });
    expect(updated.ok).toBe(true);
    await workspace.write(
      "visp.yml",
      "harness: generic\nworkflow:\n  validationCommands: [node --test]\n",
    );
    const result = await check("validation commands");
    expect(result).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("active product brief"),
      recovery: expect.stringContaining("visp brief"),
    });
    expect(result.detail).toContain("1 configured project check(s) also run during verification");
    expect(result.recovery).toContain("do not replace checks linked to product outcomes");
    expect(result.recovery).not.toContain("do not run");
  });

  it("rejects an unrunnable configured command even when the product declares its own checks", async () => {
    await workspace.destroy();
    ({ workspace } = await productWorkspace());
    await workspace.write(
      "visp.yml",
      "harness: generic\nworkflow:\n  validationCommands: [node --test && node --version]\n",
    );
    expect(await check("validation commands")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("Cannot run without a shell"),
    });
  });

  it("reports an unreadable product brief instead of falling back to empty legacy tasks", async () => {
    await workspace.destroy();
    const product = await productWorkspace();
    workspace = product.workspace;
    await workspace.write(`.visp/features/${product.brief.feature}/brief.yaml`, "not: [valid");
    expect(await check("validation commands")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("Product checks could not be inspected"),
    });
  });
  /** Caught here it is a typo; found at verify it is a refusal on finished work. */
  it("fails a command that cannot run without a shell", async () => {
    const state = await workspace.state();
    await writeFile(
      state.paths.config,
      "workflow:\n  validationCommands:\n    - pnpm test && pnpm lint\n",
      "utf8",
    );

    const result = await check("validation commands");

    expect(result.status).toBe("fail");
    expect(result.detail).toContain("pnpm test && pnpm lint");
  });

  it("warns when none are configured, because verify can then prove nothing", async () => {
    const result = await check("validation commands");

    expect(result.status).toBe("warn");
    expect(result.detail).toContain("None configured");
  });
});

describe("the repository index check", () => {
  it("reports an index that was never built", async () => {
    const result = await check("repository index");

    expect(result.status).toBe("warn");
    expect(result.detail).toContain("Not built");
  });

  it("reports a built index as current", async () => {
    const state = await workspace.state();
    const built = await indexRepository(
      state.paths.root,
      state.config.graph,
      state.paths.graphStore,
    );
    expect(built.ok).toBe(true);

    const result = await check("repository index");
    expect(result.status).toBe("ok");
  });

  it("rejects an otherwise identical index copied from another checkout without rewriting it", async () => {
    const donor = await TestWorkspace.create({ "src/app.ts": "export const a = 1;\n" });
    try {
      const source = await donor.state();
      const built = await indexRepository(
        source.paths.root,
        source.config.graph,
        source.paths.graphStore,
      );
      expect(built.ok).toBe(true);
      const bytes = await readFile(source.paths.graphStore);
      const state = await workspace.state();
      await mkdir(dirname(state.paths.graphStore), { recursive: true });
      await writeFile(state.paths.graphStore, bytes);
      expect(await check("repository index")).toMatchObject({
        status: "warn",
        detail: expect.stringContaining("another checkout"),
        recovery: "visp index --refresh",
      });
      expect(await readFile(state.paths.graphStore)).toEqual(bytes);
      const repairs = await applyFixes(state, [await check("repository index")]);
      expect(repairs).toContainEqual(
        expect.objectContaining({ name: "repository index", done: true }),
      );
      expect(await check("repository index")).toMatchObject({ status: "ok" });
      expect(await readFile(source.paths.graphStore)).toEqual(bytes);
    } finally {
      await donor.destroy();
    }
  });

  /** An index that no longer matches the worktree describes code that has moved on. */
  it("reports an index that has fallen behind the worktree", async () => {
    const state = await workspace.state();
    await indexRepository(state.paths.root, state.config.graph, state.paths.graphStore);
    await workspace.write("src/added-later.ts", "export const later = 1;\n");

    const result = await check("repository index");

    expect(result.status).toBe("warn");
    expect(result.detail).toContain("Behind the worktree");
  });

  it("does not claim health for an index it cannot read", async () => {
    const state = await workspace.state();
    await mkdir(dirname(state.paths.graphStore), { recursive: true });
    await writeFile(state.paths.graphStore, "not a database", "utf8");

    const result = await check("repository index");
    expect(result.status).not.toBe("ok");
  });
});

describe("the evidence trail check", () => {
  /** A project may deliberately keep its evidence local. */
  it("respects a deliberate .gitignore that keeps the trail local", async () => {
    await writeFile(join(workspace.root, ".gitignore"), ".visp/\n", "utf8");

    const result = await check("evidence trail");
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("deliberately");
  });

  it("does not claim evidence is tracked when Git is unavailable", async () => {
    await rm(join(workspace.root, ".git"), { recursive: true, force: true });

    const result = await check("evidence trail");

    expect(result.status).toBe("unknown");
    expect(result.detail).not.toContain("are tracked");
  });

  it("describes a visible evidence path without claiming it was committed", async () => {
    const result = await check("evidence trail");

    expect(result.status).toBe("ok");
    expect(result.detail).toContain("can be committed");
    expect(result.detail).not.toContain("are tracked");
  });
});

describe("the git preflight check", () => {
  it("fails once feature work exists outside a Git repository", async () => {
    await workspace.withFeature("001-do-the-thing");
    await rm(join(workspace.root, ".git"), { recursive: true, force: true });

    const result = await check("git");

    expect(result.status).toBe("fail");
    expect(result.detail).toContain("cannot be authorized or evidenced");
  });
});

describe("the active feature check", () => {
  it("points at how to start one when there is none", async () => {
    const result = await check("active feature");
    expect(result.detail).toContain("None yet");
  });

  it("names the feature and its goal once one exists", async () => {
    await workspace.withFeature("001-do-the-thing");

    const result = await check("active feature");
    expect(result.detail).toContain("001-do-the-thing");
    expect(result.detail).toContain("Do the thing");
  });
});

describe("repository-intelligence support", () => {
  it("warns when the selected preset has no parser", async () => {
    await setConfigScalar((await workspace.state()).paths, "preset", "go");

    const result = await check("configuration");

    expect(result.status).toBe("warn");
    expect(result.detail).toContain("index parses ts/js/python only");
    expect(result.detail).toContain("fall back to paths");
  });
});

describe("the skill library check", () => {
  it("reports an empty library as an explicit healthy state", async () => {
    const result = await check("skill library");

    expect(result.status).toBe("ok");
    expect(result.detail).toContain("empty");
    expect(result.detail).toContain("research-the-craft");
    expect(result.detail).toContain("visp skill catalog");
  });

  it("summarizes the lifecycle states that are present", async () => {
    const state = await workspace.state();
    for (const record of [
      skillRecord("one-skill", "admitted"),
      skillRecord("two-skill", "proposed"),
      skillRecord("three-skill", "proposed"),
    ]) {
      const written = await upsert(state, record);
      expect(written.ok).toBe(true);
    }

    const result = await check("skill library");

    expect(result.status).toBe("ok");
    expect(result.detail).toContain("3 skills");
    expect(result.detail).toContain("admitted 1");
    expect(result.detail).toContain("proposed 2");
  });
});

function skillRecord(id: string, state: "admitted" | "proposed") {
  return {
    id,
    name: id,
    description: "",
    state,
    trust: "advisory" as const,
    origin: "seeded" as const,
    derivedFrom: [],
    contentHash: "abc123",
    createdAt: now(),
    ...(state === "admitted" ? { admittedBy: "tester", admittedAt: now() } : {}),
  };
}

describe("applyFixes", () => {
  it("installs the enforcement surfaces it found missing", async () => {
    await setConfigScalar((await workspace.state()).paths, "harness", "claude-code");

    const state = await workspace.state();
    const report = await runChecks(state, healthyDoctorRuntime);
    const repairs = await applyFixes(state, report.checks, { guardHandshake: healthyGuard });

    expect(repairs.some((repair) => repair.detail.includes("enforced by"))).toBe(true);

    expect((await check("enforcement")).detail).toContain("Refusals are enforced by");
  });

  it("changes nothing on a second run", async () => {
    const state = await workspace.state();
    await applyFixes(state, (await runChecks(state, healthyDoctorRuntime)).checks, {
      guardHandshake: healthyGuard,
    });

    const second = await workspace.state();
    const repairs = await applyFixes(
      second,
      (await runChecks(second, healthyDoctorRuntime)).checks,
      { guardHandshake: healthyGuard },
    );

    expect(repairs.every((repair) => repair.done)).toBe(true);
  });

  it("does not broaden an installation whose local surfaces were explicitly omitted", async () => {
    const state = await workspace.state();
    const installed = await installHarness(state.paths, {
      harness: "generic",
      hooks: [],
      mcp: false,
    });
    if (!installed.ok) throw new Error(installed.error.message);
    const refreshed = await workspace.state();
    const report = await runChecks(refreshed, healthyDoctorRuntime);
    const enforcement = report.checks.find((entry) => entry.name === "enforcement");
    expect(enforcement?.detail).toContain("explicitly omitted");

    await applyFixes(refreshed, enforcement ? [enforcement] : [], {
      guardHandshake: healthyGuard,
    });

    await expect(readFile(join(workspace.root, ".git/hooks/pre-commit"), "utf8")).rejects.toThrow();
    const choices = await readInstallState(refreshed.paths, refreshed.files);
    expect(choices.ok && choices.value).toMatchObject({ hooks: [], mcp: false });
  });

  it("repairs assets using the installed profile instead of the default profile", async () => {
    const state = await workspace.state();
    await setConfigScalar(state.paths, "harness", "codex");
    const installed = await installHarness(state.paths, {
      harness: "codex",
      profile: "standard",
      hooks: [],
      mcp: false,
    });
    if (!installed.ok) throw new Error(installed.error.message);
    await rm(join(workspace.root, "AGENTS.visp.md"));
    const refreshed = await workspace.state();
    const report = await runChecks(refreshed, healthyDoctorRuntime);

    await applyFixes(refreshed, report.checks, { guardHandshake: healthyGuard });

    const expected = planFor("codex", "standard").assets.find(
      (asset) => asset.path === "AGENTS.visp.md",
    );
    await expect(readFile(join(workspace.root, "AGENTS.visp.md"), "utf8")).resolves.toBe(
      expected?.content,
    );
  });
});

async function setConfigScalar(
  paths: { readonly config: string },
  key: string,
  value: string,
): Promise<void> {
  const config = parse(await readFile(paths.config, "utf8"));
  config[key] = value;
  await writeFile(paths.config, stringify(config), "utf8");
}
