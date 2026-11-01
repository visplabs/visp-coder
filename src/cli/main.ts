import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { EXIT, PACKAGE_NAME } from "../core/constants.js";
import { fromUnknown, vispError } from "../core/errors.js";
import { reportError, startErrorReporting } from "../telemetry/error-reporting.js";
import { emitError } from "./output.js";
import { buildProgram } from "./program.js";

export { buildProgram } from "./program.js";

export async function main(argv: readonly string[]): Promise<number> {
  ignoreClosedOutput();
  const program = buildProgram();

  try {
    await program.parseAsync([...argv]);
    return typeof process.exitCode === "number" ? process.exitCode : EXIT.ok;
  } catch (cause) {
    if (isCommanderExit(cause)) {
      if (cause.exitCode === 0) return EXIT.ok;
      return emitError(
        PACKAGE_NAME,
        vispError("UNSUPPORTED", cause.message ?? "Invalid command line"),
        {
          json: argv.includes("--json"),
        },
      );
    }
    await reportError(cause);
    return emitError(PACKAGE_NAME, fromUnknown(cause), {
      json: argv.includes("--json"),
    });
  }
}

/**
 * Piping into a reader that exits early (`| head`) closes our stdout. Writing
 * then raises EPIPE, which is normal for a CLI and must not look like a crash.
 */
function ignoreClosedOutput(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") throw error;
    });
  }
}

interface CommanderExit {
  readonly code: string;
  readonly exitCode: number;
  readonly message?: string;
}

function isCommanderExit(cause: unknown): cause is CommanderExit {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof (cause as { code: unknown }).code === "string" &&
    (cause as { code: string }).code.startsWith("commander.")
  );
}

/**
 * True only when this module *is* the program being run.
 *
 * A substring match on argv[1] was not that: any invocation whose entry path
 * merely contained "cli" — a checkout under `cli-tools/`, a test runner's
 * worker script — fired the whole CLI on import, printed help and exited.
 * Comparing the resolved URLs asks the actual question.
 *
 * Resolved on both sides, because a package manager installs a bin as a
 * symlink: argv[1] is the link in `node_modules/.bin`, `import.meta.url` is
 * its target. Comparing them unresolved asks "was this invoked by its real
 * path", which is false for every global install — so the CLI parsed nothing,
 * printed nothing and exited 0, and a hook reading that silence as consent
 * would have allowed every write unchecked.
 */
const isEntrypoint = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  startErrorReporting()
    .then(() => main(process.argv))
    .then((code) => {
      process.exitCode = code;
    });
}
