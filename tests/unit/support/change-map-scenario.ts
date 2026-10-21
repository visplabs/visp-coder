import { refreshRepository } from "../../../src/graph/index.js";
import {
  createProductFeature,
  runProductDone,
  runProductReview,
  runProductVerify,
  runProductWork,
  updateProductBrief,
} from "../../../src/workflow/product/index.js";
import { value } from "./ui-scenario.js";
import { TestWorkspace } from "./workspace.js";

const node = process.execPath;
const test = (name: string, body: string) =>
  `import {test} from 'node:test'; import assert from 'node:assert/strict'; ${body}\ntest(${JSON.stringify(name)}, () => check());\n`;

const CSV_BEFORE = `export function cell(value) {
  return String(value);
}

export function row(values) {
  return values.map(cell).join(",");
}
`;

/** Quotes commas, but not yet embedded quotes: what the review finding is about. */
const CSV_QUOTED = `export function cell(value) {
  const text = String(value);
  return text.includes(",") ? \`"\${text}"\` : text;
}

export function row(values) {
  return values.map(cell).join(",");
}
`;

/** Changed again after slice T002's checkpoint, so its check run is out of date. */
const CSV_AFTER = `export function cell(value) {
  const text = String(value);
  return /[",\\n]/.test(text) ? \`"\${text.replaceAll('"', '""')}"\` : text;
}

export function row(values) {
  return values.map(cell).join(",");
}
`;

/**
 * A feature recorded by the real workflow with a code change worth mapping: two slices with
 * checkpoints, a check made stale by a later edit, an optional finding naming a line, and an
 * edit no slice names. Every record comes from the services the CLI runs.
 */
export async function changeMapScenario(): Promise<{ workspace: TestWorkspace; feature: string }> {
  const workspace = await TestWorkspace.create({
    "src/csv.mjs": CSV_BEFORE,
    "src/report.mjs": `import { row } from "./csv.mjs";

export function header() {
  return row(["name", "amount"]);
}

export function render(rows) {
  return [header(), ...rows.map((entry) => row([entry.name, entry.amount]))].join("\\n");
}
`,
    "src/download.mjs": `import { render } from "./report.mjs";

export function download(rows) {
  return { name: "report.csv", body: render(rows) };
}

export function preview(api) {
  return api.cell("total");
}
`,
    "test/report.test.mjs": test(
      "report has a header",
      "import {header} from '../src/report.mjs'; const check = () => assert.equal(header(), 'name,amount');",
    ),
    "test/csv.test.mjs": test(
      "cells with commas are quoted",
      "import {cell} from '../src/csv.mjs'; const check = () => assert.equal(cell('a,b'), '\"a,b\"');",
    ),
  });
  try {
    await workspace.installFoundation();
    workspace.commit("install foundation");
    const feature = await recordFeature(workspace);
    return { workspace, feature };
  } catch (error) {
    await workspace.destroy();
    throw error;
  }
}

async function recordFeature(workspace: TestWorkspace): Promise<string> {
  const created = value(
    await createProductFeature(await workspace.state(), {
      goal: "Export reports as CSV",
      sourceBrief:
        "Let people download the monthly report as CSV with a header row; values with commas or quotes must survive a spreadsheet.",
    }),
  );
  const feature = created.brief.feature;
  value(
    await updateProductBrief(await workspace.state(), {
      brief: {
        ...created.brief,
        outcomes: [
          {
            id: "O001",
            kind: "functional",
            statement: "The CSV starts with a header row",
            priority: "must",
            provenance: "user-stated",
          },
          {
            id: "O002",
            kind: "functional",
            statement: "Values containing commas or quotes are escaped",
            priority: "must",
            provenance: "user-stated",
          },
        ],
        checks: [
          {
            id: "C001",
            command: [node, "--test", "test/report.test.mjs"],
            outcomes: ["O001"],
            files: ["src/report.mjs", "test/report.test.mjs"],
            environment: "node",
          },
          {
            id: "C002",
            command: [node, "--test", "test/csv.test.mjs"],
            outcomes: ["O002"],
            files: ["test/csv.test.mjs"],
            environment: "node",
          },
        ],
        slices: [
          {
            id: "T001",
            goal: "Write the header row",
            outcomes: ["O001"],
            scope: { allowed: ["src/report.mjs"], expected: ["src/report.mjs"], forbidden: [] },
            checks: ["C001"],
          },
          {
            id: "T002",
            goal: "Escape cells the way spreadsheets expect",
            outcomes: ["O002"],
            dependsOn: ["T001"],
            scope: {
              allowed: ["src/csv.mjs", "test/csv.test.mjs"],
              expected: ["src/csv.mjs"],
              forbidden: [],
            },
            checks: ["C002"],
          },
        ],
      },
      reason: "Plan the export",
    }),
  );
  workspace.commit("plan the CSV export");

  value(await runProductWork(await workspace.state(), { feature, task: "T001" }));
  await workspace.write(
    "src/report.mjs",
    `import { row } from "./csv.mjs";

const COLUMNS = ["name", "amount"];

export function header() {
  return row(COLUMNS);
}

export function render(rows) {
  return [header(), ...rows.map((entry) => row([entry.name, entry.amount]))].join("\\n");
}
`,
  );
  value(await runProductDone(await workspace.state(), { feature, task: "T001" }));

  value(await runProductWork(await workspace.state(), { feature, task: "T002" }));
  await workspace.write("src/csv.mjs", CSV_QUOTED);
  const passed = value(await runProductVerify(await workspace.state(), { feature, task: "T002" }))
    .executions[0];
  if (!passed) throw new Error("Missing execution");
  value(
    await runProductReview(await workspace.state(), {
      feature,
      task: "T002",
      subjectDigest: passed.subjectDigest,
      assessments: [],
      reviewer: { context: "fresh", model: "gpt-6-sol" },
      feedback: {
        phase: "product",
        summary: "Commas are quoted; embedded quotes are not doubled.",
        dimensions: [
          {
            dimension: "functional",
            status: "unclear",
            reason: "Quotes inside a value are not covered.",
            evidence: [passed.id],
          },
        ],
        resolutions: [],
        findings: [
          {
            dimension: "functional",
            required: false,
            problem:
              'src/csv.mjs:3 wraps a value in quotes but leaves inner quotes alone, so He said "hi" breaks the row.',
            nextCheck: "Add a C002 case for a value containing a double quote.",
            outcomes: ["O002"],
            evidence: [passed.id],
          },
        ],
      },
    }),
  );
  value(await runProductDone(await workspace.state(), { feature, task: "T002" }));

  // After both slices closed: one more fix to the cell, and an edit no slice names.
  await workspace.write("src/csv.mjs", CSV_AFTER);
  await workspace.write(
    "src/download.mjs",
    `import { render } from "./report.mjs";

export function download(rows, month) {
  return { name: \`report-\${month}.csv\`, body: render(rows) };
}

export function preview(api) {
  return api.cell("total");
}
`,
  );
  const state = await workspace.state();
  value(await refreshRepository(state.paths.root, state.config.graph, state.paths.graphStore));
  return feature;
}
