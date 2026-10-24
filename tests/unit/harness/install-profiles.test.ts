import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exists } from "../../../src/core/fs.js";
import { assetFingerprint } from "../../../src/harness/asset-inspection.js";
import { installHarness } from "../../../src/harness/install.js";
import { TestWorkspace } from "../support/workspace.js";

/**
 * Switching profiles must be a rewrite of visp's own files, never of the
 * user's: assets the new profile does not install are pruned only when their
 * content is provably what visp wrote.
 */

let workspace: TestWorkspace;

beforeEach(async () => {
  workspace = await TestWorkspace.create();
});

afterEach(async () => {
  await workspace.destroy();
});

async function install(profile: "standard" | "minimal") {
  const state = await workspace.state();
  const result = await installHarness(state.paths, { harness: "claude-code", profile });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function file(path: string): string {
  return join(workspace.root, path);
}

describe("profile switching", () => {
  it("prunes the standard-only assets on the way down to minimal", async () => {
    await install("standard");
    expect(await exists(file(".claude/skills/visp/SKILL.md"))).toBe(true);

    const outcome = await install("minimal");

    expect(await exists(file(".claude/skills/visp/SKILL.md"))).toBe(false);
    expect(await exists(file(".claude/agents/visp-scout.md"))).toBe(false);
    expect(await exists(file(".claude/commands/visp-pr.md"))).toBe(false);
    expect(await exists(file(".claude/commands/visp-next.md"))).toBe(true);
    expect(outcome.assets.some((asset) => asset.status === "removed")).toBe(true);
  });

  it("rewrites the guide in place across a switch, without --force", async () => {
    await install("standard");
    await install("minimal");

    const guide = await readFile(file("AGENTS.visp.md"), "utf8");
    expect(guide).toContain("Before the final answer, reach next action complete or a handoff");
    expect(guide).toContain("visp work");
  });

  it("restores the full surface on the way back up", async () => {
    await install("standard");
    await install("minimal");
    await install("standard");

    expect(await exists(file(".claude/skills/visp/SKILL.md"))).toBe(true);
    expect(await exists(file(".claude/agents/visp-scout.md"))).toBe(true);
  });

  it("keeps a user-edited file and says so instead of deleting it", async () => {
    await install("standard");
    await writeFile(file(".claude/skills/visp/SKILL.md"), "my own notes\n", "utf8");

    const outcome = await install("minimal");

    expect(await readFile(file(".claude/skills/visp/SKILL.md"), "utf8")).toBe("my own notes\n");
    expect(outcome.manualSteps.join(" ")).toContain(".claude/skills/visp/SKILL.md");
  });

  /** An earlier build wrote the command guide at the root, where every worker's `ls` found it. */
  async function olderGuideAtRoot(content: string) {
    const state = await workspace.state();
    await writeFile(file("VISP.commands.md"), content, "utf8");
    const manifest = JSON.parse(await readFile(state.paths.assetManifest, "utf8"));
    manifest["VISP.commands.md"] = assetFingerprint(content);
    await writeFile(state.paths.assetManifest, JSON.stringify(manifest), "utf8");
  }

  it("moves an unedited command guide from the project root into .visp/", async () => {
    await install("minimal");
    await olderGuideAtRoot("# VISP command guide\n\nAn earlier build's text.\n");

    const outcome = await install("minimal");

    expect(await exists(file("VISP.commands.md"))).toBe(false);
    expect(await readFile(file(".visp/VISP.commands.md"), "utf8")).toContain(
      "# VISP command guide",
    );
    expect(outcome.assets).toContainEqual({ path: "VISP.commands.md", status: "removed" });
  });

  it("keeps an edited command guide at the root and says where the guide went", async () => {
    await install("minimal");
    await olderGuideAtRoot("# VISP command guide\n");
    await writeFile(file("VISP.commands.md"), "# VISP command guide\n\nMy notes.\n", "utf8");

    const outcome = await install("minimal");

    expect(await readFile(file("VISP.commands.md"), "utf8")).toContain("My notes.");
    expect(outcome.manualSteps.join(" ")).toContain(
      "VISP.commands.md is an edited copy of the command guide, which now lives at .visp/VISP.commands.md",
    );
  });

  it("leaves a root VISP.commands.md that no install recorded", async () => {
    await install("minimal");
    await writeFile(file("VISP.commands.md"), "# Our own commands\n", "utf8");

    const outcome = await install("minimal");

    expect(await readFile(file("VISP.commands.md"), "utf8")).toBe("# Our own commands\n");
    expect(outcome.manualSteps.join(" ")).not.toContain("VISP.commands.md");
  });

  it("is idempotent: a repeated install changes nothing", async () => {
    await install("minimal");
    const outcome = await install("minimal");

    expect(outcome.assets.every((asset) => asset.status === "unchanged")).toBe(true);
  });
});
