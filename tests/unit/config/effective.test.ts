import { readFile, writeFile } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { explainSettings } from "../../../src/config/effective.js";
import { productWorkspace } from "../support/product-workspace.js";
import { TestWorkspace } from "../support/workspace.js";

let project: TestWorkspace | undefined;
afterEach(async () => project?.destroy());

it("distinguishes explicit values, defaults and recorded policy without rewriting configuration", async () => {
  project = await TestWorkspace.create();
  await project.write(
    "visp.yml",
    "context:\n  maxSnippets: 7\nworkflow:\n  strictness: strict\ncritic:\n  enabled: false\n",
  );
  const initial = await project.state();
  await writeFile(
    initial.paths.policy,
    JSON.stringify({ ...initial.policy, strictness: "locked", maxChangedFiles: 3 }),
  );
  const state = await project.state();
  const before = await readFile(state.paths.config, "utf8");
  const report = await explainSettings(state);
  expect(report.ok).toBe(true);
  if (!report.ok) return;
  expect(report.value.settings).toContainEqual(
    expect.objectContaining({ path: "context.maxSnippets", value: 7, source: "project" }),
  );
  expect(report.value.settings).toContainEqual(
    expect.objectContaining({ path: "context.tokenBudget", source: "default" }),
  );
  expect(report.value.policy.strictness).toBe("locked");
  expect(report.value.policy.maxChangedFiles).toBe(3);
  expect(report.value.settings).toContainEqual(
    expect.objectContaining({ path: "workflow.strictness", value: "strict", source: "project" }),
  );
  expect(report.value.settings).toContainEqual(
    expect.objectContaining({
      path: "workflow.flipCheck",
      effect: "conditional",
      note: expect.stringContaining("display-only regression comparison"),
    }),
  );
  expect(await readFile(state.paths.config, "utf8")).toBe(before);
});

it("refuses to explain a stale loaded configuration using new file provenance", async () => {
  project = await TestWorkspace.create();
  const state = await project.state();
  await project.write("visp.yml", "context:\n  maxSnippets: 9\n");
  const report = await explainSettings(state);
  expect(report).toMatchObject({
    ok: false,
    error: { code: "CONFIG_INVALID", message: expect.stringContaining("changed") },
  });
});

it("keeps new-feature critic defaults separate from an existing feature's pinned opt-out", async () => {
  const setup = await productWorkspace({ flip: true });
  project = setup.workspace;
  await project.write(
    "visp.yml",
    "harness: codex\ncritic:\n  enabled: true\n  model: diagnostic-test-model\n",
  );
  const report = await explainSettings(await project.state());
  expect(report.ok).toBe(true);
  if (!report.ok) return;
  expect(report.value.newFeatureCritic).toMatchObject({
    ok: true,
    value: { enabled: true, config: { model: "diagnostic-test-model" } },
  });
  expect(report.value.activeFeatureCritic).toMatchObject({ ok: true, value: { enabled: false } });
});

it("explains the live display-only flip setting", async () => {
  ({ workspace: project } = await productWorkspace({ flip: true }));
  const state = await project.state();
  const config = await readFile(state.paths.config, "utf8");
  expect(config).toContain("flipCheck: auto");
  await writeFile(state.paths.config, config.replace("flipCheck: auto", "flipCheck: off"));
  const report = await explainSettings(await project.state());
  expect(report.ok).toBe(true);
  if (!report.ok) throw new Error(report.error.message);
  expect(report.value.settings).toContainEqual(
    expect.objectContaining({
      path: "workflow.flipCheck",
      value: "off",
      source: "project",
      effect: "conditional",
    }),
  );
});

it("identifies active memory settings and telemetry's limited effect", async () => {
  project = await TestWorkspace.create();
  await project.write("visp.yml", "memory:\n  recall: true\n");
  const report = await explainSettings(await project.state());
  if (!report.ok) throw new Error(report.error.message);
  expect(report.value.settings.find((setting) => setting.path === "memory.recall")?.effect).toBe(
    "conditional",
  );
  expect(
    report.value.settings.find((setting) => setting.path === "telemetry.enabled")?.note,
  ).toContain("usage import");
});
