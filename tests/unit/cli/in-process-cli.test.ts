import { afterEach, expect, it, vi } from "vitest";
import { TestWorkspace } from "../support/workspace.js";
import { runCli, watchStdout } from "./support/cli.js";

const workspaces: TestWorkspace[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(workspaces.splice(0).map((w) => w.destroy()));
});

/** `process.uptime()` read while the command writes its result. */
async function uptimeDuringCommand(root: string): Promise<number | undefined> {
  let seen: number | undefined;
  const stop = watchStdout(() => {
    seen ??= process.uptime();
  });
  try {
    await runCli(root, "next");
  } finally {
    stop();
  }
  return seen;
}

// The CLI's deadline counts from process start. In a full golden run the test worker had
// been up for more than 23 s, which left `done` no time for the pinned acceptance tests.
it("starts an in-process command's clock with the command, as a fresh process", async () => {
  const w = await TestWorkspace.create();
  workspaces.push(w);
  const before = process.uptime();
  const seen = await uptimeDuringCommand(w.root);
  const took = process.uptime() - before;
  expect(seen).toBeGreaterThanOrEqual(0);
  expect(seen).toBeLessThanOrEqual(took);
});

it("keeps a test's own uptime mock, which ages the command's process", async () => {
  const w = await TestWorkspace.create();
  workspaces.push(w);
  vi.spyOn(process, "uptime").mockReturnValue(1_000_000);
  expect(await uptimeDuringCommand(w.root)).toBeGreaterThan(900_000);
  expect(process.uptime()).toBe(1_000_000);
});
