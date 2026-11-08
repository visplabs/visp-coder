import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestProject } from "../support/project.js";
import {
  type AsyncRun,
  runAsync,
  type SentryCapture,
  sendControlEvent,
  startSentryCapture,
} from "../support/sentry-capture.js";

const CLI = resolve(process.cwd(), "dist/cli.js");
const MARKER = "not-a-dsn-visp5marker";
const REPORTING_VARS = [
  "VISP_SENTRY_DSN",
  "VISP_SENTRY_ENVIRONMENT",
  "VISP_SENTRY_TAGS",
  "VISP_CRASH_LOG",
];

/**
 * Doctor reports on how VISP is set up; it must not report anything itself, and it must not
 * echo a DSN. The shell running these tests may hold a real DSN, so every variable is set or
 * removed explicitly and the only DSN used points at a local capture server.
 */
describe("doctor and crash reporting", () => {
  let project: TestProject;
  let capture: SentryCapture;
  const folders: string[] = [];

  beforeEach(async () => {
    for (const name of REPORTING_VARS) vi.stubEnv(name, undefined);
    capture = await startSentryCapture();
    project = await TestProject.create({ "src/a.ts": "export const a = 1;\n" });
    project.run("init", "--harness", "claude-code");
    // Without an installed runtime doctor skips its handshake, and the tests below would
    // pass without exercising the child processes they are about.
    expect(project.run("install", "--harness", "claude-code").exitCode).toBe(0);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await capture.close();
    await project.destroy();
    for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
  });

  function env(dsn: string | undefined): NodeJS.ProcessEnv {
    const base = { ...project.env() };
    for (const name of REPORTING_VARS) delete base[name];
    if (dsn === undefined) return base;
    return {
      ...base,
      VISP_SENTRY_DSN: dsn,
      VISP_SENTRY_ENVIRONMENT: "qe",
      VISP_SENTRY_TAGS: `run_id=visp5-${Date.now()}`,
    };
  }

  function doctor(dsn: string | undefined, cwd: string, ...args: string[]): Promise<AsyncRun> {
    return runAsync(process.execPath, [CLI, "doctor", ...args], { cwd, env: env(dsn) });
  }

  const INSTALLED_BUILD = "The shell resolves the installed VISP build";

  /**
   * Proves this very run reached the end and started the handshake child: it exited 0 and its
   * own output has the PATH visp row that only the handshake can produce ("ok"; without an
   * installed runtime the row says "No installed runtime to compare").
   */
  function expectRanInstalledHandshake(run: AsyncRun, format: "text" | "json"): void {
    expect(run.exitCode).toBe(0);
    if (format === "text") {
      expect(run.stdout).toMatch(/ok\s+PATH visp\s+The shell resolves the installed VISP build/);
      return;
    }
    const report = JSON.parse(run.stdout) as {
      data: { checks: { name: string; status: string; detail?: string }[] };
    };
    expect(report.data.checks).toContainEqual(
      expect.objectContaining({ name: "PATH visp", status: "ok", detail: INSTALLED_BUILD }),
    );
  }

  async function bareFolder(): Promise<string> {
    const folder = await mkdtemp(join(tmpdir(), "visp-not-a-project-"));
    folders.push(folder);
    return folder;
  }

  describe("a malformed DSN", () => {
    it("is not echoed by doctor or doctor --json in an initialised project", async () => {
      for (const args of [[], ["--json"]]) {
        const run = await doctor(MARKER, project.root, ...args);
        expect(run.stdout + run.stderr).not.toContain("visp5marker");
        expect(run.stdout.length).toBeGreaterThan(0);
      }
    });

    it("is not echoed when the folder is not a VISP project", async () => {
      const folder = await bareFolder();
      for (const args of [[], ["--json"]]) {
        const run = await doctor(MARKER, folder, ...args);
        expect(run.exitCode).toBe(3);
        expect(run.stdout + run.stderr).not.toContain("visp5marker");
      }
    });
  });

  describe("with a DSN at a local capture server", () => {
    it("sends nothing for doctor, while the SDK itself can reach the server", async () => {
      const run = await doctor(capture.dsn, project.root);
      expectRanInstalledHandshake(run, "text");
      expect(capture.requests).toHaveLength(0);

      await sendControlEvent(capture.dsn, env(capture.dsn));
      expect(capture.requests.length).toBeGreaterThan(0);
    });

    it("sends nothing for doctor --json, --settings or --fix", async () => {
      expectRanInstalledHandshake(await doctor(capture.dsn, project.root, "--json"), "json");
      // --settings and --fix print the same check rows as plain doctor, then their own section.
      expectRanInstalledHandshake(await doctor(capture.dsn, project.root, "--settings"), "text");
      expectRanInstalledHandshake(await doctor(capture.dsn, project.root, "--fix"), "text");
      expect(capture.requests).toHaveLength(0);
    });

    it("sends nothing when doctor ends in an error", async () => {
      const folder = await bareFolder();
      const outside = await doctor(capture.dsn, folder);
      expect(outside.exitCode).toBe(3);
      const layer = await doctor(
        capture.dsn,
        project.root,
        "--check-command",
        "node -e 0",
        "--check-layer",
        "bogus",
      );
      expect(layer.exitCode).not.toBe(0);
      expect(capture.requests).toHaveLength(0);
    });
  });
});
