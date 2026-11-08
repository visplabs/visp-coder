import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TestProject } from "../support/project.js";

/**
 * `visp doctor` says what this shell's crash-reporting variables make visp do, and never
 * prints the DSN. The machine's own VISP_SENTRY_* values must not reach these runs.
 */
const VARIABLES = [
  "VISP_SENTRY_DSN",
  "VISP_SENTRY_ENVIRONMENT",
  "VISP_SENTRY_TAGS",
  "VISP_CRASH_LOG",
  "SENTRY_DSN",
] as const;

interface CrashReportingData {
  on: boolean;
  dsnSet: boolean;
  environment?: string;
  crashLogSet: boolean;
  crashLogFolderWritable?: boolean;
  guidance?: string;
}

interface DoctorData {
  verdict: string;
  crashReporting: CrashReportingData;
  checks: { name: string; status: string; detail: string }[];
}

const STAY_LOCAL = "Crash reports stay on this machine";
const isRoot = process.getuid?.() === 0;

describe("doctor crash reporting", () => {
  let project: TestProject;
  let scratch: string;
  let port: number;
  let saved: Record<string, string | undefined>;

  /** A local port nothing listens on: the DSN points at this machine, never at Sentry. */
  beforeAll(async () => {
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    port = (server.address() as AddressInfo).port;
    await new Promise<void>((done) => server.close(() => done()));
  });

  beforeEach(async () => {
    saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
    for (const name of VARIABLES) delete process.env[name];
    scratch = mkdtempSync(join(tmpdir(), "visp-doctor-crash-"));
    project = await TestProject.create({ "src/a.ts": "export const a = 1;\n" });
    await project.installShim();
    project.run("init", "--harness", "generic");
  });

  afterEach(async () => {
    for (const name of VARIABLES) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    chmodSync(scratch, 0o755);
    rmSync(scratch, { recursive: true, force: true });
    await project.destroy();
  });

  const dsn = () => `http://visp5secretkey@127.0.0.1:${port}/424242`;
  const set = (name: (typeof VARIABLES)[number], value: string) => {
    process.env[name] = value;
  };
  const unset = (name: (typeof VARIABLES)[number]) => {
    delete process.env[name];
  };
  const data = () => project.json<DoctorData>("doctor").envelope.data as DoctorData;
  const text = () => project.run("doctor").stdout;

  it("says reporting is on, the DSN is set and the environment is production when it is unset", () => {
    set("VISP_SENTRY_DSN", dsn());
    const out = text();
    expect(out).toContain("Crash reporting is on");
    expect(out).toContain("VISP_SENTRY_DSN is set");
    expect(out).toContain("environment production");
    expect(out).not.toContain(STAY_LOCAL);
  });

  it("names the environment VISP_SENTRY_ENVIRONMENT gives", () => {
    set("VISP_SENTRY_DSN", dsn());
    set("VISP_SENTRY_ENVIRONMENT", "qe");
    expect(text()).toContain("environment qe");
  });

  it("says reporting is off, nothing is set, and how to turn it on", () => {
    const out = text();
    expect(out).toContain("Crash reporting is off");
    expect(out).toContain("VISP_SENTRY_DSN is not set");
    expect(out).toContain("VISP_CRASH_LOG is not set");
    expect(out).toContain(STAY_LOCAL);
    expect(out).toContain("set VISP_SENTRY_DSN");
  });

  it("still says reports stay on this machine with only an environment and tags set", () => {
    set("VISP_SENTRY_ENVIRONMENT", "qe");
    set("VISP_SENTRY_TAGS", "task=VISP-5");
    const out = text();
    expect(out).toContain("Crash reporting is off");
    expect(out).toContain(STAY_LOCAL);
    expect(out).toContain("set VISP_SENTRY_DSN");
  });

  it("follows VISP_SENTRY_DSN between runs: absent, present, absent", () => {
    set("VISP_SENTRY_DSN", dsn());
    expect(text()).not.toContain(STAY_LOCAL);
    unset("VISP_SENTRY_DSN");
    expect(text()).toContain(STAY_LOCAL);
    set("VISP_SENTRY_DSN", dsn());
    expect(text()).not.toContain(STAY_LOCAL);
  });

  it("treats a blank VISP_SENTRY_DSN as off even when SENTRY_DSN is set", () => {
    set("VISP_SENTRY_DSN", "   ");
    set("SENTRY_DSN", dsn());
    const out = text();
    expect(out).toContain("Crash reporting is off");
    expect(out).toContain("VISP_SENTRY_DSN is not set");
  });

  it("says VISP_CRASH_LOG is set and its folder is writable", () => {
    set("VISP_CRASH_LOG", join(scratch, "crashes.jsonl"));
    const out = text();
    expect(out).toContain("Crash reporting is off");
    expect(out).toContain("VISP_CRASH_LOG is set; its folder is writable");
  });

  it("says the folder is not writable when it does not exist, and still exits 0", () => {
    set("VISP_CRASH_LOG", join(scratch, "missing", "crashes.jsonl"));
    const result = project.run("doctor");
    expect(result.stdout).toContain("its folder is not writable");
    expect(result.stdout).toContain("To fix:");
    expect(result.exitCode).toBe(0);
  });

  it("prints no part of the DSN in any doctor output", () => {
    set("VISP_SENTRY_DSN", dsn());
    const runs = [
      project.run("doctor"),
      project.run("doctor", "--json"),
      project.run("doctor", "--settings"),
    ];
    for (const run of runs) {
      for (const secret of [dsn(), "visp5secretkey", `127.0.0.1:${port}`, "424242"]) {
        expect(run.stdout).not.toContain(secret);
        expect(run.stderr).not.toContain(secret);
      }
    }
  });

  it("carries the same facts in --json when everything is set and writable", () => {
    set("VISP_SENTRY_DSN", dsn());
    set("VISP_SENTRY_ENVIRONMENT", "qe");
    set("VISP_CRASH_LOG", join(scratch, "crashes.jsonl"));
    expect(data().crashReporting).toEqual({
      on: true,
      dsnSet: true,
      environment: "qe",
      crashLogSet: true,
      crashLogFolderWritable: true,
    });
    const out = text();
    expect(out).toContain("Crash reporting is on");
    expect(out).toContain("environment qe");
    expect(out).toContain("its folder is writable");
  });

  it("carries the same facts in --json when nothing is set", () => {
    const crashReporting = data().crashReporting;
    expect(crashReporting).toMatchObject({ on: false, dsnSet: false, crashLogSet: false });
    expect("environment" in crashReporting).toBe(false);
    expect("crashLogFolderWritable" in crashReporting).toBe(false);
    expect(text()).toContain("Crash reporting is off");
    expect(text()).toContain("VISP_SENTRY_DSN is not set");
  });

  it("says in --json that reports stay on this machine and names VISP_SENTRY_DSN", () => {
    const guidance = data().crashReporting.guidance;
    expect(guidance).toContain("stay on this machine");
    expect(guidance).toContain("VISP_SENTRY_DSN");
  });

  it("leaves the environment out of --json when only the DSN is unset", () => {
    set("VISP_SENTRY_ENVIRONMENT", "qe");
    expect("environment" in data().crashReporting).toBe(false);
  });

  it("reports production in --json when the DSN is set without an environment", () => {
    set("VISP_SENTRY_DSN", dsn());
    expect(data().crashReporting).toMatchObject({ on: true, environment: "production" });
    expect("guidance" in data().crashReporting).toBe(false);
  });

  it.skipIf(isRoot)(
    "keeps one envelope with ok true and degrades the verdict for a read-only crash log folder",
    () => {
      chmodSync(scratch, 0o555);
      set("VISP_CRASH_LOG", join(scratch, "crashes.jsonl"));
      const { result, envelope } = project.json<DoctorData>("doctor");
      expect(envelope.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(envelope.data?.crashReporting).toMatchObject({
        crashLogSet: true,
        crashLogFolderWritable: false,
      });
      expect(envelope.data?.verdict).not.toBe("healthy");
    },
  );

  it("reports a missing crash log folder in --json as set and not writable", () => {
    set("VISP_CRASH_LOG", join(scratch, "missing", "crashes.jsonl"));
    expect(data().crashReporting).toMatchObject({
      crashLogSet: true,
      crashLogFolderWritable: false,
    });
  });
});
