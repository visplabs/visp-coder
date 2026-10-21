import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { access } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { launchChrome } from "../../../src/testing/chrome-transport.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
let child: ChildProcess;
beforeEach(() => {
  child = Object.assign(new EventEmitter(), {
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    pid: undefined,
    kill: vi.fn(),
  }) as unknown as ChildProcess;
});
afterEach(() => vi.restoreAllMocks());

describe("Chrome startup diagnostics", () => {
  it("retains the stderr and exit code from a real failing child process", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    vi.mocked(spawn).mockImplementation(actual.spawn);
    // Node is an installed executable that rejects Chrome's arguments immediately.
    await expect(launchChrome({ binary: process.execPath })).rejects.toThrow(
      /exit code 9.*bad option/s,
    );
  });
  it("reports the selected executable, exit status and bounded stderr without suggesting a missing binary", async () => {
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => {
        child.stderr?.emit(
          "data",
          Buffer.from(`${"x".repeat(12_000)}\nNo usable sandbox: Operation not permitted\n`),
        );
        child.emit("exit", 1, null);
        child.emit("close", 1, null);
      });
      return child;
    });
    const failure = await launchChrome({ binary: "/installed/chromium" }).catch(
      (error: Error) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("Expected startup failure");
    expect(failure.message).toContain("/installed/chromium");
    expect(failure.message).toContain("exit code 1");
    expect(failure.message).toContain("No usable sandbox: Operation not permitted");
    expect(failure.message).toContain("truncated");
    expect(failure.message).not.toContain("Set CHROME_BIN");
    expect(failure.message.length).toBeLessThan(9_000);
    const args = vi.mocked(spawn).mock.calls[0]?.[1] as string[];
    expect(args).not.toContain("--no-sandbox");
    const profile = args.find((arg) => arg.startsWith("--user-data-dir="))?.split("=")[1];
    await expect(access(profile ?? "")).rejects.toThrow();
  });

  it("reserves binary selection recovery for a missing executable", async () => {
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() =>
        child.emit(
          "error",
          Object.assign(new Error("spawn /missing/chromium ENOENT"), { code: "ENOENT" }),
        ),
      );
      return child;
    });
    await expect(launchChrome({ binary: "/missing/chromium" })).rejects.toThrow(
      /\/missing\/chromium.*--binary.*CHROME_BIN/s,
    );
  });

  it("keeps stderr when startup times out and distinguishes execution permission failure", async () => {
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() =>
        child.stderr?.emit("data", Buffer.from("Waiting for sandbox initialization")),
      );
      return child;
    });
    await expect(
      launchChrome({ binary: "/installed/chromium", startupTimeoutMs: 20 }),
    ).rejects.toThrow(/timed out.*Waiting for sandbox initialization/s);
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() =>
        child.emit("error", Object.assign(new Error("spawn EPERM"), { code: "EPERM" })),
      );
      return child;
    });
    await expect(launchChrome({ binary: "/installed/chromium" })).rejects.toMatchObject({
      kind: "permissions",
      message: expect.stringMatching(/EPERM.*permission/s),
    });
  });

  it("turns the GPU off only for a caller that asks, since journeys may need WebGL", async () => {
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => child.emit("error", new Error("stop")));
      return child;
    });
    await launchChrome({ binary: "/installed/chromium", gpu: false }).catch(() => undefined);
    await launchChrome({ binary: "/installed/chromium" }).catch(() => undefined);
    const [software, usual] = vi.mocked(spawn).mock.calls.map((call) => call[1] as string[]);
    expect(software).toContain("--disable-gpu");
    expect(usual).not.toContain("--disable-gpu");
  });
});
