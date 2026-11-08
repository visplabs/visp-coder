import { access, constants, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  crashLogPath,
  errorReportingDsn,
  errorReportingEnvironment,
} from "../telemetry/error-reporting.js";
import type { Check, DoctorReport } from "./checks.js";

/**
 * What this environment makes `visp`, `visp serve` and `visp-runner` do with a crash. The type
 * has no field for the DSN: neither the JSON nor the text can print any part of it. A key is
 * left out when it does not apply.
 */
export interface CrashReporting {
  readonly on: boolean;
  readonly dsnSet: boolean;
  readonly environment?: string;
  readonly crashLogSet: boolean;
  readonly crashLogFolderWritable?: boolean;
  readonly guidance?: string;
}

const GUIDANCE =
  "Crash reports stay on this machine; set VISP_SENTRY_DSN to send them to your Sentry project.";

const RECOVERY =
  "Point VISP_CRASH_LOG at a file in an existing folder you can write to. A relative path resolves from the folder visp runs in.";

/**
 * Reads the facts from the shared rules in `error-reporting.ts`, so doctor and the reporter
 * agree. It writes nothing and never starts Sentry. The folder judged is the one the crash
 * writer would append to: a relative path resolves from `cwd`, not from the project root.
 */
export async function readCrashReporting(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<CrashReporting> {
  const dsnSet = errorReportingDsn(env) !== undefined;
  const log = crashLogPath(env);
  return {
    on: dsnSet,
    dsnSet,
    ...(dsnSet ? { environment: errorReportingEnvironment(env) } : {}),
    crashLogSet: log !== undefined,
    ...(log === undefined
      ? {}
      : { crashLogFolderWritable: await isWritableFolder(dirname(resolve(cwd, log))) }),
    ...(dsnSet ? {} : { guidance: GUIDANCE }),
  };
}

async function isWritableFolder(folder: string): Promise<boolean> {
  try {
    if (!(await stat(folder)).isDirectory()) return false;
    await access(folder, constants.W_OK);
    return true;
  } catch {
    // A missing, unreadable or non-folder path is the answer "not writable", not a failure.
    return false;
  }
}

/** Adds the `crash reporting` row. A warning lifts a healthy verdict to degraded, never lowers one. */
export function withCrashReporting(report: DoctorReport, facts: CrashReporting): DoctorReport {
  const check = crashReportingCheck(facts);
  return {
    checks: [...report.checks, check],
    verdict: check.status === "warn" && report.verdict === "healthy" ? "degraded" : report.verdict,
  };
}

function crashReportingCheck(facts: CrashReporting): Check {
  const unwritable = facts.crashLogSet && facts.crashLogFolderWritable === false;
  return {
    name: "crash reporting",
    status: unwritable ? "warn" : "ok",
    detail: describe(facts),
    ...(unwritable ? { recovery: RECOVERY } : {}),
  };
}

function describe(facts: CrashReporting): string {
  const sentry = facts.dsnSet
    ? `Crash reporting is on: VISP_SENTRY_DSN is set; reports go to environment ${facts.environment}.`
    : "Crash reporting is off: VISP_SENTRY_DSN is not set.";
  const log = facts.crashLogSet
    ? `VISP_CRASH_LOG is set; its folder is ${facts.crashLogFolderWritable ? "writable" : "not writable"}.`
    : "VISP_CRASH_LOG is not set.";
  return [sentry, log, facts.guidance].filter(Boolean).join(" ");
}
