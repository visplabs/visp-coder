import { GUARD_PROTOCOL_VERSION, PRODUCT_NAME } from "../core/constants.js";
import { vispError } from "../core/errors.js";
import { type CommandOutput, run } from "../core/exec.js";
import { err, type Result } from "../core/result.js";
import { requireRuntimeAgreement } from "../core/runtime-agreement.js";
import { type RuntimeIdentity, runtimeIdentity } from "../core/version.js";
import { NO_ERROR_REPORTING_ENV, runsDoctor } from "../telemetry/error-reporting.js";

export type GuardHandshakeRunner = (
  file: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly timeoutMs?: number;
    readonly env?: Record<string, string>;
  },
) => Promise<Result<CommandOutput>>;

interface GuardEnvelope {
  command?: unknown;
  ok?: unknown;
  error?: { message?: unknown; recovery?: unknown };
  data?: {
    runtime?: unknown;
    protocolVersion?: unknown;
    checked?: unknown;
    allowed?: unknown;
    violations?: unknown;
    authorizedTasks?: unknown;
  };
}

/** Proves the command used by local harness surfaces can execute this guard protocol. */
export async function verifyGuardHandshake(
  root: string,
  runner: GuardHandshakeRunner = run,
  expected: RuntimeIdentity = runtimeIdentity(),
  argv: readonly string[] = process.argv,
): Promise<Result<void>> {
  const found = await runner(
    process.execPath,
    [expected.executable, "guard", "--handshake", "--json"],
    {
      cwd: root,
      timeoutMs: 5_000,
      // Doctor never sends, so the children it starts must not either. Install's stay as they were.
      ...(runsDoctor(argv) ? { env: NO_ERROR_REPORTING_ENV } : {}),
    },
  );
  if (!found.ok)
    return err(
      handshakeError(
        `Installed VISP CLI ${expected.executable} is not runnable with Node: ${found.error.message.slice(0, 4_096)}`,
        "spawn",
      ),
    );

  const output = found.value;
  const diagnostic = (output.stderr.trim() || output.stdout.trim()).slice(-4_096);
  const details = {
    exitCode: output.exitCode,
    timedOut: output.timedOut,
    diagnostic,
    diagnosticTruncated: (output.stderr.trim() || output.stdout.trim()).length > 4_096,
  };
  if (output.timedOut)
    return err(
      handshakeError(
        `${PRODUCT_NAME} guard handshake timed out${diagnostic ? `: ${diagnostic}` : ""}`,
        "timeout",
        details,
      ),
    );

  if (output.exitCode === 0 && !output.stdout.trim())
    return err(
      handshakeError(
        `${PRODUCT_NAME} guard exited successfully but produced no handshake. Child-process execution or output forwarding may be restricted by the host; this is not evidence of a version mismatch.`,
        "empty-output",
        details,
      ),
    );

  return parseHandshake(output, diagnostic, details, expected);
}

function parseHandshake(
  output: CommandOutput,
  diagnostic: string,
  details: Record<string, unknown>,
  expected: RuntimeIdentity,
): Result<void> {
  try {
    const envelope = JSON.parse(output.stdout) as GuardEnvelope;
    const refusal = guardRefusal(envelope, details);
    if (refusal) return err(refusal);
    if (output.exitCode !== 0) return err(executionError(output.exitCode, diagnostic, details));
    return validHandshake(envelope)
      ? requireRuntimeAgreement(envelope.data?.runtime, expected)
      : err(
          handshakeError(`${PRODUCT_NAME} returned no valid guard handshake`, "protocol", details),
        );
  } catch {
    return err(
      output.exitCode !== 0
        ? executionError(output.exitCode, diagnostic, details)
        : handshakeError(
            `${PRODUCT_NAME} returned malformed guard output${diagnostic ? `: ${diagnostic}` : ""}`,
            "protocol",
            details,
          ),
    );
  }
}

function guardRefusal(envelope: GuardEnvelope, details: Record<string, unknown>) {
  if (
    envelope?.command !== "guard" ||
    envelope.ok !== false ||
    typeof envelope.error?.message !== "string"
  )
    return undefined;
  const error = handshakeError(
    `${PRODUCT_NAME} guard refused: ${envelope.error.message.slice(0, 4_096)}`,
    "guard-refusal",
    details,
  );
  return {
    ...error,
    ...(typeof envelope.error.recovery === "string"
      ? { recovery: envelope.error.recovery.slice(0, 4_096) }
      : {}),
  };
}

function validHandshake(envelope: GuardEnvelope): boolean {
  return (
    envelope?.command === "guard" &&
    envelope.ok === true &&
    envelope.data?.protocolVersion === GUARD_PROTOCOL_VERSION &&
    envelope.data?.checked === 0 &&
    envelope.data.allowed === true &&
    Array.isArray(envelope.data.violations) &&
    envelope.data.violations.length === 0 &&
    Array.isArray(envelope.data.authorizedTasks) &&
    envelope.data.authorizedTasks.every((task) => typeof task === "string")
  );
}

function executionError(exitCode: number, diagnostic: string, details: Record<string, unknown>) {
  return handshakeError(
    `${PRODUCT_NAME} guard exited with code ${exitCode}${diagnostic ? `: ${diagnostic}` : ""}`,
    "execution",
    details,
  );
}

function handshakeError(message: string, failure: string, details: Record<string, unknown> = {}) {
  return vispError("COMMAND_FAILED", message, {
    recovery:
      failure === "protocol"
        ? `Run ${PRODUCT_NAME} guard --handshake --json in the same environment and inspect its output. Check which ${PRODUCT_NAME} executable is on PATH and its version; update it only if it does not support guard protocol ${GUARD_PROTOCOL_VERSION}.`
        : `Run ${PRODUCT_NAME} guard --handshake --json in the same environment. Check PATH, the reported process error, and host execution permissions; request the host's supported permission recovery when execution is restricted.`,
    details: { failure, ...details },
  });
}
