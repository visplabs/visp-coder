import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestProject } from "../../functional/support/project.js";

/**
 * `--json` is the contract an agent parses. These assert the envelope's shape
 * and that refusals stay machine-readable rather than degrading to prose.
 */
describe("the json envelope", () => {
  let project: TestProject;

  beforeAll(async () => {
    project = await TestProject.create();
    project.run("init", "--harness", "generic");
    expect(project.run("install", "--hooks", "git").exitCode).toBe(0);
  });

  afterAll(async () => {
    await project.destroy();
  });

  it("wraps a success with the command name and data", () => {
    const { envelope } = project.json<{ feature?: string }>("status");
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toBeDefined();
  });

  it("prints nothing but the envelope, so output is parseable", () => {
    const { result } = project.json("status");
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  it("reports a missing prerequisite with a code and a recovery command", () => {
    const { envelope, result } = project.json("work");
    expect(result.exitCode).not.toBe(0);
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("NO_ACTIVE_FEATURE");
    expect(envelope.error?.recovery).toContain("feature");
  });

  it("names the next command when the workflow knows one", () => {
    const { envelope } = project.json("next");
    expect(envelope.nextCommand).toBeTruthy();
  });

  it("refuses cleanly when the project is not initialised", async () => {
    const bare = await TestProject.create();
    try {
      const { envelope, result } = bare.json("status");
      expect(result.exitCode).toBe(3);
      expect(envelope.error?.code).toBe("NOT_INITIALIZED");
      expect(envelope.error?.recovery).toContain("init");
    } finally {
      await bare.destroy();
    }
  });
});

describe("the command surface", () => {
  let project: TestProject;

  beforeAll(async () => {
    project = await TestProject.create();
    project.run("init", "--harness", "generic");
  });

  afterAll(async () => {
    await project.destroy();
  });

  it("lists every documented command in its help", () => {
    const help = project.run("--help").stdout;

    for (const command of [
      "init",
      "install",
      "feature",
      "brief",
      "work",
      "guard",
      "verify",
      "review",
      "done",
      "accept",
      "pr",
      "next",
      "status",
      "handoff",
      "doctor",
      "report",
    ]) {
      expect(help, `${command} is missing from --help`).toContain(command);
    }
  });

  it("reports its SemVer version, including prereleases", () => {
    expect(project.run("--version").stdout.trim()).toMatch(
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    );
  });

  it("refuses to initialise twice without --force", () => {
    const { envelope, result } = project.json("init", "--harness", "generic");
    expect(result.exitCode).not.toBe(0);
    expect(envelope.error?.code).toBe("ALREADY_INITIALIZED");
  });

  it("requires the harness choice instead of silently choosing generic", async () => {
    const bare = await TestProject.create();
    try {
      const { envelope, result } = bare.json("init");
      expect(result.exitCode).toBe(2);
      expect(envelope.error?.code).toBe("UNSUPPORTED");
      expect(envelope.error?.recovery).toContain("--harness");
      await expect(bare.read(".visp/project.json")).rejects.toThrow();
    } finally {
      await bare.destroy();
    }
  });
});
