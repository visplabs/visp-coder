import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runProductDone } from "../../../../src/workflow/product/evidence.js";
import { createProductFeature } from "../../../../src/workflow/product/index.js";
import {
  parseRequirementAccounts,
  requestRequirements,
} from "../../../../src/workflow/product/requirements.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { TestWorkspace } from "../../support/workspace.js";

const task = (name: string) =>
  readFileSync(join(import.meta.dirname, "../../../../bench/tasks", name, "task.md"), "utf8");

describe("requestRequirements", () => {
  it("lists each item of a numbered or bulleted request, nested items too", () => {
    const listed = requestRequirements(
      [
        "Add a settings page:",
        "1. A theme switch.",
        "2. A language picker:",
        "   - English",
        "   - French",
        "",
        "Use only the standard library.",
      ].join("\n"),
    );
    expect(listed.map((entry) => entry.statement)).toEqual([
      "A theme switch.",
      "A language picker:",
      "English",
      "French",
      "Use only the standard library.",
    ]);
    expect(listed.map((entry) => entry.id)).toEqual(["R001", "R002", "R003", "R004", "R005"]);
  });

  it("splits an item that names several endpoints into one requirement per endpoint", () => {
    const listed = requestRequirements(
      [
        "- `DELETE /v1/items/<id>` and `POST /v1/items/<id>/confirm` act on every line.",
        "- Add paging.",
      ].join("\n"),
    );
    expect(listed.map((entry) => entry.statement)).toEqual([
      "DELETE /v1/items/<id>: `DELETE /v1/items/<id>` and `POST /v1/items/<id>/confirm` act on every line.",
      "POST /v1/items/<id>/confirm: `DELETE /v1/items/<id>` and `POST /v1/items/<id>/confirm` act on every line.",
      "Add paging.",
    ]);
  });

  it("splits sync and async variants and 'both X and Y' into separate requirements", () => {
    expect(
      requestRequirements(
        "Add a retry helper with sync and async versions. It must work for both the CLI and the server.",
      ).map((entry) => entry.statement),
    ).toEqual([
      "(sync) Add a retry helper with sync and async versions.",
      "(async) Add a retry helper with sync and async versions.",
      "(the CLI) It must work for both the CLI and the server.",
      "(the server) It must work for both the CLI and the server.",
    ]);
  });

  it("keeps prose around a list only when it states a constraint or an instruction", () => {
    const listed = requestRequirements(
      [
        "This repository already contains a working API.",
        "Extend it without changing any existing behavior:",
        "1. Bundles.",
        "2. Lookups.",
        "Run it as before.",
        "Use only the Python standard library.",
      ].join("\n"),
    );
    expect(listed.map((entry) => entry.statement)).toEqual([
      "Extend it without changing any existing behavior:",
      "Bundles.",
      "Lookups.",
      "Use only the Python standard library.",
    ]);
  });

  it("leaves out the project rules and recalled decisions VISP appended to the request", () => {
    const request = [
      "Make the module export the value two.",
      "",
      "Project rules the user stated for all later work on this project (they apply here too):",
      "R-1 Never log request bodies.",
      "",
      "Recorded decisions from earlier requests on this project. They are context:",
      "M1 Values are whole numbers.",
    ].join("\n");
    expect(requestRequirements(request)).toEqual([
      { id: "R001", statement: "Make the module export the value two." },
    ]);
  });

  it("ignores fenced code", () => {
    expect(
      requestRequirements(["Fix the parser.", "```", "- not a requirement", "```"].join("\n")),
    ).toEqual([{ id: "R001", statement: "Fix the parser." }]);
  });

  it("lists the benchmark requests at sizes the lean profile keeps", () => {
    const counts = Object.fromEntries(
      ["reservations-bundles", "spreadsheet-extend", "lighthouse-pixel", "slingshot-game"].map(
        (name) => [name, requestRequirements(task(name)).length],
      ),
    );
    expect(counts).toEqual({
      "reservations-bundles": 10,
      "spreadsheet-extend": 10,
      "lighthouse-pixel": 2,
      "slingshot-game": 16,
    });
    const bundles = requestRequirements(task("reservations-bundles")).map(
      (entry) => entry.statement.split(": ")[0],
    );
    expect(bundles).toContain("DELETE /v1/reservations/<id>");
    expect(bundles).toContain("POST /v1/reservations/<id>/confirm");
  });
});

describe("parseRequirementAccounts", () => {
  it("reads a check that shows a requirement, with an optional note, or a reason it is not done", () => {
    expect(
      parseRequirementAccounts([
        "R001=C001",
        "r002 = C002 test_bundle_conflict",
        "R003=not done: the request's paging needs a schema change",
      ]),
    ).toEqual({
      ok: true,
      value: [
        { id: "R001", status: "done", check: "C001" },
        { id: "R002", status: "done", check: "C002", note: "test_bundle_conflict" },
        {
          id: "R003",
          status: "not-done",
          reason: "the request's paging needs a schema change",
        },
      ],
    });
  });

  it("refuses entries without a check or a reason", () => {
    for (const entry of ["R001", "R001=", "R001=not done", "C001=R001", "R001=not done:  "]) {
      const parsed = parseRequirementAccounts([entry]);
      expect(parsed.ok, entry).toBe(false);
    }
  });
});

describe("at visp done", () => {
  let project: TestWorkspace | undefined;
  afterEach(async () => project?.destroy());
  function state() {
    if (!project) throw new Error("No project");
    return project.state();
  }

  async function started(request: string, files: Record<string, string> = {}) {
    project = await TestWorkspace.create(
      {
        "src/value.mjs": "export const value = 1;\nexport const label = 'one';\n",
        "test/value.test.mjs":
          "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value, label} from '../src/value.mjs'; test('two',()=>{assert.equal(value,2); assert.equal(label,'two');});\n",
        ...files,
      },
      { flip: false, profile: "lean" },
    );
    await project.installFoundation();
    project.commit("install foundation");
    const feature = await createProductFeature(await project.state(), {
      goal: "Return two",
      sourceBrief: request,
    });
    if (!feature.ok) throw new Error(feature.error.message);
    const worked = await runProductWork(await project.state(), {
      check: `${process.execPath} --test test/value.test.mjs`,
    });
    if (!worked.ok) throw new Error(worked.error.message);
    await project.write("src/value.mjs", "export const value = 2;\nexport const label = 'two';\n");
    return feature.value;
  }

  it("lists two or more requirements at feature and closes only once each is accounted for", async () => {
    const feature = await started("- Export value two.\n- Export label two.");
    expect(feature).toMatchObject({
      profile: { name: "lean" },
      requirements: ["R001: Export value two.", "R002: Export label two."],
      requirementsNote: expect.stringContaining("--account R001=<passing check id>"),
    });
    const unaccounted = await runProductDone(await state(), {});
    expect(unaccounted.ok && unaccounted.value).toMatchObject({
      closed: false,
      requirements: ["R001: open", "R002: open"],
      gaps: [expect.stringContaining("Requirements not accounted for: R001, R002")],
    });

    const unknown = await runProductDone(await state(), { account: ["R003=C001"] });
    expect(unknown.ok ? "accepted" : unknown.error.message).toContain("R003 is not listed");

    const wrongCheck = await runProductDone(await state(), {
      account: ["R001=C009", "R002=C001"],
    });
    expect(wrongCheck.ok && wrongCheck.value.gaps, JSON.stringify(wrongCheck)).toContain(
      "R001 cites C009, which has not passed on the current version; name a passing check or rerun it",
    );

    const closed = await runProductDone(await state(), {
      account: ["R001=C001 two", "R002=not done: the label stays as the request leaves it"],
    });
    expect(closed.ok && closed.value).toMatchObject({
      closed: true,
      requirements: [
        "R001: done, C001 two",
        "R002: not done, the label stays as the request leaves it",
      ],
    });
  });

  it("asks nothing of a request that states one requirement", async () => {
    const feature = await started("Make the public value two.");
    expect(feature).not.toHaveProperty("requirements");
    const closed = await runProductDone(await state(), {});
    expect(closed.ok && closed.value.closed).toBe(true);
  });

  it("moves a lean feature to the full profile when its change touches more than 15 files", async () => {
    await started("Make the public value two.");
    for (let index = 0; index < 15; index++)
      await project?.write(`src/extra-${index}.mjs`, `export const extra = ${index};\n`);
    const done = await runProductDone(await state(), {});
    expect(done.ok && done.value).toMatchObject({
      profile: { name: "full", reason: "the change touches 16 files, more than 15" },
    });
    const record = await readProductRecord(await state());
    expect(record.ok && record.value.state.profileEscalation?.reason).toBe(
      "the change touches 16 files, more than 15",
    );
  });
});
