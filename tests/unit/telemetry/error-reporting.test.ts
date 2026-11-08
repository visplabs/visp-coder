import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  crashLogPath,
  errorReportingDsn,
  errorReportingEnvironment,
  errorReportingTags,
  NO_ERROR_REPORTING_ENV,
  reportError,
  runsDoctor,
  runTags,
} from "../../../src/telemetry/error-reporting.js";

it("reports only to a DSN given in VISP_SENTRY_DSN", () => {
  expect(errorReportingDsn({})).toBeUndefined();
  expect(errorReportingDsn({ VISP_SENTRY_DSN: "  " })).toBeUndefined();
  expect(errorReportingDsn({ VISP_SENTRY_DSN: " https://key@o1.ingest.sentry.io/2 " })).toBe(
    "https://key@o1.ingest.sentry.io/2",
  );
});

it("ignores SENTRY_DSN, which belongs to the product being built", () => {
  expect(errorReportingDsn({ SENTRY_DSN: "https://key@o1.ingest.sentry.io/2" })).toBeUndefined();
});

it("tags reports with the run named in VISP_SENTRY_TAGS and drops malformed pairs", () => {
  expect(errorReportingTags({})).toEqual({});
  expect(
    errorReportingTags({
      VISP_SENTRY_TAGS: "feature=F-12, task=T-13,run_id=qe-20261104T101530Z,commit=8b3b3679",
    }),
  ).toEqual({ feature: "F-12", task: "T-13", run_id: "qe-20261104T101530Z", commit: "8b3b3679" });
  expect(errorReportingTags({ VISP_SENTRY_TAGS: "Bad Key=x,empty=,ok=1,secret=a b" })).toEqual({
    ok: "1",
  });
});

it("tags a report with the command and the host it ran under", () => {
  expect(runTags({ CLAUDECODE: "1" }, ["node", "/bin/visp", "guard", "--json"])).toEqual({
    command: "guard",
    host: "claude-code",
  });
  expect(runTags({ CODEX_THREAD_ID: "t1" }, ["node", "/bin/visp", "capture"])).toEqual({
    command: "capture",
    host: "codex",
  });
  expect(runTags({}, ["node", "/bin/visp", "--json"])).toEqual({});
});

it("appends each crash to VISP_CRASH_LOG, with no Sentry DSN needed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "visp-crash-"));
  const log = join(dir, "crashes.jsonl");
  const env = { VISP_CRASH_LOG: log, VISP_SENTRY_TAGS: "task=VISP-13" };
  await reportError(new Error("boom"), env, ["node", "/bin/visp", "guard"]);
  const [entry] = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(entry).toMatchObject({ command: "guard", message: "boom", tags: { task: "VISP-13" } });
  expect(entry.stack).toContain("Error: boom");
  await reportError(new Error("ignored"), {}, ["node", "/bin/visp", "guard"]);
  expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
  rmSync(dir, { recursive: true, force: true });
});

it("recognises a doctor run, with global options before the command", () => {
  const visp = ["node", "/bin/visp"];
  expect(runsDoctor([...visp, "doctor"])).toBe(true);
  expect(runsDoctor([...visp, "doctor", "--json", "--fix"])).toBe(true);
  expect(runsDoctor([...visp, "--project", "/work/doctor", "doctor"])).toBe(true);
  expect(runsDoctor([...visp, "--project=/work", "--json", "doctor"])).toBe(true);
  expect(runsDoctor(visp)).toBe(false);
  expect(runsDoctor([...visp, "guard", "doctor"])).toBe(false);
  expect(runsDoctor([...visp, "--project", "doctor", "guard"])).toBe(false);
  expect(runsDoctor([...visp, "--project"])).toBe(false);
});

it("blanks the DSN for child processes so they cannot send either", () => {
  expect(errorReportingDsn({ ...process.env, ...NO_ERROR_REPORTING_ENV })).toBeUndefined();
});

it("leaves the SDK unloaded for doctor, so a malformed DSN is never echoed", async () => {
  const marker = "not-a-dsn-visp5marker";
  const complaint = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    vi.resetModules();
    const doctor = await import("../../../src/telemetry/error-reporting.js");
    await doctor.startErrorReporting({ VISP_SENTRY_DSN: marker }, ["node", "visp", "doctor"]);
    expect(complaint).not.toHaveBeenCalled();
    // Still no SDK, so nothing is sent; the crash log is unaffected.
    await expect(
      doctor.reportError(new Error("boom"), {}, ["node", "visp", "doctor"]),
    ).resolves.toBe(undefined);

    vi.resetModules();
    const other = await import("../../../src/telemetry/error-reporting.js");
    await other.startErrorReporting({ VISP_SENTRY_DSN: marker }, ["node", "visp", "guard"]);
    expect(complaint.mock.calls.flat().join(" ")).toContain(marker);
  } finally {
    complaint.mockRestore();
    vi.resetModules();
  }
});

it("still writes a doctor crash to VISP_CRASH_LOG", async () => {
  const dir = mkdtempSync(join(tmpdir(), "visp-crash-"));
  const log = join(dir, "crashes.jsonl");
  await reportError(new Error("doctor broke"), { VISP_CRASH_LOG: log }, ["node", "visp", "doctor"]);
  expect(JSON.parse(readFileSync(log, "utf8"))).toMatchObject({
    command: "doctor",
    message: "doctor broke",
  });
  rmSync(dir, { recursive: true, force: true });
});

it("names the environment reports go to, production when VISP_SENTRY_ENVIRONMENT is blank", () => {
  expect(errorReportingEnvironment({})).toBe("production");
  expect(errorReportingEnvironment({ VISP_SENTRY_ENVIRONMENT: "" })).toBe("production");
  expect(errorReportingEnvironment({ VISP_SENTRY_ENVIRONMENT: "   " })).toBe("production");
  expect(errorReportingEnvironment({ VISP_SENTRY_ENVIRONMENT: " qe " })).toBe("qe");
});

it("names the crash log only when VISP_CRASH_LOG is not blank", () => {
  expect(crashLogPath({})).toBeUndefined();
  expect(crashLogPath({ VISP_CRASH_LOG: "" })).toBeUndefined();
  expect(crashLogPath({ VISP_CRASH_LOG: "  " })).toBeUndefined();
  expect(crashLogPath({ VISP_CRASH_LOG: " logs/crashes.jsonl " })).toBe("logs/crashes.jsonl");
});

it("writes nothing for a blank VISP_CRASH_LOG, the same case doctor reports as not set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "visp-crash-"));
  const previous = process.cwd();
  process.chdir(dir);
  try {
    await reportError(new Error("boom"), { VISP_CRASH_LOG: "   " }, ["node", "/bin/visp", "guard"]);
    expect(readdirSync(dir)).toEqual([]);
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
});
