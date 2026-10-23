import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { ok } from "../../../src/core/result.js";
import { COMPACTION_ENV, withCompactionEnv } from "../../../src/harness/claude-settings.js";
import { installHarness } from "../../../src/harness/install.js";
import { uninstallHarness } from "../../../src/harness/uninstall.js";
import { TestWorkspace } from "../support/workspace.js";

/**
 * A lean Claude Code worker compacts at 90% of a 100k-token window, below the prompt size where
 * every Haiku 5.5 price is 5 times higher (leandef2: 15 to 23 turns above it on extend).
 */
describe("the compaction variables", () => {
  it("adds both to settings, keeping the project's own env and layout", () => {
    const current = '{\n  "env": { "API_TIMEOUT_MS": "1200000" },\n  "hooks": {}\n}\n';
    const next = withCompactionEnv(current, true) ?? "";
    expect(JSON.parse(next)).toEqual({
      env: { API_TIMEOUT_MS: "1200000", ...COMPACTION_ENV },
      hooks: {},
    });
    expect(withCompactionEnv(next, true)).toBe(next);
  });

  it("leaves a value the project chose, and removes only VISP's values", () => {
    const current = '{ "env": { "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "200000" } }\n';
    const on = withCompactionEnv(current, true) ?? "";
    expect(JSON.parse(on).env).toEqual({
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000",
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "90",
    });
    expect(JSON.parse(withCompactionEnv(on, false) ?? "").env).toEqual({
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000",
    });
  });

  it("drops an env object only VISP's values filled", () => {
    const on = withCompactionEnv('{ "hooks": {} }\n', true) ?? "";
    expect(JSON.parse(withCompactionEnv(on, false) ?? "")).toEqual({ hooks: {} });
  });

  it("leaves text it cannot parse unchanged", () => {
    expect(withCompactionEnv("{ not json", true)).toBe("{ not json");
  });
});

describe("install and uninstall", () => {
  let workspace: TestWorkspace;
  beforeEach(async () => {
    workspace = await TestWorkspace.create();
  });
  afterEach(async () => {
    await workspace.destroy();
  });

  async function configure(workflow: Record<string, unknown>) {
    const config = parse(await readFile(join(workspace.root, "visp.yml"), "utf8"));
    config.workflow = { ...config.workflow, ...workflow };
    await workspace.write("visp.yml", stringify(config));
  }
  async function install() {
    const state = await workspace.state();
    const installed = await installHarness(
      state.paths,
      { harness: "claude-code", profile: "minimal", hooks: ["claude"] },
      { guardHandshake: async () => ok(undefined) },
    );
    if (!installed.ok) throw new Error(installed.error.message);
  }
  const env = async () =>
    JSON.parse(await readFile(join(workspace.root, ".claude/settings.json"), "utf8")).env;

  it("sets them for a lean project and removes them when workflow.autoCompact is false", async () => {
    await configure({ profile: "lean" });
    await install();
    expect(await env()).toEqual(COMPACTION_ENV);
    await configure({ profile: "lean", autoCompact: false });
    await install();
    expect(await env()).toBeUndefined();
  });

  it("does not set them for the full profile or a weak worker", async () => {
    await configure({ profile: "full" });
    await install();
    expect(await env()).toBeUndefined();
    await configure({ profile: "lean", worker: "weak" });
    await install();
    expect(await env()).toBeUndefined();
  });

  it("are removed by uninstall", async () => {
    await configure({ profile: "lean" });
    await install();
    const state = await workspace.state();
    const removed = await uninstallHarness(state.paths, { harness: "claude-code" });
    expect(removed.ok).toBe(true);
    const settings = await readFile(join(workspace.root, ".claude/settings.json"), "utf8").catch(
      () => undefined,
    );
    expect(settings === undefined || !settings.includes("CLAUDE_CODE_AUTO_COMPACT_WINDOW")).toBe(
      true,
    );
  });
});
