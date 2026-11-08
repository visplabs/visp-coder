import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Check, DoctorReport } from "../../../src/doctor/checks.js";
import {
  type CrashReporting,
  readCrashReporting,
  withCrashReporting,
} from "../../../src/doctor/crash-reporting.js";
import { errorReportingDsn } from "../../../src/telemetry/error-reporting.js";

const DSN = "http://visp5secretkey@127.0.0.1:9/424242";
const isRoot = process.getuid?.() === 0;

describe("crash reporting facts", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "visp-crash-facts-"));
  });

  afterEach(() => {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });

  describe("VISP_SENTRY_DSN", () => {
    const cases: [string, NodeJS.ProcessEnv][] = [
      ["unset", {}],
      ["empty", { VISP_SENTRY_DSN: "" }],
      ["whitespace only", { VISP_SENTRY_DSN: "   " }],
      ["padded with whitespace", { VISP_SENTRY_DSN: `  ${DSN}  ` }],
      ["a DSN", { VISP_SENTRY_DSN: DSN }],
      ["unset beside SENTRY_DSN", { SENTRY_DSN: DSN }],
      ["blank beside SENTRY_DSN", { VISP_SENTRY_DSN: " ", SENTRY_DSN: DSN }],
      [
        "a DSN beside SENTRY_DSN",
        { VISP_SENTRY_DSN: DSN, SENTRY_DSN: "http://other@127.0.0.1:9/1" },
      ],
    ];

    it.each(cases)("agrees with errorReportingDsn when it is %s", async (_name, env) => {
      const facts = await readCrashReporting(env, dir);
      expect(facts.dsnSet).toBe(errorReportingDsn(env) !== undefined);
      expect(facts.on).toBe(facts.dsnSet);
    });

    it("reports not set when it is unset", async () => {
      expect(await readCrashReporting({}, dir)).toMatchObject({ dsnSet: false, on: false });
    });

    it("reports not set when it is empty or whitespace only", async () => {
      for (const value of ["", "   "]) {
        expect(await readCrashReporting({ VISP_SENTRY_DSN: value }, dir)).toMatchObject({
          dsnSet: false,
          on: false,
        });
      }
    });

    it("reports set when the DSN is padded with spaces", async () => {
      expect(await readCrashReporting({ VISP_SENTRY_DSN: `  ${DSN} ` }, dir)).toMatchObject({
        dsnSet: true,
        on: true,
      });
    });

    it("reports reporting off when only SENTRY_DSN is set", async () => {
      expect(await readCrashReporting({ SENTRY_DSN: DSN }, dir)).toMatchObject({
        dsnSet: false,
        on: false,
      });
    });

    it("carries no part of the DSN in its facts or its row", async () => {
      const facts = await readCrashReporting({ VISP_SENTRY_DSN: DSN }, dir);
      const row = withCrashReporting({ verdict: "healthy", checks: [] }, facts).checks;
      const text = JSON.stringify({ facts, row });
      for (const secret of [DSN, "visp5secretkey", "127.0.0.1", "424242"]) {
        expect(text).not.toContain(secret);
      }
    });
  });

  describe("environment", () => {
    it("is production when VISP_SENTRY_ENVIRONMENT is unset", async () => {
      const facts = await readCrashReporting({ VISP_SENTRY_DSN: DSN }, dir);
      expect(facts.environment).toBe("production");
    });

    it("is production when VISP_SENTRY_ENVIRONMENT is empty or whitespace only", async () => {
      for (const value of ["", "   "]) {
        const env = { VISP_SENTRY_DSN: DSN, VISP_SENTRY_ENVIRONMENT: value };
        expect((await readCrashReporting(env, dir)).environment).toBe("production");
      }
    });

    it("is the trimmed value when VISP_SENTRY_ENVIRONMENT has surrounding whitespace", async () => {
      const env = { VISP_SENTRY_DSN: DSN, VISP_SENTRY_ENVIRONMENT: " qe " };
      expect((await readCrashReporting(env, dir)).environment).toBe("qe");
    });

    it("is left out when no DSN is set", async () => {
      const facts = await readCrashReporting({ VISP_SENTRY_ENVIRONMENT: "qe" }, dir);
      expect("environment" in facts).toBe(false);
    });
  });

  describe("VISP_CRASH_LOG", () => {
    it("reports not set when it is unset, empty or whitespace only", async () => {
      for (const env of [{}, { VISP_CRASH_LOG: "" }, { VISP_CRASH_LOG: "  " }]) {
        const facts = await readCrashReporting(env, dir);
        expect(facts.crashLogSet).toBe(false);
        expect("crashLogFolderWritable" in facts).toBe(false);
      }
    });

    it("reports set and writable for a file in a writable folder", async () => {
      const facts = await readCrashReporting({ VISP_CRASH_LOG: join(dir, "crashes.jsonl") }, dir);
      expect(facts).toMatchObject({ crashLogSet: true, crashLogFolderWritable: true });
    });

    it.skipIf(isRoot)("reports not writable for a folder with mode 0555", async () => {
      chmodSync(dir, 0o555);
      const facts = await readCrashReporting({ VISP_CRASH_LOG: join(dir, "crashes.jsonl") }, dir);
      expect(facts).toMatchObject({ crashLogSet: true, crashLogFolderWritable: false });
    });

    it("reports not writable for a folder that does not exist", async () => {
      const log = join(dir, "missing", "crashes.jsonl");
      const facts = await readCrashReporting({ VISP_CRASH_LOG: log }, dir);
      expect(facts).toMatchObject({ crashLogSet: true, crashLogFolderWritable: false });
    });

    it("reports not writable when the parent is a regular file", async () => {
      writeFileSync(join(dir, "file.txt"), "x");
      const log = join(dir, "file.txt", "crashes.jsonl");
      const facts = await readCrashReporting({ VISP_CRASH_LOG: log }, dir);
      expect(facts).toMatchObject({ crashLogSet: true, crashLogFolderWritable: false });
    });

    it("judges the working directory for a bare file name", async () => {
      const writable = await readCrashReporting({ VISP_CRASH_LOG: "crashes.jsonl" }, dir);
      expect(writable.crashLogFolderWritable).toBe(true);
      const missing = await readCrashReporting(
        { VISP_CRASH_LOG: "crashes.jsonl" },
        join(dir, "nowhere"),
      );
      expect(missing.crashLogFolderWritable).toBe(false);
    });

    it("judges the folder a relative path resolves to from the working directory", async () => {
      // The project root has no logs/; the subfolder the process runs in does.
      const sub = join(dir, "packages", "app");
      mkdirSync(join(sub, "logs"), { recursive: true });
      const env = { VISP_CRASH_LOG: "logs/crashes.jsonl" };
      expect((await readCrashReporting(env, sub)).crashLogFolderWritable).toBe(true);
      expect((await readCrashReporting(env, dir)).crashLogFolderWritable).toBe(false);
    });

    it.skipIf(isRoot)("follows the folder as it goes read-only and writable again", async () => {
      const env = { VISP_CRASH_LOG: join(dir, "crashes.jsonl") };
      const answers: (boolean | undefined)[] = [];
      for (const mode of [0o755, 0o555, 0o755]) {
        chmodSync(dir, mode);
        answers.push((await readCrashReporting(env, dir)).crashLogFolderWritable);
      }
      expect(answers).toEqual([true, false, true]);
    });
  });

  describe("guidance", () => {
    it("says reports stay on this machine and names VISP_SENTRY_DSN when nothing is set", async () => {
      const facts = await readCrashReporting({}, dir);
      expect(facts.guidance).toContain("stay on this machine");
      expect(facts.guidance).toContain("VISP_SENTRY_DSN");
    });

    it("still says so when only the crash log is set, which is local too", async () => {
      const facts = await readCrashReporting({ VISP_CRASH_LOG: join(dir, "c.jsonl") }, dir);
      expect(facts.guidance).toContain("stay on this machine");
    });

    it("is left out when reporting is on", async () => {
      const facts = await readCrashReporting({ VISP_SENTRY_DSN: DSN }, dir);
      expect("guidance" in facts).toBe(false);
    });
  });
});

describe("crash reporting row", () => {
  const existing: Check = { name: "harness assets", status: "ok", detail: "ok" };
  const off: CrashReporting = {
    on: false,
    dsnSet: false,
    crashLogSet: false,
    guidance:
      "Crash reports stay on this machine; set VISP_SENTRY_DSN to send them to your Sentry project.",
  };
  const unwritable: CrashReporting = {
    on: true,
    dsnSet: true,
    environment: "qe",
    crashLogSet: true,
    crashLogFolderWritable: false,
  };
  const report = (verdict: DoctorReport["verdict"]): DoctorReport => ({
    verdict,
    checks: [existing],
  });

  it("appends one ok row without recovery when reporting is off", () => {
    const result = withCrashReporting(report("healthy"), off);
    expect(result.verdict).toBe("healthy");
    expect(result.checks).toHaveLength(2);
    const row = result.checks[1];
    expect(row).toMatchObject({ name: "crash reporting", status: "ok" });
    expect(row?.recovery).toBeUndefined();
    expect(row?.detail).toContain("Crash reporting is off");
    expect(row?.detail).toContain("VISP_SENTRY_DSN is not set");
    expect(row?.detail).toContain("VISP_CRASH_LOG is not set");
    expect(row?.detail).toContain("stay on this machine");
  });

  it("says reporting is on, the environment and a writable folder without the stay-local text", () => {
    const facts: CrashReporting = {
      on: true,
      dsnSet: true,
      environment: "qe",
      crashLogSet: true,
      crashLogFolderWritable: true,
    };
    const row = withCrashReporting(report("healthy"), facts).checks[1];
    expect(row?.status).toBe("ok");
    expect(row?.detail).toContain("Crash reporting is on");
    expect(row?.detail).toContain("VISP_SENTRY_DSN is set");
    expect(row?.detail).toContain("environment qe");
    expect(row?.detail).toContain("VISP_CRASH_LOG is set; its folder is writable");
    expect(row?.detail).not.toContain("stay on this machine");
  });

  it("warns with a recovery and lifts healthy to degraded when the folder is not writable", () => {
    const result = withCrashReporting(report("healthy"), unwritable);
    expect(result.verdict).toBe("degraded");
    const row = result.checks[1];
    expect(row?.status).toBe("warn");
    expect(row?.detail).toContain("its folder is not writable");
    expect(row?.recovery).toContain("VISP_CRASH_LOG");
  });

  it("never lowers a degraded or unhealthy verdict", () => {
    for (const verdict of ["degraded", "unhealthy"] as const) {
      expect(withCrashReporting(report(verdict), unwritable).verdict).toBe(verdict);
      expect(withCrashReporting(report(verdict), off).verdict).toBe(verdict);
    }
  });
});
