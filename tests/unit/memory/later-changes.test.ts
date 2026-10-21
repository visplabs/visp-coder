import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { laterChanges } from "../../../src/memory/later-changes.js";
import type { EarlierFeature } from "../../../src/memory/project-memory.js";
import type { WorkspaceState } from "../../../src/workflow/state.js";
import { TestWorkspace } from "../support/workspace.js";

/**
 * A decision recorded in an earlier session can be replaced by a commit made outside VISP
 * ("Raise the item limit to 50000 units"). Recall lists the commits newer than the earliest
 * earlier feature so the gate, the worker and the reviewer can weigh the notes against them.
 */
let workspace: TestWorkspace | undefined;
let stray: string | undefined;

afterEach(async () => {
  await workspace?.destroy();
  if (stray) await rm(stray, { recursive: true, force: true });
  workspace = undefined;
  stray = undefined;
});

function earlier(createdAt: string | undefined): EarlierFeature[] {
  return [
    {
      feature: "001-items",
      goal: "Items",
      originalRequest: "Items hold at most 10,000 units.",
      ...(createdAt ? { createdAt } : {}),
    },
  ];
}

let counter = 0;

/** A commit changing a source file, with a chosen committer date, so which side of the feature it falls on is exact. */
function commitAt(w: TestWorkspace, date: string, message: string, path?: string): void {
  counter += 1;
  writeFileSync(join(w.root, path ?? `change-${counter}.txt`), `${counter}\n`);
  w.git("add", "-f", "-A");
  const saved = process.env.GIT_COMMITTER_DATE;
  process.env.GIT_COMMITTER_DATE = date;
  try {
    w.git("commit", "-q", "-m", message);
  } finally {
    if (saved === undefined) delete process.env.GIT_COMMITTER_DATE;
    else process.env.GIT_COMMITTER_DATE = saved;
  }
}

describe("laterChanges", () => {
  it("lists the commits made after the earliest earlier feature, newest first", async () => {
    workspace = await TestWorkspace.create();
    commitAt(workspace, "2019-12-31T00:00:00Z", "Before the feature");
    commitAt(workspace, "2020-06-01T00:00:00Z", "Raise the item limit to 50000 units");
    commitAt(workspace, "2020-07-01T00:00:00Z", "Show item counts");
    const listed = await laterChanges(await workspace.state(), earlier("2020-01-01T00:00:00.000Z"));
    expect(listed.filter((line) => !/ (initial|add visp)$/.test(line))).toEqual([
      expect.stringMatching(/^[0-9a-f]{7,} Show item counts$/),
      expect.stringMatching(/^[0-9a-f]{7,} Raise the item limit to 50000 units$/),
    ]);
    expect(listed.join("\n")).not.toContain("Before the feature");
  });

  it("measures from the earliest of several earlier features", async () => {
    workspace = await TestWorkspace.create();
    commitAt(workspace, "2020-03-01T00:00:00Z", "Between the two features");
    const features = [
      ...earlier("2020-06-01T00:00:00.000Z"),
      {
        feature: "000-first",
        goal: "First",
        originalRequest: "x",
        createdAt: "2020-01-01T00:00:00.000Z",
      },
    ];
    expect((await laterChanges(await workspace.state(), features)).join("\n")).toContain(
      "Between the two features",
    );
  });

  it("lists nothing when no commit came after the feature was created", async () => {
    workspace = await TestWorkspace.create();
    expect(
      await laterChanges(await workspace.state(), earlier("2100-01-01T00:00:00.000Z")),
    ).toEqual([]);
  });

  it("lists nothing without a usable creation time", async () => {
    workspace = await TestWorkspace.create();
    const state = await workspace.state();
    expect(await laterChanges(state, earlier(undefined))).toEqual([]);
    expect(await laterChanges(state, earlier("not a date"))).toEqual([]);
    expect(await laterChanges(state, [])).toEqual([]);
  });

  it("lists nothing when Git fails", async () => {
    workspace = await TestWorkspace.create();
    stray = await mkdtemp(join(tmpdir(), "visp-not-a-repository-"));
    const outside = { paths: { root: stray } } as unknown as WorkspaceState;
    expect(await laterChanges(outside, earlier("2020-01-01T00:00:00.000Z"))).toEqual([]);
  });

  it("keeps the newest twenty, masks secrets, and bounds each subject", async () => {
    workspace = await TestWorkspace.create();
    for (let index = 1; index <= 22; index += 1)
      commitAt(workspace, `2020-06-${String(index).padStart(2, "0")}T00:00:00Z`, `Change ${index}`);
    commitAt(workspace, "2020-07-01T00:00:00Z", `Set api_key=hunter2hunter2 ${"long ".repeat(60)}`);
    const listed = await laterChanges(await workspace.state(), earlier("2020-01-01T00:00:00.000Z"));
    expect(listed).toHaveLength(20);
    expect(listed[0]).toContain("api_key=[REDACTED]");
    expect(listed[0]).not.toContain("hunter2");
    expect(listed[0]?.length).toBeLessThan(140);
    expect(listed.join("\n")).not.toMatch(/Change (1|2|3)$/m);
  });

  it("skips merge commits, whose subjects only name a branch", async () => {
    workspace = await TestWorkspace.create();
    workspace.git("checkout", "-q", "-b", "side");
    commitAt(workspace, "2020-06-01T00:00:00Z", "Side work");
    workspace.git("checkout", "-q", "main");
    commitAt(workspace, "2020-06-02T00:00:00Z", "Main work");
    workspace.git("merge", "-q", "--no-ff", "-m", "Merge branch side", "side");
    const listed = (
      await laterChanges(await workspace.state(), earlier("2020-01-01T00:00:00.000Z"))
    ).join("\n");
    expect(listed).toContain("Side work");
    expect(listed).toContain("Main work");
    expect(listed).not.toContain("Merge branch");
  });

  it("keeps an outside commit that many commits of VISP's own state would push out", async () => {
    workspace = await TestWorkspace.create();
    commitAt(workspace, "2020-06-01T00:00:00Z", "Raise the item limit to 50000 units");
    mkdirSync(join(workspace.root, ".visp/state"), { recursive: true });
    for (let index = 1; index <= 12; index += 1)
      commitAt(
        workspace,
        `2020-07-${String(index).padStart(2, "0")}T00:00:00Z`,
        `Record state ${index}`,
        `.visp/state/note-${index}.json`,
      );
    const listed = (
      await laterChanges(await workspace.state(), earlier("2020-01-01T00:00:00.000Z"))
    ).join("\n");
    expect(listed).toContain("Raise the item limit to 50000 units");
    expect(listed).not.toContain("Record state");
  });

  it("keeps a commit that changes code and VISP's state together", async () => {
    workspace = await TestWorkspace.create();
    mkdirSync(join(workspace.root, ".visp/state"), { recursive: true });
    writeFileSync(join(workspace.root, ".visp/state/note.json"), "1\n");
    commitAt(workspace, "2020-06-01T00:00:00Z", "Code with state");
    expect(
      (await laterChanges(await workspace.state(), earlier("2020-01-01T00:00:00.000Z"))).join("\n"),
    ).toContain("Code with state");
  });
});
