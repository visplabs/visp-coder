import { readFile, writeFile } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import {
  activeBlockedPaths,
  activeProtectedEnvChanges,
  checkProductScope,
  earlierSessionAuthorization,
  productScopes,
} from "../../../../src/workflow/product/scopes.js";
import { authorizationPath, readProductRecord } from "../../../../src/workflow/product/store.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";
import { TestWorkspace } from "../../support/workspace.js";

let project: TestWorkspace | undefined;
afterEach(async () => project?.destroy());

it("uses configured blocked paths and no protected env changes before a feature is active", async () => {
  project = await TestWorkspace.create();
  const state = await project.state();
  expect(await activeBlockedPaths(state)).toEqual({
    ok: true,
    value: state.config.workflow.blockedPaths,
  });
  expect(await activeProtectedEnvChanges(state)).toEqual({ ok: true, value: [] });
  expect(await productScopes(state)).toEqual({ ok: true, value: [] });
  expect(await earlierSessionAuthorization(state)).toEqual({ ok: true, value: undefined });
});

it("keeps the grant's blocked paths and detects a newly ignored environment file", async () => {
  ({ workspace: project } = await productWorkspace());
  const state = await project.state();
  expect(await activeProtectedEnvChanges(state)).toEqual({ ok: true, value: [] });
  expect((await runProductWork(state, { task: "T001" })).ok).toBe(true);
  const modifiedConfig = {
    ...state,
    config: {
      ...state.config,
      workflow: { ...state.config.workflow, blockedPaths: [] },
    },
  };
  expect(await activeBlockedPaths(modifiedConfig)).toEqual({
    ok: true,
    value: state.config.workflow.blockedPaths,
  });
  await project.write("apps/api/.env", "SECRET=created-after-grant\n");
  expect(await activeProtectedEnvChanges(state)).toEqual({
    ok: true,
    value: ["apps/api/.env"],
  });
});

it("requires reauthorization when an older grant lacks a protected env baseline", async () => {
  ({ workspace: project } = await productWorkspace());
  const state = await project.state();
  expect((await runProductWork(state, { task: "T001" })).ok).toBe(true);
  const record = await readProductRecord(state);
  if (!record.ok) throw new Error(record.error.message);
  const slice = record.value.brief.slices[0];
  if (!slice) throw new Error("Missing slice");
  const path = authorizationPath(state, record.value.brief.feature);
  const grant = JSON.parse(await readFile(path, "utf8"));
  delete grant.envBaseline;
  await writeFile(path, JSON.stringify(grant));
  expect(await activeProtectedEnvChanges(state)).toMatchObject({
    ok: false,
    error: { code: "STAGE_BLOCKED", recovery: expect.stringContaining("visp work") },
  });
  expect(await checkProductScope(state, record.value, slice)).toMatchObject({
    ok: false,
    error: { code: "STAGE_BLOCKED", recovery: expect.stringContaining("T001") },
  });
});

it("routes only the session that received a grant to the editable slice", async () => {
  ({ workspace: project } = await productWorkspace());
  await project.write(".visp/session/host-session.json", JSON.stringify({ session: "author" }));
  const state = await project.state();
  expect((await runProductWork(state, { task: "T001" })).ok).toBe(true);
  expect(await productScopes(state, { hostSession: "author" })).toMatchObject({
    ok: true,
    value: [expect.objectContaining({ task: "T001" })],
  });
  expect(await productScopes(state, { hostSession: "later" })).toEqual({ ok: true, value: [] });
  expect(await earlierSessionAuthorization(state, { hostSession: "later" })).toMatchObject({
    ok: true,
    value: { task: "T001", session: "author" },
  });
});

it("enforces the review file-count limit on local changes inside an allowed slice", async () => {
  ({ workspace: project } = await productWorkspace());
  const state = await project.state();
  expect((await runProductWork(state, { task: "T001" })).ok).toBe(true);
  await project.write("src/value.mjs", "export const value = 2;\n");
  await project.write("test/value.test.mjs", "// Revised test for the public value\n");
  const record = await readProductRecord(state);
  if (!record.ok) throw new Error(record.error.message);
  const slice = record.value.brief.slices[0];
  if (!slice) throw new Error("Missing slice");
  const limited = { ...state, policy: { ...state.policy, maxChangedFiles: 1 } };
  expect(await checkProductScope(limited, record.value, slice)).toMatchObject({
    ok: false,
    error: {
      code: "SCOPE_VIOLATION",
      message: expect.stringContaining("Changed-file count 2"),
      details: { paths: ["src/value.mjs", "test/value.test.mjs"], committedChanges: [] },
    },
  });
});

it("applies relaxed allowed-file policy without losing hard blocked paths", async () => {
  ({ workspace: project } = await productWorkspace());
  const state = await project.state();
  expect((await runProductWork(state, { task: "T001" })).ok).toBe(true);
  await project.write("notes/extra.md", "An implementation note\n");
  const record = await readProductRecord(state);
  if (!record.ok) throw new Error(record.error.message);
  const slice = record.value.brief.slices[0];
  if (!slice) throw new Error("Missing slice");
  expect(await checkProductScope(state, record.value, slice)).toMatchObject({
    ok: false,
    error: { details: { outside: ["notes/extra.md"] } },
  });
  const relaxed = { ...state, policy: { ...state.policy, strictness: "relaxed" as const } };
  expect(await checkProductScope(relaxed, record.value, slice)).toEqual({
    ok: true,
    value: { committedChanges: [], changed: ["notes/extra.md"] },
  });
  await project.write(".env", "SECRET=still-protected\n");
  expect(await checkProductScope(relaxed, record.value, slice)).toMatchObject({
    ok: false,
    error: { details: { forbidden: [".env"] } },
  });
});
