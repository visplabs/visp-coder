import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planAgentActivation, planAgentDeactivation } from "../../../src/harness/activation.js";
import { installHarness } from "../../../src/harness/install.js";
import { planFor } from "../../../src/harness/targets.js";
import { TestWorkspace } from "../support/workspace.js";

// A fresh AGENTS.md receives exactly the generated block and a trailing newline.
const fresh = planAgentActivation("codex", undefined, false);
const expectedActivationBlock = fresh.ok ? (fresh.value.content ?? "").replace(/\n$/, "") : "";

let workspace: TestWorkspace;

it("installs Claude activation through a link to an in-project AGENTS.md", async () => {
  await workspace.write("AGENTS.md", "Shared instructions\n");
  await symlink("AGENTS.md", join(workspace.root, "CLAUDE.md"));
  const result = await installHarness((await workspace.state()).paths, {
    harness: "claude-code",
    hooks: [],
  });
  expect(result.ok).toBe(true);
  expect(await readFile(join(workspace.root, "AGENTS.md"), "utf8")).toContain(
    "visp:instructions:start",
  );
});

beforeEach(async () => {
  workspace = await TestWorkspace.create();
});

afterEach(async () => {
  await workspace.destroy();
});

async function installCodex(force = false) {
  const state = await workspace.state();
  const result = await installHarness(state.paths, {
    harness: "codex",
    hooks: [],
    ...(force ? { force: true } : {}),
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("CRLF checkouts", () => {
  const crlf = (text: string) => text.replace(/\n/g, "\r\n");

  it("treats a CRLF copy of the generated block as current and removes it cleanly", () => {
    const block = crlf(expectedActivationBlock);
    const source = `# My rules\n\n${block}\n`;
    expect(planAgentActivation("codex", source, false)).toEqual({
      ok: true,
      value: { status: "current" },
    });
    expect(planAgentDeactivation(source)).toEqual({ status: "removed", content: "# My rules\n" });
  });

  it("still treats a CRLF block with a user edit as edited", () => {
    const edited = crlf(expectedActivationBlock.replace("No custom skill", "My own skill"));
    expect(planAgentActivation("codex", `${edited}\n`, false).ok).toBe(false);
    expect(planAgentDeactivation(`${edited}\n`).status).toBe("edited");
  });

  it("leaves a current CRLF AGENTS.md block untouched on reinstall", async () => {
    const source = `# My rules\r\n\r\n${crlf(expectedActivationBlock)}\r\n`;
    await workspace.write("AGENTS.md", source);
    await installCodex();
    expect(await readFile(join(workspace.root, "AGENTS.md"), "utf8")).toBe(source);
  });

  it("does not block on a CRLF text asset and rewrites a CRLF executable without --force", async () => {
    const first = await installCodex();
    const assets = planFor("codex", "minimal").assets;
    const text = assets.find((asset) => !asset.executable);
    const script = assets.find((asset) => asset.executable);
    if (!text || !script) throw new Error("expected a text and an executable Codex asset");
    expect(first.assets.length).toBeGreaterThan(0);
    const textPath = join(workspace.root, text.path);
    const scriptPath = join(workspace.root, script.path);
    await writeFile(textPath, crlf(text.content));
    await writeFile(scriptPath, crlf(script.content), { mode: 0o755 });

    const second = await installCodex();

    expect(second.assets.find((asset) => asset.path === text.path)?.status).toBe("unchanged");
    expect(await readFile(textPath, "utf8")).toBe(crlf(text.content));
    // A CRLF shell script does not run: the recorded fingerprint proves it is VISP's own.
    expect(second.assets.find((asset) => asset.path === script.path)?.status).toBe("written");
    expect(await readFile(scriptPath, "utf8")).toBe(script.content);
  });
});

describe("project instruction activation", () => {
  it("upgrades and removes only the exact earlier CLI-first block", () => {
    const previous =
      "<!-- visp:instructions:start -->\nFollow the VISP project instructions in [AGENTS.visp.md](AGENTS.visp.md). Run `visp next` before editing and follow the command it prints.\n<!-- visp:instructions:end -->";
    const source = `before\n${previous}\nafter\n`;
    const upgrade = planAgentActivation("codex", source, false);
    expect(upgrade).toMatchObject({ ok: true, value: { status: "replaced" } });
    if (upgrade.ok) {
      expect(upgrade.value.content).toContain("Use VISP MCP tools when connected");
      expect(upgrade.value.content).toContain(
        "A new request starts with `visp feature`; `visp next` resumes one in progress.",
      );
      expect(upgrade.value.content).toMatch(/^before\n[\s\S]*\nafter\n$/);
    }
    expect(planAgentDeactivation(source)).toEqual({
      status: "removed",
      content: "before\n\nafter\n",
    });
    const edited = source.replace("follow the command it prints", "use my custom command");
    expect(planAgentActivation("codex", edited, false).ok).toBe(false);
    expect(planAgentDeactivation(edited).status).toBe("edited");
  });

  it("adds one managed reference while preserving an existing AGENTS.md", async () => {
    const agents = join(workspace.root, "AGENTS.md");
    await writeFile(agents, "# Project rules\n\nKeep this text.\n", "utf8");

    await installCodex();
    await installCodex();

    const content = await readFile(agents, "utf8");
    expect(content).toContain("# Project rules\n\nKeep this text.");
    expect(content).toContain("AGENTS.visp.md");
    expect(content.match(/visp:instructions:start/g)).toHaveLength(1);
    expect(content.match(/visp:instructions:end/g)).toHaveLength(1);
  });

  it("refuses an edited managed block without changing the file", async () => {
    await installCodex();
    const agents = join(workspace.root, "AGENTS.md");
    const edited = (await readFile(agents, "utf8")).replace(
      "Follow the VISP project instructions",
      "Ignore the VISP project instructions",
    );
    await writeFile(agents, edited, "utf8");

    const state = await workspace.state();
    const result = await installHarness(state.paths, { harness: "codex", hooks: [] });

    expect(result.ok).toBe(false);
    expect(await readFile(agents, "utf8")).toBe(edited);
  });

  it("replaces only an edited managed block with --force", async () => {
    const agents = join(workspace.root, "AGENTS.md");
    await writeFile(agents, "before\n", "utf8");
    await installCodex();
    const edited = (await readFile(agents, "utf8")).replace(
      "Follow the VISP project instructions",
      "Ignore the VISP project instructions",
    );
    await writeFile(agents, `${edited}after\n`, "utf8");

    await installCodex(true);

    const content = await readFile(agents, "utf8");
    expect(content).toContain("before\n");
    expect(content).toContain("after\n");
    expect(content).toContain("Follow the VISP project instructions");
    expect(content).not.toContain("Ignore the VISP project instructions");
  });

  it("removes an otherwise-empty activation file when switching harnesses explicitly", async () => {
    await installCodex();
    const state = await workspace.state();

    const result = await installHarness(state.paths, {
      harness: "generic",
      hooks: [],
      prunePreviousHarness: true,
    });

    expect(result.ok).toBe(true);
    await expect(readFile(join(workspace.root, "AGENTS.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("leaves an edited prior activation for manual cleanup when changing harnesses", async () => {
    await installCodex();
    const agents = join(workspace.root, "AGENTS.md");
    const edited = (await readFile(agents, "utf8")).replace(
      "Follow the VISP project instructions",
      "Keep this project-specific instruction",
    );
    await writeFile(agents, edited, "utf8");
    const state = await workspace.state();

    const result = await installHarness(state.paths, {
      harness: "generic",
      hooks: [],
      prunePreviousHarness: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manualSteps.join(" ")).toContain("edited VISP block");
    expect(await readFile(agents, "utf8")).toBe(edited);
  });
});

it("upgrades the prior block and switches to CLAUDE.md while preserving user bytes", async () => {
  const original = "before\r\n";
  await workspace.write(
    "AGENTS.md",
    original +
      "<!-- visp:instructions:start -->\nFollow the VISP project instructions in [AGENTS.visp.md](AGENTS.visp.md). Run `visp next` before editing and follow the command it prints.\n<!-- visp:instructions:end -->\nafter\r\n",
  );
  await installCodex();
  expect(await readFile(join(workspace.root, "AGENTS.md"), "utf8")).toContain("VISP.commands.md");
  await workspace.write("CLAUDE.md", "Claude user rules\r\n");
  const result = await installHarness((await workspace.state()).paths, {
    harness: "claude-code",
    hooks: [],
    prunePreviousHarness: true,
  });
  expect(result.ok).toBe(true);
  expect(await readFile(join(workspace.root, "AGENTS.md"), "utf8")).toBe(`${original}\nafter\r\n`);
  const claude = await readFile(join(workspace.root, "CLAUDE.md"), "utf8");
  expect(claude.startsWith("Claude user rules\r\n")).toBe(true);
  expect(claude).toContain("visp work --check");
});

it("upgrades the exact prior command map without treating user changes as generated content", async () => {
  const old = (
    await readFile(
      new URL("../../fixtures/harness/activation-command-map-v1.md", import.meta.url),
      "utf8",
    )
  ).trimEnd();
  const before = "Personal rules\r\n\r\n";
  const after = "\nUser footer\r\n";
  for (const harness of ["codex", "claude-code"] as const) {
    const result = planAgentActivation(harness, before + old + after, false);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.status).toBe("replaced");
    expect(result.value.content?.startsWith(before)).toBe(true);
    expect(result.value.content?.endsWith(after)).toBe(true);
    expect(result.value.content).toContain("visp done --task <id>");
    const edited = old.replace("Assess observed product behavior", "User-specific review rule");
    expect(planAgentActivation(harness, before + edited + after, false).ok).toBe(false);
    expect(planAgentDeactivation(before + edited + after).status).toBe("edited");
  }
  expect(planAgentDeactivation(`${old}\n`)).toEqual({ status: "removed", content: "" });
});

it("upgrades the pre-independent-review command map without changing surrounding user bytes", async () => {
  const prior = await readFile(
    new URL("../../fixtures/harness/activation-before-independent-review.md", import.meta.url),
    "utf8",
  );
  const prefix = "Personal notes  \r\n\r\n";
  const suffix = "\r\nKeep my custom instructions exactly.  \n";
  const plan = planAgentActivation("codex", prefix + prior + suffix, false);
  expect(plan.ok).toBe(true);
  if (!plan.ok) return;
  expect(plan.value.status).toBe("replaced");
  expect(plan.value.content).toBe(prefix + expectedActivationBlock + suffix);
});

it("upgrades the block that started every request with visp next", async () => {
  const old = await readFile(
    new URL("../../fixtures/harness/activation-before-feature-first.md", import.meta.url),
    "utf8",
  );
  expect(old).toContain("| Start or resume | `visp next` |");
  const result = planAgentActivation("claude-code", `${old}\n`, false);
  expect(result).toMatchObject({
    ok: true,
    value: { status: "replaced", content: `${expectedActivationBlock}\n` },
  });
  expect(expectedActivationBlock).toContain("| Resume a feature in progress | `visp next` |");
  expect(planAgentDeactivation(`${old}\n`)).toEqual({ status: "removed", content: "" });
});

it("upgrades the previous full command map while preserving edited blocks and user bytes", async () => {
  const old = await readFile(
    new URL("../../fixtures/harness/activation-before-compact-discovery.md", import.meta.url),
    "utf8",
  );
  const prefix = "User rules  \r\n";
  const suffix = "\nKeep this footer.  \r\n";
  const result = planAgentActivation("codex", prefix + old + suffix, false);
  expect(result).toMatchObject({
    ok: true,
    value: { content: prefix + expectedActivationBlock + suffix },
  });
  expect(
    planAgentActivation(
      "codex",
      old.replace("Independent product feedback", "My review policy"),
      false,
    ).ok,
  ).toBe(false);
  expect(planAgentDeactivation(`${old}\n`)).toEqual({ status: "removed", content: "" });
});
