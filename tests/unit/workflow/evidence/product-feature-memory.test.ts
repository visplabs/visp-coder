import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { TestWorkspace } from "../../support/workspace.js";

// The model calls are replaced: these tests cover which path `visp feature` takes.
const gate = vi.fn();
const gateModel = vi.fn();
vi.mock("../../../../src/workflow/product/memory-gate.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  reviewerMemoryGate: (reviewer: unknown) => {
    gateModel(reviewer);
    return gate;
  },
}));
vi.mock("../../../../src/workflow/product/rule-extraction.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  reviewerRuleExtractor: () => async () => [],
}));

const { createProductFeature } = await import("../../../../src/workflow/product/feature-create.js");

let workspace: TestWorkspace | undefined;

afterEach(() => {
  gate.mockReset();
  gateModel.mockReset();
  workspace = undefined;
});

async function project(memory: Record<string, unknown>, critic?: Record<string, unknown>) {
  workspace = await TestWorkspace.create(
    { "src/items.ts": "export const items = 1;\n" },
    {
      critic: Boolean(critic),
    },
  );
  await workspace.installFoundation();
  const config = parse(await readFile(join(workspace.root, "visp.yml"), "utf8"));
  config.memory = { ...config.memory, ...memory };
  if (critic) config.critic = { ...config.critic, ...critic };
  await workspace.write("visp.yml", stringify(config));
  await workspace.write(".gitignore", ".visp/session/\n");
  workspace.commit("configure memory");
}

async function feature(goal: string, prompt: string) {
  if (!workspace) throw new Error("no workspace");
  await mkdir(join(workspace.root, ".visp/session"), { recursive: true });
  await writeFile(
    join(workspace.root, ".visp/session/user-prompts.jsonl"),
    `${JSON.stringify({ at: new Date().toISOString(), prompt })}\n`,
  );
  const created = await createProductFeature(await workspace.state(), { goal, branch: false });
  if (!created.ok) throw new Error(created.error.message);
  workspace.commit(goal);
  return created.value;
}

const REVIEWER = { enabled: true, harness: "codex", launch: "codex-exec" };
const ARCHIVING = "Add archiving.\n\n1. An archived item cannot be reserved: 409 item_archived.";

describe("recall of earlier requests", () => {
  it("gives the reviewer's model every recorded note and carries what it chooses", async () => {
    await project({}, REVIEWER);
    gate.mockResolvedValue(["1. An archived item cannot be reserved: 409 item_archived."]);
    await feature("Archive items", ARCHIVING);
    const second = await feature("Restock", "Add restocking.");
    expect(gate).toHaveBeenLastCalledWith(
      expect.stringContaining("Add restocking."),
      // "Add archiving." is too short to record as a decision.
      ["1. An archived item cannot be reserved: 409 item_archived."],
      [],
      expect.any(Array),
    );
    expect(second.projectMemory).toEqual([
      "1. An archived item cannot be reserved: 409 item_archived.",
    ]);
    const history = JSON.parse(
      await readFile(join(workspace?.root ?? "", ".visp/state/request-history.json"), "utf8"),
    );
    expect(history.requests.map((request: { feature: string }) => request.feature)).toHaveLength(1);
  });

  it("carries nothing when the model fails", async () => {
    await project({}, REVIEWER);
    gate.mockRejectedValue(new Error("offline"));
    await feature("Archive items", ARCHIVING);
    const second = await feature("Restock", "Add restocking.");
    expect(second.projectMemory).toBeUndefined();
  });

  // Bench batch co1 (claude-exec): no second session was given an earlier decision, and
  // co1-archive-carryover-visp-dev-2 failed 4 of 7 memory checks without the restock cap.
  it("recalls with a VISP-launched Claude reviewer, using its model", async () => {
    await project(
      {},
      { enabled: true, harness: "claude-code", launch: "claude-exec", model: "claude-sonnet-5-5" },
    );
    gate.mockResolvedValue(["1. An archived item cannot be reserved: 409 item_archived."]);
    await feature("Archive items", ARCHIVING);
    const second = await feature("Restock", "Add restocking.");
    expect(gateModel).toHaveBeenLastCalledWith({
      launch: "claude-exec",
      model: "claude-sonnet-5-5",
    });
    expect(second.projectMemory).toEqual([
      "1. An archived item cannot be reserved: 409 item_archived.",
    ]);
    await expect(
      readFile(join(workspace?.root ?? "", ".visp/state/request-history.json"), "utf8"),
    ).resolves.toContain("001-");
  });

  // VISP calls a model only when the project lets it launch the reviewer.
  it("does not recall with a reviewer the host runs", async () => {
    await project({}, { enabled: true, harness: "claude-code" });
    await feature("Archive items", ARCHIVING);
    expect((await feature("Restock", "Add restocking.")).projectMemory).toBeUndefined();
    expect(gate).not.toHaveBeenCalled();
  });

  // Review: memory.enabled: false must switch off the long-term store too.
  it("does not recall when memory is turned off", async () => {
    await project({ enabled: false }, REVIEWER);
    await feature("Archive items", ARCHIVING);
    expect((await feature("Restock", "Add restocking.")).projectMemory).toBeUndefined();
    expect(gate).not.toHaveBeenCalled();
  });

  it("does not recall without a reviewer model or when recall is off", async () => {
    await project({}, undefined);
    await feature("Archive items", ARCHIVING);
    expect((await feature("Restock", "Add restocking.")).projectMemory).toBeUndefined();
    await project({ recall: false }, REVIEWER);
    await feature("Archive items", ARCHIVING);
    expect((await feature("Restock", "Add restocking.")).projectMemory).toBeUndefined();
    expect(gate).not.toHaveBeenCalled();
  });
});

describe("code changed after the decisions were recorded", () => {
  const LIMIT = "1. Items hold at most 10,000 units.";
  const CREATION = "Add item creation.\n\n1. Items hold at most 10,000 units.";

  /** An outside commit lands between the sessions, as when a person raises the limit by hand. */
  async function raiseLimit() {
    if (!workspace) throw new Error("no workspace");
    await workspace.write("src/items.ts", "export const items = 50000;\n");
    workspace.commit("Raise the item limit to 50000 units");
  }

  it("gives the gate the commits and lists them under the carried notes", async () => {
    await project({}, REVIEWER);
    gate.mockResolvedValue([LIMIT]);
    await feature("Create items", CREATION);
    await raiseLimit();
    const second = await feature("Restock", "Add restocking.");
    const later = gate.mock.calls.at(-1)?.[3] as string[];
    expect(
      later.some((line) => /^[0-9a-f]{7,} Raise the item limit to 50000 units$/.test(line)),
    ).toBe(true);
    expect(second.projectMemory).toEqual([LIMIT]);
    expect(second.projectMemoryLaterChanges).toEqual(later);
    expect(second.brief.originalRequest).toContain(`M1 ${LIMIT}`);
    expect(second.brief.originalRequest).toContain(
      "Later changes to the code since these were recorded (newest first):",
    );
    expect(second.brief.originalRequest).toContain("Raise the item limit to 50000 units");
    expect(second.brief.originalRequest).toContain(
      "apply the decision with the current code's value",
    );
    // The work replies carry the same list, not only the fixed request.
    const stored = JSON.parse(
      await readFile(
        join(workspace?.root ?? "", `.visp/features/${second.brief.feature}/project-memory.json`),
        "utf8",
      ),
    );
    expect(stored.laterChanges).toEqual(later);
  });

  it("lists nothing when the gate drops every note the later change replaced", async () => {
    await project({}, REVIEWER);
    gate.mockResolvedValue([]);
    await feature("Create items", CREATION);
    await raiseLimit();
    const second = await feature("Restock", "Add restocking.");
    expect(gate.mock.calls.at(-1)?.[3]).toEqual(
      expect.arrayContaining([expect.stringContaining("Raise the item limit")]),
    );
    expect(second.projectMemory).toBeUndefined();
    expect(second.projectMemoryLaterChanges).toBeUndefined();
    expect(second.brief.originalRequest).not.toContain("Later changes");
  });

  it("does not affect the first feature, which has no earlier request", async () => {
    await project({}, REVIEWER);
    gate.mockResolvedValue([]);
    const first = await feature("Create items", CREATION);
    expect(first.projectMemory).toBeUndefined();
    expect(first.projectMemoryLaterChanges).toBeUndefined();
    expect(first.brief.originalRequest).not.toContain("Later changes");
  });
});
