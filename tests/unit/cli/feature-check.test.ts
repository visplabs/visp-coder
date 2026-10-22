import { afterEach, expect, it } from "vitest";
import { readProductRecord } from "../../../src/workflow/product/store.js";
import { TestWorkspace } from "../support/workspace.js";
import { runCli } from "./support/cli.js";

let workspace: TestWorkspace | undefined;
afterEach(async () => {
  await workspace?.destroy();
  workspace = undefined;
});

const CHECK = "node --test test/value.test.mjs";

async function project() {
  workspace = await TestWorkspace.create(
    {
      "src/value.mjs": "export const value = 1;\nexport const label = 'one';\n",
      "test/value.test.mjs":
        "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; test('value is two',()=>{assert.equal(value,2);});\n",
    },
    { flip: false, profile: "lean" },
  );
  await workspace.installFoundation();
  workspace.commit("install foundation");
  return workspace;
}

it("starts the one lean slice in the same command, with the done command to run next", async () => {
  const created = await project();
  const result = await runCli(
    created.root,
    "feature",
    "Return two",
    "--check",
    CHECK,
    "--source-brief",
    "Make the public value two.",
  );
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/^feature: \{"feature":"001-return-two"/);
  // The work reply follows the feature's own lines.
  expect(result.stdout).toContain('\nwork: {"feature":"001-return-two","task":"T001"');
  expect(result.stdout).toContain('"mayEdit":true');
  expect(result.stdout).toContain("Next: visp done --feature 001-return-two --task T001");
  expect(result.stdout).not.toContain("Next: visp work");
  const record = await readProductRecord(await created.state());
  expect(record.ok && record.value.brief.slices.map((slice) => slice.id)).toEqual(["T001"]);
  expect(record.ok && record.value.brief.checks.map((check) => check.command)).toEqual([CHECK]);
});

it("leaves feature without --check as it was, asking for visp work", async () => {
  const created = await project();
  const result = await runCli(
    created.root,
    "feature",
    "Return two",
    "--source-brief",
    "Make the public value two.",
  );
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("Next: visp work --feature 001-return-two --check");
  expect(result.stdout).not.toContain("\nwork: {");
  const record = await readProductRecord(await created.state());
  expect(record.ok && record.value.brief.slices).toEqual([]);
});

it("names the whole account command in the reply when the request lists requirements", async () => {
  const created = await project();
  const result = await runCli(
    created.root,
    "feature",
    "Return two",
    "--check",
    CHECK,
    "--source-brief",
    "- Export value two.\n- Export label two.",
  );
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain(
    "Requirements:\n- R001: Export value two.\n- R002: Export label two.",
  );
  expect(result.stdout).toContain(
    'Requirements not accounted for: R001, R002. At visp done, give each its passing check and a test it runs, or say why it is not done: visp done --feature 001-return-two --task T001 --account \\"R001=C001 <test name>\\" \\"R002=C001 <test name>\\", one entry per requirement',
  );
});

it("ignores a blank --check and asks for visp work as before", async () => {
  const created = await project();
  const result = await runCli(
    created.root,
    "feature",
    "Return two",
    "--check",
    "   ",
    "--source-brief",
    "Make the public value two.",
  );
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("Next: visp work --feature 001-return-two --check");
});
