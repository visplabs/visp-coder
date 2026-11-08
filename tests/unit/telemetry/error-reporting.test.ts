import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  errorReportingDsn,
  errorReportingTags,
  reportError,
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
