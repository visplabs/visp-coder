import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runtimeIdentity } from "../../../src/core/version.js";
import { checkInstalledRuntime, checkPathRuntime } from "../../../src/doctor/runtime.js";
import { productWorkspace } from "../support/product-workspace.js";

let project: Awaited<ReturnType<typeof productWorkspace>> | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  await project?.workspace.destroy();
  project = undefined;
});

async function installed() {
  project = await productWorkspace();
  const state = await project.workspace.state();
  const installation = JSON.parse(await readFile(state.paths.installState, "utf8"));
  return { state, installation };
}

async function pathVisp(stdout: string, exitCode = 0) {
  if (!project) throw new Error("Missing project");
  const bin = join(project.workspace.root, "runtime-bin");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "visp"),
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(stdout)}); process.exit(${exitCode});\n`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
}

it("explains missing and invalid installation provenance", async () => {
  const { state } = await installed();
  await unlink(state.paths.installState);
  expect(await checkInstalledRuntime(state)).toMatchObject({
    status: "warn",
    recovery: expect.stringContaining("replace-runtime"),
  });
  expect(await checkPathRuntime(state)).toMatchObject({ status: "unknown" });

  await writeFile(state.paths.installState, '{"kind":"invalid"}');
  expect(await checkInstalledRuntime(state)).toMatchObject({
    status: "fail",
    detail: expect.stringContaining("Invalid install state"),
  });
  expect(await checkPathRuntime(state)).toMatchObject({ status: "unknown" });
});

it("identifies the installed build and gives an executable-specific recovery for drift", async () => {
  const { state, installation } = await installed();
  expect(await checkInstalledRuntime(state)).toMatchObject({
    status: "ok",
    detail: expect.stringContaining(runtimeIdentity().buildId),
  });
  installation.runtime.buildId =
    runtimeIdentity().buildId === "0123456789abcdef" ? "fedcba9876543210" : "0123456789abcdef";
  await writeFile(state.paths.installState, JSON.stringify(installation));
  expect(await checkInstalledRuntime(state)).toMatchObject({
    status: "fail",
    detail: expect.stringContaining("runtime mismatch"),
    recovery: expect.stringContaining(installation.runtime.executable),
  });
});

it("distinguishes the installed CLI on PATH from a different executable", async () => {
  const { state, installation } = await installed();
  await pathVisp(JSON.stringify({ data: { runtime: installation.runtime } }));
  expect(await checkPathRuntime(state)).toMatchObject({ status: "ok" });

  const other = { ...installation.runtime, executable: "/other/visp" };
  await pathVisp(JSON.stringify({ data: { runtime: other } }));
  expect(await checkPathRuntime(state)).toMatchObject({
    status: "warn",
    detail: expect.stringContaining("/other/visp"),
    recovery: expect.stringContaining(installation.runtime.executable),
  });
});

it("reports unidentified, malformed, and unavailable PATH commands", async () => {
  const { state, installation } = await installed();
  await pathVisp(JSON.stringify({ data: {} }));
  expect(await checkPathRuntime(state)).toMatchObject({
    status: "warn",
    detail: expect.stringContaining("unidentified VISP"),
  });
  await pathVisp("not json");
  expect(await checkPathRuntime(state)).toMatchObject({
    status: "warn",
    detail: expect.stringContaining("no valid runtime identity"),
  });
  await pathVisp("", 1);
  expect(await checkPathRuntime(state)).toMatchObject({
    status: "warn",
    recovery: expect.stringContaining(installation.runtime.executable),
  });
});

it("starts the PATH visp handshake with crash reporting off", async () => {
  const { state, installation } = await installed();
  if (!project) throw new Error("Missing project");
  const seen = join(project.workspace.root, "seen-dsn");
  const bin = join(project.workspace.root, "runtime-bin");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "visp"),
    `#!${process.execPath}\nprocess.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.env.VISP_SENTRY_DSN ?? null));\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ data: { runtime: installation.runtime } }))});\n`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
  vi.stubEnv("VISP_SENTRY_DSN", "http://key@127.0.0.1:9/1");
  expect(await checkPathRuntime(state)).toMatchObject({ status: "ok" });
  expect(JSON.parse(await readFile(seen, "utf8"))).toBe("");
});
