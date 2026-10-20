import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { visualRequest } from "../../../../src/workflow/product/draft-first.js";
import { runProductDone } from "../../../../src/workflow/product/evidence.js";
import { createProductFeature } from "../../../../src/workflow/product/index.js";
import {
  productScopes,
  readProductAuthorizationBaseline,
} from "../../../../src/workflow/product/scopes.js";
import { runProductNext } from "../../../../src/workflow/product/status.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { TestWorkspace } from "../../support/workspace.js";

const PS5 = "Create an SVG of a PS5 controller.";
const CHECK = "test/picture.test.mjs";

let project: TestWorkspace | undefined;
afterEach(async () => project?.destroy());

function state() {
  if (!project) throw new Error("No project");
  return project.state();
}

async function pictureFeature(draftFirst: "off" | "visual", request = PS5) {
  project = await TestWorkspace.create({
    [CHECK]:
      "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; test('an svg',()=>assert.match(readFileSync('controller.svg','utf8'),/<svg/));\n",
  });
  await project.installFoundation();
  const config = parse(await readFile(join(project.root, "visp.yml"), "utf8"));
  config.workflow = { ...config.workflow, draftFirst, flipCheck: "off" };
  await project.write("visp.yml", stringify(config));
  project.commit("configure lean mode");
  const started = await createProductFeature(await project.state(), {
    goal: "Draw a PS5 controller",
    sourceBrief: request,
  });
  if (!started.ok) throw new Error(started.error.message);
  return started.value;
}

it.each([
  "Create an SVG of a PS5 controller.",
  "Side-view pixel art of a red-and-white striped lighthouse on a rocky cliff at sunset.",
  "Isometric 3D voxel art scene of a cozy Japanese pagoda in a small garden.",
  "Make a bar chart image of Colombo's average monthly rainfall.",
])("treats %j as a picture request", (request) => {
  expect(visualRequest(request)).toBe(true);
});

it.each([
  "Build a small Angry Birds-style slingshot game that runs in a web browser; draw everything yourself.",
  "This repository already contains a working spreadsheet engine; extend it.",
  "Build a small local inventory reservation HTTP API.",
  "Add an icon to the settings form of the app.",
])("does not treat %j as a picture request", (request) => {
  expect(visualRequest(request)).toBe(false);
});

it("authorizes a picture request as one slice before any check, then keeps the draft in the slice", async () => {
  const started = await pictureFeature("visual");
  const feature = started.brief.feature;
  expect(started).toMatchObject({
    nextCommand: `visp work --feature ${feature}`,
    draftNote: expect.stringContaining("Draft the whole picture"),
  });
  const before = await runProductNext(await state());
  expect(before.ok && before.value).toMatchObject({
    action: "understand",
    command: `visp work --feature ${feature}`,
    mayEdit: false,
  });
  const worked = await runProductWork(await state(), {});
  expect(worked, JSON.stringify(worked)).toMatchObject({
    ok: true,
    value: {
      task: "T001",
      next: {
        action: "implement",
        mayEdit: true,
        objective: expect.stringContaining("Draft first"),
        command: expect.stringContaining("--check"),
      },
    },
  });
  const scopes = await productScopes(await state());
  expect(scopes.ok && scopes.value.map((marker) => marker.allowedFiles)).toEqual([["**"]]);

  await project?.write("controller.svg", '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n');
  const early = await runProductDone(await state(), {});
  expect(early.ok && early.value.closed).not.toBe(true);

  const declared = await runProductWork(await state(), {
    check: `${process.execPath} --test ${CHECK}`,
  });
  expect(declared, JSON.stringify(declared)).toMatchObject({ ok: true, value: { task: "T001" } });
  const record = await readProductRecord(await state());
  if (!record.ok) throw new Error(record.error.message);
  expect(record.value.brief.slices).toHaveLength(1);
  expect(record.value.brief.slices[0]?.checks).toHaveLength(1);
  const baseline = await readProductAuthorizationBaseline(await state(), record.value);
  expect(baseline.ok && Object.keys(baseline.value?.baseline ?? {})).not.toContain(
    "controller.svg",
  );
  expect(await runProductDone(await state(), {})).toMatchObject({
    ok: true,
    value: { closed: true },
  });
});

it.each([
  { case: "with the switch off", draftFirst: "off" as const, request: PS5 },
  {
    case: "for a request that is not a picture",
    draftFirst: "visual" as const,
    request: "Build a small local inventory reservation HTTP API.",
  },
])("keeps today's start $case", async ({ draftFirst, request }) => {
  const started = await pictureFeature(draftFirst, request);
  const feature = started.brief.feature;
  expect(started.nextCommand).toBeUndefined();
  const next = await runProductNext(await state());
  expect(next.ok && next.value.command).toContain("--check");
  expect((await runProductWork(await state(), {})).ok).toBe(false);
  const record = await readProductRecord(await state(), { feature });
  expect(record.ok && record.value.brief.slices).toEqual([]);
});
