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

/** Loads the SDK only when reporting is on, so a normal run pays nothing for it. */
export async function startErrorReporting(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const dsn = errorReportingDsn(env);
  if (!dsn || sentry) return;
  sentry = await import("@sentry/node");
  sentry.init({
    dsn,
    release: `visp-coder@${VERSION}`,
    environment: env.VISP_SENTRY_ENVIRONMENT?.trim() || "production",
    initialScope: { tags: errorReportingTags(env) },
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

/** Sends an error the entrypoint caught and turned into an exit code. */
export async function reportError(cause: unknown): Promise<void> {
  if (!sentry) return;
  sentry.captureException(cause);
  await sentry.flush(2000);
}
