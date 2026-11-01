import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { inspectStateLock } from "../../../../src/core/state-lock.js";
import { TestWorkspace } from "../../support/workspace.js";

// The model call is replaced: these tests cover which path `visp feature` takes.
const extractor = vi.fn();
const extractorModel = vi.fn();
vi.mock("../../../../src/workflow/product/rule-extraction.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  reviewerRuleExtractor: (reviewer: unknown) => {
    extractorModel(reviewer);
    return extractor;
  },
}));

const { createProductFeature } = await import("../../../../src/workflow/product/feature-create.js");

let workspace: TestWorkspace | undefined;

afterEach(() => {
  extractor.mockReset();
  extractorModel.mockReset();
  workspace = undefined;
});

async function project(critic?: Record<string, unknown>, profile?: "lean" | "full") {
  workspace = await TestWorkspace.create(
    { "src/items.ts": "export const items = 1;\n" },
    { critic: Boolean(critic), ...(profile ? { profile } : {}) },
  );
  await workspace.installFoundation();
  if (critic) {
    const config = parse(await readFile(join(workspace.root, "visp.yml"), "utf8"));
    config.critic = { ...config.critic, ...critic };
    await workspace.write("visp.yml", stringify(config));
  }
  await workspace.write(".gitignore", ".visp/session/\n");
  workspace.commit("configure");
}

async function feature(goal: string, ...prompts: string[]) {
  if (!workspace) throw new Error("no workspace");
  await mkdir(join(workspace.root, ".visp/session"), { recursive: true });
  await writeFile(
    join(workspace.root, ".visp/session/user-prompts.jsonl"),
    prompts
      .map((prompt) => `${JSON.stringify({ at: new Date().toISOString(), prompt })}\n`)
      .join(""),
  );
  const created = await createProductFeature(await workspace.state(), { goal, branch: false });
  if (!created.ok) throw new Error(created.error.message);
  workspace.commit(goal);
  return created.value;
}

async function recorded(): Promise<string[]> {
  if (!workspace) throw new Error("no workspace");
  const text = await readFile(join(workspace.root, ".visp/rules.json"), "utf8");
  return (JSON.parse(text) as { rules: { text: string }[] }).rules.map((rule) => rule.text);
}

it("records rules by phrase matching when no reviewer model reads them", async () => {
  await project();
  const first = await feature("List items", "From now on, never log request bodies.");
  expect(first.projectRules?.map((rule) => rule.text)).toEqual([
    "From now on, never log request bodies.",
  ]);
  expect(extractor).not.toHaveBeenCalled();
  const second = await feature("Add prices", "Add prices to items.");
  expect(second.brief.originalRequest).toBe("Add prices to items.");
  expect(await recorded()).toEqual(["From now on, never log request bodies."]);
});

it("records the rules the reviewer's model quotes from all recorded prompts", async () => {
  await project({ enabled: true, harness: "codex", launch: "codex-exec" });
  extractor.mockResolvedValue([
    { rule: "Use four spaces for indentation.", quote: "from now on use four spaces" },
    { rule: "Invented rule.", quote: "nothing like this was said" },
  ]);
  await feature("Indent", "From now on, use tabs.", "Scratch that: from now on use four spaces.");
  expect(extractor).toHaveBeenCalledWith([
    "From now on, use tabs.",
    "Scratch that: from now on use four spaces.",
  ]);
  expect(await recorded()).toEqual(["Use four spaces for indentation."]);
});

// Phrase matching found 4 of 18 rule statements in a held-out set; the model found 18.
it("reads the rules with a VISP-launched Claude reviewer's model", async () => {
  await project({
    enabled: true,
    harness: "claude-code",
    launch: "claude-exec",
    model: "claude-sonnet-5-5",
  });
  extractor.mockResolvedValue([
    { rule: "Every money field ends in Cents.", quote: "money fields end in Cents" },
  ]);
  await feature("Prices", "House style for this API: money fields end in Cents.");
  expect(extractorModel).toHaveBeenCalledWith({
    launch: "claude-exec",
    model: "claude-sonnet-5-5",
  });
  expect(await recorded()).toEqual(["Every money field ends in Cents."]);
});

// On 8 held-out prompts Haiku 5.5 found the 15 rules Sonnet 5.5 found, at a tenth of the cost.
it("reads a lean feature's rules with the lean reviewer model", async () => {
  await project(
    { enabled: true, harness: "claude-code", launch: "claude-exec", model: "claude-sonnet-5-5" },
    "lean",
  );
  extractor.mockResolvedValue([]);
  await feature("Prices", "House style for this API: money fields end in Cents.");
  expect(extractorModel).toHaveBeenCalledWith({ launch: "claude-exec", model: "claude-haiku-5-5" });
});

it("falls back to phrase matching when the model fails", async () => {
  await project({ enabled: true, harness: "codex", launch: "codex-exec" });
  extractor.mockRejectedValue(new Error("offline"));
  await feature("List items", "Going forward, every endpoint logs the request id.");
  expect(await recorded()).toEqual(["Going forward, every endpoint logs the request id."]);
});

it("runs the rule extractor unlocked after checking the clean baseline", async () => {
  await project({ enabled: true, harness: "codex", launch: "codex-exec" });
  let ownership: unknown;
  extractor.mockImplementation(async () => {
    if (!workspace) throw new Error("no workspace");
    ownership = await inspectStateLock(workspace.root);
    await workspace.write(".model-log", "model call\n");
    return [];
  });
  await feature("List items", "Always use tabs from now on.");
  expect(extractor).toHaveBeenCalled();
  expect(ownership).toMatchObject({ ok: true, value: { state: "unlocked" } });
});
