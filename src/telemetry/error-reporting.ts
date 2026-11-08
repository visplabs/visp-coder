import { appendFileSync } from "node:fs";
import { VERSION } from "../core/version.js";

type Sentry = typeof import("@sentry/node");

let sentry: Sentry | undefined;

/**
 * Crash reports go to Sentry only when the operator sets VISP_SENTRY_DSN.
 * SENTRY_DSN is never read: VISP runs inside the product being built, and that
 * variable is the product's, so reading it would send VISP's errors to the
 * product's project.
 */
export function errorReportingDsn(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dsn = env.VISP_SENTRY_DSN?.trim();
  return dsn ? dsn : undefined;
}

const TAG_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const TAG_VALUE = /^[\w.:/-]{1,200}$/;

/**
 * Tags that tie a report to the run that produced it, from VISP_SENTRY_TAGS
 * ("feature=F-12,task=T-13,run_id=..."). QE runs set them so a crash maps back
 * to its task. Malformed pairs are dropped rather than sent.
 */
export function errorReportingTags(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const pair of (env.VISP_SENTRY_TAGS ?? "").split(",")) {
    const [key, value, ...rest] = pair.trim().split("=");
    if (rest.length === 0 && key && value && TAG_KEY.test(key) && TAG_VALUE.test(value)) {
      tags[key] = value;
    }
  }
  return tags;
}

const COMMAND = /^[a-z][a-z-]{0,31}$/;

/**
 * Tags every report gets without being asked: the subcommand (hooks call `visp guard`, so a
 * hook crash shows as command=guard) and the agent host it ran under, when the host's own
 * variables name it. Explicit VISP_SENTRY_TAGS win over these.
 */
export function runTags(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): Record<string, string> {
  const tags: Record<string, string> = {};
  const command = argv[2];
  if (command && COMMAND.test(command)) tags.command = command;
  const host = env.CLAUDECODE === "1" ? "claude-code" : env.CODEX_THREAD_ID ? "codex" : undefined;
  if (host) tags.host = host;
  return tags;
}

/**
 * VISP_CRASH_LOG names a local file that gets one JSON line per crash, with or without a
 * Sentry DSN. The SDLC's QE runs read it: a journey that passed while VISP crashed underneath
 * still fails. Only the message and the top of the stack are written, on this machine.
 */
function recordCrash(cause: unknown, env: NodeJS.ProcessEnv, argv: readonly string[]): void {
  const path = env.VISP_CRASH_LOG?.trim();
  if (!path) return;
  const error = cause instanceof Error ? cause : new Error(String(cause));
  const entry = {
    at: new Date().toISOString(),
    version: VERSION,
    ...runTags(env, argv),
    tags: errorReportingTags(env),
    message: error.message,
    stack: (error.stack ?? "").split("\n").slice(0, 6).join("\n"),
  };
  try {
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
  } catch {
    // A crash log that cannot be written must not turn into a second crash.
  }
}

/** Options that take a value, so the scan for the command skips that value. */
const VALUE_OPTIONS = new Set(["--project"]);

/**
 * True when the command line runs `visp doctor`, whatever global options come first.
 * Doctor reports on the machine's setup, so it must not send anything itself.
 */
export function runsDoctor(argv: readonly string[] = process.argv): boolean {
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (VALUE_OPTIONS.has(arg)) i++;
    else if (!arg.startsWith("-")) return arg === "doctor";
  }
  return false;
}

/**
 * Environment for a `visp` child that doctor starts: an empty DSN turns sending off, so a
 * handshake cannot send a session envelope for a check the user ran.
 */
export const NO_ERROR_REPORTING_ENV: Record<string, string> = { VISP_SENTRY_DSN: "" };

/**
 * Loads the SDK only when reporting is on, so a normal run pays nothing for it. Doctor never
 * loads it: it has nothing to report, and the SDK would echo a malformed DSN to stderr.
 */
export async function startErrorReporting(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): Promise<void> {
  const dsn = errorReportingDsn(env);
  if (!dsn || sentry || runsDoctor(argv)) return;
  sentry = await import("@sentry/node");
  sentry.init({
    dsn,
    release: `visp-coder@${VERSION}`,
    environment: env.VISP_SENTRY_ENVIRONMENT?.trim() || "production",
    initialScope: { tags: { ...runTags(env), ...errorReportingTags(env) } },
    // Errors and stack traces only. VISP handles other people's code, prompts
    // and dashboard links, so none of the SDK's request, MCP or variable
    // capture may leave the machine.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
  });
}

/** Records and sends an error the entrypoint caught and turned into an exit code. */
export async function reportError(
  cause: unknown,
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): Promise<void> {
  recordCrash(cause, env, argv);
  if (!sentry) return;
  sentry.captureException(cause);
  await sentry.flush(2000);
}
