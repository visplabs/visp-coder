import { describe, expect, it, vi } from "vitest";
import { GUARD_PROTOCOL_VERSION } from "../../../src/core/constants.js";
import { vispError } from "../../../src/core/errors.js";
import type { CommandOutput } from "../../../src/core/exec.js";
import { err, ok } from "../../../src/core/result.js";
import { runtimeIdentity } from "../../../src/core/version.js";
import {
  type GuardHandshakeRunner,
  verifyGuardHandshake,
} from "../../../src/harness/guard-handshake.js";

describe("guard handshake", () => {
  it("distinguishes an empty successful child from a protocol version mismatch", async () => {
    const result = await verifyGuardHandshake("/project", async () =>
      ok({
        command: "visp guard",
        stdout: "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        details: { failure: "empty-output" },
        message: expect.stringContaining("not evidence of a version mismatch"),
        recovery: expect.stringContaining("host execution permissions"),
      },
    });
  });
  it("accepts the current protocol and invokes the project guard without requiring a task", async () => {
    const runner = vi.fn<GuardHandshakeRunner>(async () =>
      command({
        command: "guard",
        ok: true,
        data: {
          runtime: runtimeIdentity(),
          protocolVersion: GUARD_PROTOCOL_VERSION,
          checked: 0,
          allowed: true,
          violations: [],
          authorizedTasks: [],
        },
      }),
    );

    const result = await verifyGuardHandshake("/project", runner);

    expect(result.ok).toBe(true);
    expect(runner).toHaveBeenCalledWith(
      process.execPath,
      [runtimeIdentity().executable, "guard", "--handshake", "--json"],
      {
        cwd: "/project",
        timeoutMs: 5_000,
        env: { VISP_SENTRY_DSN: "" },
      },
    );
  });

  const expectedRuntime = {
    version: "0.4.0-beta.3",
    buildId: "1234567890abcdef",
    executable: "/mcp/visp.js",
  };
  it.each([
    { label: "missing runtime", runtime: undefined },
    {
      label: "different build with the same version",
      runtime: { ...expectedRuntime, buildId: "abcdef1234567890" },
    },
    { label: "different version", runtime: { ...expectedRuntime, version: "0.3.0" } },
    { label: "unidentified build", runtime: { ...expectedRuntime, buildId: "dev" } },
  ])("rejects a valid guard protocol with $label", async ({ runtime }) => {
    const result = await verifyGuardHandshake(
      "/project",
      async () =>
        command({
          command: "guard",
          ok: true,
          data: {
            protocolVersion: GUARD_PROTOCOL_VERSION,
            checked: 0,
            allowed: true,
            violations: [],
            authorizedTasks: [],
            runtime,
          },
        }),
      expectedRuntime,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "RUNTIME_MISMATCH", recovery: expect.stringContaining("restart") },
    });
  });
  it("does not treat two unbuilt development runtimes as established agreement", async () => {
    const unknown = { ...expectedRuntime, buildId: "dev", version: "0.0.0-dev" };
    expect(
      await verifyGuardHandshake(
        "/project",
        async () =>
          command({
            command: "guard",
            ok: true,
            data: {
              protocolVersion: GUARD_PROTOCOL_VERSION,
              checked: 0,
              allowed: true,
              violations: [],
              authorizedTasks: [],
              runtime: unknown,
            },
          }),
        unknown,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "RUNTIME_MISMATCH", details: { failure: "runtime-unidentified" } },
    });
  });
  it("permits different executable paths for the same identified build", async () => {
    expect(
      await verifyGuardHandshake(
        "/project",
        async () =>
          command({
            command: "guard",
            ok: true,
            data: {
              protocolVersion: GUARD_PROTOCOL_VERSION,
              checked: 0,
              allowed: true,
              violations: [],
              authorizedTasks: [],
              runtime: { ...expectedRuntime, executable: "/cli/visp.js" },
            },
          }),
        expectedRuntime,
      ),
    ).toMatchObject({ ok: true });
  });

  it.each([
    {
      label: "legacy protocol even with a matching identity",
      exitCode: 0,
      envelope: {
        command: "guard",
        ok: true,
        data: {
          protocolVersion: 1,
          runtime: runtimeIdentity(),
          checked: 0,
          allowed: true,
          violations: [],
          authorizedTasks: [],
        },
      },
    },
    {
      label: "old protocol",
      exitCode: 0,
      envelope: {
        command: "guard",
        ok: true,
        data: {
          protocolVersion: 0,
          checked: 0,
          allowed: true,
          violations: [],
          authorizedTasks: [],
        },
      },
    },
    {
      label: "incomplete payload",
      exitCode: 0,
      envelope: { command: "guard", ok: true },
    },
    {
      label: "non-zero execution",
      exitCode: 1,
      envelope: {
        command: "guard",
        ok: true,
        data: {
          protocolVersion: GUARD_PROTOCOL_VERSION,
          checked: 0,
          allowed: true,
          violations: [],
          authorizedTasks: [],
        },
      },
    },
  ])("rejects a $label response", async ({ exitCode, envelope }) => {
    const result = await verifyGuardHandshake("/project", async () => command(envelope, exitCode));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("COMMAND_FAILED");
  });

  it("turns an unavailable executable into a structured command failure", async () => {
    const result = await verifyGuardHandshake("/project", async () =>
      err(vispError("COMMAND_FAILED", "spawn ENOENT")),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: "COMMAND_FAILED",
        recovery: expect.stringContaining("PATH"),
      });
    }
  });

  it("retains a subprocess failure instead of calling it malformed protocol output", async () => {
    const result = await verifyGuardHandshake("/project", async () =>
      ok({
        command: "visp guard",
        exitCode: 1,
        stdout: "",
        stderr: "Operation not permitted",
        timedOut: false,
        durationMs: 1,
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        message: expect.stringContaining("Operation not permitted"),
        details: { exitCode: 1, failure: "execution" },
      },
    });
    expect(!result.ok && result.error.recovery).not.toContain("npm install");
  });

  it("retains structured guard refusals and their project recovery", async () => {
    const result = await verifyGuardHandshake("/project", async () =>
      command(
        {
          command: "guard",
          ok: false,
          error: {
            code: "STATE_BUSY",
            message: "Another writer owns the worktree",
            recovery: "Retry after the writer finishes",
          },
        },
        1,
      ),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        message: expect.stringContaining("Another writer"),
        recovery: "Retry after the writer finishes",
      },
    });
  });

  it("distinguishes a timeout and bounds untrusted process diagnostics", async () => {
    const result = await verifyGuardHandshake("/project", async () =>
      ok({
        command: "visp guard",
        exitCode: 1,
        stdout: "",
        stderr: "x".repeat(20_000),
        timedOut: true,
        durationMs: 5_000,
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        message: expect.stringContaining("timed out"),
        details: { failure: "timeout", diagnosticTruncated: true },
      },
    });
    expect(!result.ok && result.error.message.length).toBeLessThan(4_500);
  });

  it.each(["not JSON", "null", '{"command":"guard","ok":false,"error":{"message":23}}'])(
    "rejects unsupported successful output %s without claiming a valid guard",
    async (stdout) => {
      const result = await verifyGuardHandshake("/project", async () =>
        ok({
          command: "visp guard",
          exitCode: 0,
          stdout,
          stderr: "",
          timedOut: false,
          durationMs: 1,
        }),
      );
      expect(result).toMatchObject({
        ok: false,
        error: { details: { failure: "protocol" }, recovery: expect.stringContaining("version") },
      });
    },
  );

  it("uses execution diagnostics when a refusal has no recovery text", async () => {
    const result = await verifyGuardHandshake("/project", async () =>
      command(
        { command: "guard", ok: false, error: { message: "Project configuration is unreadable" } },
        1,
      ),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        message: expect.stringContaining("Project configuration"),
        recovery: expect.stringContaining("same environment"),
      },
    });
  });
});

function command(envelope: unknown, exitCode = 0) {
  const output: CommandOutput = {
    command: "visp guard",
    exitCode,
    stdout: `${JSON.stringify(envelope)}\n`,
    stderr: "",
    timedOut: false,
    durationMs: 1,
  };
  return ok(output);
}
