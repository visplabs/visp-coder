import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { launchChrome } from "../../../src/testing/chrome-transport.js";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Chrome's launcher script starts helpers (and a `cat` on stderr) that outlive the leader and
// keep the other end of visp's stderr socket open: visp printed its result and never exited.
it.skipIf(process.platform === "win32")(
  "ends every process a failed browser started and releases its stderr",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "visp-fake-chrome-"));
    const pids = join(directory, "pids");
    const binary = join(directory, "chrome");
    // The helper ignores SIGTERM and holds stderr; the leader never reports a debugging port.
    await writeFile(
      binary,
      `#!/bin/sh\n(trap '' TERM; exec sleep 300) &\necho $! >> '${pids}'\necho "cannot start" >&2\nwhile :; do sleep 1; done\n`,
    );
    await chmod(binary, 0o755);
    const pipesBefore = process
      .getActiveResourcesInfo()
      .filter((name) => name === "PipeWrap").length;
    const started = Date.now();
    await expect(
      launchChrome({ binary, startupTimeoutMs: 800, startupRetries: 0 }),
    ).rejects.toThrow(/Browser unavailable/);
    expect(Date.now() - started).toBeLessThan(8_000);
    const helpers = (await readFile(pids, "utf8")).trim().split("\n").map(Number);
    expect(helpers).toHaveLength(1);
    // Killed and reaped shortly after (it may still be a zombie for an instant).
    for (let waited = 0; alive(helpers[0] ?? 0) && waited < 50; waited += 1)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive(helpers[0] ?? 0)).toBe(false);
    expect(
      process.getActiveResourcesInfo().filter((name) => name === "PipeWrap").length,
    ).toBeLessThanOrEqual(pipesBefore);
    // pgrep exits 1 when nothing matches: the launcher and its loop are gone too.
    expect(spawnSync("pgrep", ["-f", binary]).status).toBe(1);
  },
);
