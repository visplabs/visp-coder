import { expect, it } from "vitest";
import { sha256 } from "../../../../src/core/hash.js";
import { ok } from "../../../../src/core/result.js";
import { reviewCodeSources } from "../../../../src/workflow/product/code-context.js";
import {
  executionSchema,
  initialProductState,
  productBriefSchema,
} from "../../../../src/workflow/product/model.js";
import { independentSources } from "../../../../src/workflow/product/review/independent-sources.js";
import type { ProductRecord } from "../../../../src/workflow/product/store.js";
import { productContractDigest } from "../../../../src/workflow/product/subject.js";
import type { WorkspaceState } from "../../../../src/workflow/state.js";

const brief = productBriefSchema.parse({
  version: 2,
  feature: "001-packet",
  originalRequest:
    "Fix retirement and update README and docs/contract.md with the 410 response contract.",
  goal: "Retirement",
  outcomes: [{ id: "O001", kind: "functional", statement: "Retired resources return 410" }],
  checks: [
    {
      id: "C001",
      command: ["python3", "-m", "unittest", "discover", "-s", "tests", "-v"],
      outcomes: ["O001"],
      files: [],
      verifierFiles: ["tests/helper.py"],
    },
  ],
  slices: [
    {
      id: "T001",
      goal: "Retirement",
      outcomes: ["O001"],
      checks: ["C001"],
      scope: { allowed: ["src/", "tests/", "README.md", "docs/"] },
    },
  ],
});
const record: ProductRecord = {
  brief,
  briefText: "",
  stateText: "",
  state: initialProductState(brief, "2026-01-01"),
};
const execution = executionSchema.parse({
  id: "EXEC-current",
  check: "C001",
  task: "T001",
  subjectDigest: "current",
  contractDigest: productContractDigest(brief, brief.slices[0]),
  createdAt: "2026-01-01",
  command: "python3 -m unittest discover -s tests -v",
  status: "passed",
  exitCode: 0,
  durationMs: 12,
  output:
    "test_retired_returns_410 (tests.test_api.ApiTest) ... ok\ntest_invalid_sku (tests.test_api.ApiTest) ... FAIL\nFAILED (failures=1)",
  provenance: "supervisor-executed",
  assertions: "agent-reported",
});
function fixture(contents: Record<string, string>) {
  const workspace = {
    files: {
      readTextIfExists: async (path: string) => ok(contents[path]),
      readBytesIfExists: async (path: string) =>
        ok(contents[path] === undefined ? undefined : Buffer.from(contents[path])),
    },
  } as unknown as WorkspaceState;
  return {
    workspace,
    snapshot: Object.fromEntries(
      Object.entries(contents).map(([path, text]) => [path, sha256(text)]),
    ),
  };
}

it("supplies current executed verifier source and named results without check.files", async () => {
  const { workspace, snapshot } = fixture({
    "src/api.py": "def retire(): return 410",
    "tests/test_api.py": "def test_retired_returns_410():\n    assert retire() == 410",
    "tests/helper.py": "def response(): return 410",
    "tests/unrelated.txt": "noise",
  });
  const test = {
    ...record,
    state: {
      ...record.state,
      executions: [
        { ...execution, id: "EXEC-stale", subjectDigest: "old", output: "stale result" },
        execution,
      ],
    },
  };
  const sources = await reviewCodeSources(workspace, test, snapshot, "current", brief.slices[0]);
  expect(sources.find((source) => source.reference === "tests/test_api.py")?.excerpt).toContain(
    "assert retire() == 410",
  );
  expect(sources.some((source) => source.reference === "tests/helper.py")).toBe(true);
  const results = sources.find((source) => source.id === "CHECK-EXEC-current");
  expect(results?.excerpt).toContain("test_retired_returns_410");
  expect(results?.excerpt).toContain("test_invalid_sku");
  expect(results?.excerpt).toContain("FAIL");
  expect(sources.some((source) => source.id === "CHECK-EXEC-stale")).toBe(false);
});

it("reserves requested documentation and verifier excerpts when application files fill the cap", async () => {
  const contents = Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [
      `src/file${index}.js`,
      "function retire() { return 410; }\n".repeat(200),
    ]),
  );
  contents["README.md"] = `${"Intro\n".repeat(1500)}# Retirement\nRetired resources return 410.\n`;
  contents["docs/contract.md"] = "# Contract\nRetired resources return 410.\n";
  contents["docs/unrelated.md"] = "Unrelated notes";
  contents["tests/test_api.py"] = "def test_retired_returns_410():\n    assert retire() == 410";
  const { workspace, snapshot } = fixture(contents);
  const test = { ...record, state: { ...record.state, executions: [execution] } };
  const sources = await reviewCodeSources(workspace, test, snapshot, "current", brief.slices[0]);
  expect(sources.find((source) => source.reference === "README.md")?.excerpt).toContain(
    "Retired resources return 410",
  );
  expect(sources.some((source) => source.reference === "docs/contract.md")).toBe(true);
  expect(sources.some((source) => source.reference === "tests/test_api.py")).toBe(true);
  expect(sources.some((source) => source.id === "CHECK-EXEC-current")).toBe(true);
  expect(sources.find((source) => source.reference === "docs/unrelated.md")?.coreOutcomes).toEqual([
    "O001",
  ]);
  expect(sources.filter((source) => source.reference.startsWith("src/"))).toHaveLength(12);
  expect(sources.reduce((sum, source) => sum + source.excerpt.length, 0)).toBeLessThanOrEqual(
    32000,
  );
  const delivered = await independentSources(workspace, sources);
  expect(delivered.ok).toBe(true);
  if (!delivered.ok) return;
  expect(delivered.value.find((source) => source.reference === "README.md")?.excerpt).toContain(
    "410",
  );
  expect(
    delivered.value.reduce((sum, source) => sum + source.excerpt.length, 0),
  ).toBeLessThanOrEqual(32000);
});

it("puts the explicit executed entry ahead of broad declared application inputs", async () => {
  const nodeBrief = productBriefSchema.parse({
    ...brief,
    checks: [
      {
        ...brief.checks[0],
        command: ["node", "--test", "tests/api.test.mjs"],
        files: ["src/**"],
        verifierFiles: ["tests/helper.mjs"],
      },
    ],
  });
  const contents = Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => [`src/file${i}.js`, "export const value = 410"]),
  );
  contents["tests/api.test.mjs"] = "test('retired returns 410', () => assert.equal(retire(), 410))";
  contents["tests/helper.mjs"] = "export const retired = 410";
  const { workspace, snapshot } = fixture(contents);
  const test = {
    ...record,
    brief: nodeBrief,
    state: {
      ...record.state,
      executions: [
        { ...execution, contractDigest: productContractDigest(nodeBrief, nodeBrief.slices[0]) },
      ],
    },
  };
  const sources = await reviewCodeSources(
    workspace,
    test,
    snapshot,
    "current",
    nodeBrief.slices[0],
  );
  expect(sources.find((source) => source.reference === "tests/api.test.mjs")?.excerpt).toContain(
    "assert.equal",
  );
});

it.each([0, 2000])(
  "delivers named results and coverage gaps through a reviewer packet (%i noise lines)",
  async (noiseLines) => {
    const { productWorkspace } = await import("../../support/product-workspace.js");
    const { updateProductBrief, runProductWork, runProductVerify } = await import(
      "../../../../src/workflow/product/index.js"
    );
    const { runProductReviewRequest } = await import(
      "../../../../src/workflow/product/review/review-request.js"
    );
    const p = await productWorkspace();
    try {
      const script = `import assert from 'node:assert/strict';\nimport {value} from '../src/value.mjs';\nassert.equal(value, 2);\nconsole.log('PASS: the promised value is two');\nconsole.log('NOT OBSERVED: retry after error: 0 qualifying events');\nconsole.log('verbose setup noise\\n'.repeat(${noiseLines}));\n`;
      await p.workspace.write("test/check.mjs", script);
      const updated = await updateProductBrief(await p.workspace.state(), {
        brief: {
          ...p.brief,
          checks: [
            { ...p.brief.checks[0], command: [process.execPath, "test/check.mjs"], files: [] },
          ],
          slices: [
            {
              ...p.brief.slices[0],
              scope: { allowed: ["src/value.mjs", "test/check.mjs"], expected: [], forbidden: [] },
            },
          ],
        },
        reason: "Use the executed assertion entry without file hints",
      });
      expect(updated.ok).toBe(true);
      expect((await runProductWork(await p.workspace.state(), { task: "T001" })).ok).toBe(true);
      await p.workspace.write("src/value.mjs", "export const value = 2;\n");
      const verified = await runProductVerify(await p.workspace.state(), { task: "T001" });
      expect(verified.ok).toBe(true);
      const state = await p.workspace.state();
      const prepared = await runProductReviewRequest(state, { prepare: true, task: "T001" });
      if (!prepared.ok) throw new Error(prepared.error.message);
      const packetPath = (prepared.value as { packetPath: string }).packetPath;
      const read = await state.files.readText(packetPath);
      if (!read.ok) throw new Error(read.error.message);
      const packet = JSON.parse(read.value);
      expect(
        packet.sources.find(
          (source: { reference: string }) => source.reference === "test/check.mjs",
        )?.excerpt,
      ).toContain("assert.equal(value, 2)");
      expect(
        packet.sources.find((source: { kind: string }) => source.kind === "executed-check")
          ?.excerpt,
      ).toContain("PASS: the promised value is two");
      const result = packet.sources.find(
        (source: { kind: string }) => source.kind === "executed-check",
      )?.excerpt;
      expect(result).toContain("NOT OBSERVED: retry after error: 0 qualifying events");
      expect(result).toMatch(/coverage gap/i);
      // pm1b-slingshot-game-visp-b4-1: the reviewer rated a flow satisfied although winning level 1
      // was NOT OBSERVED, trusting the worker's own one-degree-precise winning shots; the
      // hidden check's coarse search found no win.
      expect(result).toContain(
        "is unmet: do not rate its outcome satisfied; report a required finding naming it, even when the implementer's own tests or one precise input sequence reach it",
      );
      expect(result).toContain(
        "Only when the test source shows its search cannot work (inputs outside the stated range, a wrong hook, a helper error), say so in limitations instead",
      );
      expect(result).toContain("passed; exit 0");
      expect(
        packet.evidence
          .filter((entry: { kind: string; status: string }) => entry.kind === "execution")
          .some((entry: { status: string }) => entry.status === "available"),
      ).toBe(true);
    } finally {
      await p.workspace.destroy();
    }
  },
);

it.each([
  ["node", "--test", "tests/api.test.mjs"],
  ["npm", "test"],
  ["sh", "-c", "node --test tests/api.test.mjs"],
  ["./tests/check.sh"],
])("finds empty-file-list verifier entries through %j", async (...command) => {
  const { reviewCheckPaths } = await import(
    "../../../../src/workflow/product/review/review-check-context.js"
  );
  const { productCheckSchema } = await import("../../../../src/workflow/product/model.js");
  const { workspace, snapshot } = fixture({
    "package.json": JSON.stringify({ scripts: { test: "node --test tests/api.test.mjs" } }),
    "tests/api.test.mjs": "test('retired', () => assert.equal(retire(), 410))",
    "tests/check.sh": "node --test tests/api.test.mjs",
    ".env": "PRIVATE_TOKEN=secret",
  });
  const check = productCheckSchema.parse({ id: "C001", command, files: [] });
  const paths = await reviewCheckPaths(workspace, [check], snapshot);
  expect(paths).toContain(
    command[0] === "./tests/check.sh" ? "tests/check.sh" : "tests/api.test.mjs",
  );
  expect(paths).not.toContain(".env");
});

it.each([
  ["pnpm", "exec", "vitest", "run", "tests/api"],
  ["npm", "exec", "--", "vitest", "run", "tests/api"],
  ["npx", "--yes", "vitest", "run", "tests/api"],
  ["yarn", "exec", "vitest", "run", "tests/api"],
  ["bun", "x", "vitest", "run", "tests/api"],
])(
  "delivers wrapped runner assertions and retains other scoped candidates: %j",
  async (...command) => {
    const wrappedBrief = productBriefSchema.parse({
      ...brief,
      checks: [{ ...brief.checks[0], command, files: [], verifierFiles: [] }],
    });
    const { workspace, snapshot } = fixture({
      "tests/other.test.ts": "test('other', () => expect(1).toBe(1))",
      "tests/api/retirement.test.ts": "test('retired', () => expect(retire()).toBe(410))",
    });
    const sources = await reviewCodeSources(
      workspace,
      {
        ...record,
        brief: wrappedBrief,
        state: {
          ...record.state,
          executions: [
            {
              ...execution,
              contractDigest: productContractDigest(wrappedBrief, wrappedBrief.slices[0]),
            },
          ],
        },
      },
      snapshot,
      "current",
      wrappedBrief.slices[0],
    );
    expect(
      sources.find((source) => source.reference === "tests/api/retirement.test.ts")?.excerpt,
    ).toContain("expect(retire()).toBe(410)");
    expect(
      sources.find((source) => source.reference === "tests/other.test.ts")?.coreOutcomes,
    ).toEqual(["O001"]);
    const { reviewCheckPaths } = await import(
      "../../../../src/workflow/product/review/review-check-context.js"
    );
    expect(await reviewCheckPaths(workspace, wrappedBrief.checks, snapshot)).toEqual([
      "tests/api/retirement.test.ts",
    ]);
  },
);

it("discloses unresolved executed assertion sources in the packet", async () => {
  const unknownBrief = productBriefSchema.parse({
    ...brief,
    checks: [{ ...brief.checks[0], command: ["unknown-runner"], files: [], verifierFiles: [] }],
  });
  const { workspace, snapshot } = fixture({ "src/api.py": "def retire(): return 410" });
  const sources = await reviewCodeSources(
    workspace,
    {
      ...record,
      brief: unknownBrief,
      state: {
        ...record.state,
        executions: [
          {
            ...execution,
            output: "PASS: retirement returns 410\n".repeat(300),
            contractDigest: productContractDigest(unknownBrief, unknownBrief.slices[0]),
          },
        ],
      },
    },
    snapshot,
    "current",
    unknownBrief.slices[0],
  );
  expect(sources.find((source) => source.kind === "executed-check")?.excerpt).toMatch(
    /source.*(?:unresolved|unavailable)/i,
  );
});

it("prioritizes an exact requested path over unrelated same-basename deliverables", async () => {
  const docsBrief = productBriefSchema.parse({
    ...brief,
    originalRequest: "Update docs/z/README.md with the retirement contract.",
    checks: [],
    slices: [{ ...brief.slices[0], checks: [], scope: { allowed: ["docs/**"] } }],
  });
  const contents = Object.fromEntries(
    Array.from({ length: 9 }, (_, index) => [`docs/a${index}/README.md`, "Unchanged subsystem"]),
  );
  contents["docs/z/README.md"] = "CHANGED: retirement contract";
  const { workspace, snapshot } = fixture(contents);
  const sources = await reviewCodeSources(
    workspace,
    { ...record, brief: docsBrief },
    snapshot,
    "current",
    docsBrief.slices[0],
  );
  expect(sources.find((source) => source.reference === "docs/z/README.md")?.excerpt).toContain(
    "CHANGED",
  );
});

it.each([
  ["pnpm", "exec", "vitest", "run"],
  ["npm", "exec", "--", "vitest", "run"],
  ["npx", "--yes", "vitest", "run"],
  ["yarn", "exec", "vitest", "run"],
  ["bun", "x", "vitest", "run"],
])("discovers empty-file-list suites through %j without entry hints", async (...command) => {
  const wrappedBrief = productBriefSchema.parse({
    ...brief,
    checks: [{ ...brief.checks[0], command, files: [], verifierFiles: [] }],
  });
  const { workspace, snapshot } = fixture({
    "tests/api.test.ts": "test('retired', () => expect(retire()).toBe(410))",
  });
  const sources = await reviewCodeSources(
    workspace,
    {
      ...record,
      brief: wrappedBrief,
      state: {
        ...record.state,
        executions: [
          {
            ...execution,
            contractDigest: productContractDigest(wrappedBrief, wrappedBrief.slices[0]),
          },
        ],
      },
    },
    snapshot,
    "current",
    wrappedBrief.slices[0],
  );
  expect(sources.find((source) => source.reference === "tests/api.test.ts")?.excerpt).toContain(
    "expect(retire()).toBe(410)",
  );
});

it("prioritizes documents changed under the slice's authorization in prepared packets", async () => {
  const { TestWorkspace } = await import("../../support/workspace.js");
  const { createProductFeature, updateProductBrief, runProductWork } = await import(
    "../../../../src/workflow/product/index.js"
  );
  const { runProductReviewRequest } = await import(
    "../../../../src/workflow/product/review/review-request.js"
  );
  const workspace = await TestWorkspace.create({
    "test/docs.test.mjs":
      "import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; assert.match(readFileSync('docs/z/README.md', 'utf8'), /retirement contract/);",
  });
  try {
    await workspace.installFoundation();
    workspace.commit("install foundation");
    const started = await createProductFeature(await workspace.state(), {
      goal: "Update README documentation for retirement.",
    });
    if (!started.ok) throw new Error(started.error.message);
    for (let index = 0; index < 9; index++)
      await workspace.write(`docs/a${index}/README.md`, "Unchanged subsystem");
    await workspace.write("docs/z/README.md", "Old contract");
    const updated = await updateProductBrief(await workspace.state(), {
      brief: {
        ...started.value.brief,
        outcomes: [
          { id: "O001", kind: "functional", statement: "Documents the retirement contract" },
        ],
        checks: [
          {
            id: "C001",
            command: [process.execPath, "test/docs.test.mjs"],
            outcomes: ["O001"],
            files: ["test/docs.test.mjs"],
          },
        ],
        slices: [
          {
            id: "T001",
            goal: "Document retirement",
            outcomes: ["O001"],
            checks: ["C001"],
            scope: { allowed: ["docs/**", "test/docs.test.mjs"] },
          },
        ],
      },
      reason: "Exercise requested deliverables changed under the current authorization",
    });
    if (!updated.ok) throw new Error(updated.error.message);
    const worked = await runProductWork(await workspace.state(), { task: "T001" });
    if (!worked.ok) throw new Error(worked.error.message);
    await workspace.write("docs/z/README.md", "CHANGED: retirement contract");
    const state = await workspace.state();
    const prepared = await runProductReviewRequest(state, { prepare: true, task: "T001" });
    if (!prepared.ok) throw new Error(prepared.error.message);
    const packetRead = await state.files.readText(
      (prepared.value as { packetPath: string }).packetPath,
    );
    if (!packetRead.ok) throw new Error(packetRead.error.message);
    const packet = JSON.parse(packetRead.value);
    expect(
      packet.sources.find(
        (source: { reference: string }) => source.reference === "docs/z/README.md",
      )?.excerpt,
    ).toContain("CHANGED: retirement contract");
  } finally {
    await workspace.destroy();
  }
});

it("delivers every CLI must-outcome implementation before large verifier sources", async () => {
  const cliBrief = productBriefSchema.parse({
    ...brief,
    originalRequest: "Build a CLI that evaluates formulas and saves cells",
    outcomes: [
      { id: "O001", kind: "functional", statement: "Evaluates formulas" },
      { id: "O002", kind: "functional", statement: "Saves cells" },
    ],
    slices: [
      {
        ...brief.slices[0],
        outcomes: ["O001", "O002"],
        scope: { allowed: ["src/**", "tests/**"] },
      },
    ],
  });
  const contents = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [
      `src/module${i}.py`,
      `def formula${i}():\n    return ${i}\n`,
    ]),
  );
  contents["src/cli.py"] = "from module11 import formula11\nprint(formula11())\n";
  for (let i = 0; i < 12; i++)
    contents[`tests/test_${i}.py`] = "def test_formula():\n    assert True\n".repeat(2000);
  const { workspace, snapshot } = fixture(contents);
  const sources = await reviewCodeSources(
    workspace,
    { ...record, brief: cliBrief },
    snapshot,
    "current",
  );
  const delivered = await independentSources(workspace, sources);
  if (!delivered.ok) throw new Error(delivered.error.message);
  const serialized = JSON.parse(JSON.stringify(delivered.value));
  for (const path of Object.keys(contents).filter((path) => path.startsWith("src/"))) {
    expect(
      serialized.find((source: { reference: string }) => source.reference === path)?.excerpt,
      path,
    ).toBe(contents[path]);
  }
  expect(JSON.stringify(serialized).length).toBeLessThanOrEqual(32000);
});

it("delivers relevant symbols and outcome limitations when a UI core file exceeds the packet", async () => {
  const uiBrief = productBriefSchema.parse({
    ...brief,
    originalRequest: "Show the retirement result in a single page UI",
    checks: [],
    slices: [{ ...brief.slices[0], checks: [], scope: { allowed: ["index.html"] } }],
  });
  const content = `<main>Retirement</main><script>\n${"// unrelated setup\n".repeat(3000)}function retirementResult() {\n${"  const padding = 'large';\n".repeat(2000)}  return 410;\n}\n</script>`;
  const { workspace, snapshot } = fixture({ "index.html": content });
  const sources = await reviewCodeSources(
    workspace,
    { ...record, brief: uiBrief },
    snapshot,
    "current",
  );
  const delivered = await independentSources(workspace, sources);
  if (!delivered.ok) throw new Error(delivered.error.message);
  const serialized = JSON.parse(JSON.stringify(delivered.value));
  const core = serialized.find(
    (source: { reference: string }) => source.reference === "index.html",
  );
  expect(core.excerpt).toContain("function retirementResult()");
  expect(core.truncated).toBe(true);
  expect(
    serialized.find((source: { id: string }) => source.id === "CODE-CORE-GAPS")?.excerpt,
  ).toContain("O001");
  expect(JSON.stringify(serialized).length).toBeLessThanOrEqual(32000);
});

it("resolves unchanged product entry and transitive dependencies from executed verifier commands outside the slice", async () => {
  const scoped = productBriefSchema.parse({
    ...brief,
    checks: [{ ...brief.checks[0], command: ["node", "tests/check.mjs"], files: [] }],
    slices: [{ ...brief.slices[0], scope: { allowed: ["tests/**"] } }],
  });
  const { workspace, snapshot } = fixture({
    "tests/check.mjs": "import {run} from '../cli.mjs'; run();",
    "cli.mjs": "import {retire} from './lib/api.mjs'; export const run = retire;",
    "lib/api.mjs": "export function retire() { return 410; }",
    "unrelated.mjs": "export const secret = 'unrelated';",
  });
  const sources = await reviewCodeSources(
    workspace,
    { ...record, brief: scoped },
    snapshot,
    "current",
    scoped.slices[0],
  );
  const delivered = await independentSources(workspace, sources);
  if (!delivered.ok) throw new Error(delivered.error.message);
  expect(
    delivered.value
      .filter((source) => source.coreOutcomes !== undefined)
      .map((source) => source.reference),
  ).toEqual(["cli.mjs", "lib/api.mjs", "tests/check.mjs"]);
  expect(delivered.value.some((source) => source.reference === "unrelated.mjs")).toBe(false);
});

it("compacts identical verifier excerpts and check output while retaining their separate identities", async () => {
  const { deliveredSources } = await import(
    "../../../../src/workflow/product/review/review-source-delivery.js"
  );
  const verifier = "test('retired', () => assert.equal(retire(), 410));\n".repeat(100);
  const sources = ["A", "B"].flatMap((id) => [
    {
      id: `CODE-${id}`,
      kind: "implementation-file" as const,
      reference: `tests/${id}.mjs`,
      sha256: sha256(verifier),
      available: true,
      excerpt: verifier,
    },
    {
      id: `CHECK-${id}`,
      kind: "executed-check" as const,
      reference: `Execution ${id}`,
      sha256: sha256(id),
      available: true,
      excerpt: `Check ${id}; execution ${id}; passed; exit 0\nCommand executed: same\nPASS: retirement returns 410\n`,
    },
  ]);
  const delivered = await deliveredSources(sources, new Map());
  expect(delivered.map((source) => source.id).sort()).toEqual(
    sources.map((source) => source.id).sort(),
  );
  expect(delivered.find((source) => source.id === "CODE-B")?.excerpt).toContain("CODE-A");
  expect(delivered.find((source) => source.id === "CHECK-B")?.excerpt).toContain("CHECK-A");
  expect(delivered.find((source) => source.id === "CHECK-B")?.excerpt).toContain("passed; exit 0");
  expect(delivered.reduce((cost, source) => cost + source.excerpt.length, 0)).toBeLessThan(
    verifier.length + 1000,
  );
});

it("keeps changed implementation core when source scope hints do not identify it", async () => {
  const { workspace, snapshot } = fixture({
    "src/api.py": "def retire(): return 410",
    "shared/status.py": "def retired_status(): return 410",
  });
  const sources = await reviewCodeSources(
    workspace,
    record,
    snapshot,
    "current",
    brief.slices[0],
    new Set(["shared/status.py"]),
  );
  expect(sources.find((source) => source.reference === "shared/status.py")).toMatchObject({
    coreOutcomes: ["O001"],
    available: true,
    excerpt: "def retired_status(): return 410",
  });
});

it("delivers full core whenever it fits the serialized budget without reserving an unnecessary gap", async () => {
  const { deliveredSources } = await import(
    "../../../../src/workflow/product/review/review-source-delivery.js"
  );
  const text = `function core() { return '${"x".repeat(31500)}'; }`;
  const source = {
    id: "CORE",
    kind: "implementation-file" as const,
    reference: "app.js",
    sha256: sha256(text),
    available: true,
    coreOutcomes: ["O001"],
    excerpt: text.slice(0, 100),
    truncated: true,
  };
  const delivered = await deliveredSources([source], new Map([["CORE", text]]));
  expect(delivered.find((entry) => entry.id === "CORE")?.excerpt).toBe(text);
  expect(delivered.some((entry) => entry.id === "CODE-CORE-GAPS")).toBe(false);
  expect(JSON.stringify(delivered).length).toBeLessThanOrEqual(32000);
});

it("resolves emitted JavaScript import paths to the TypeScript implementation", async () => {
  const scoped = productBriefSchema.parse({
    ...brief,
    checks: [],
    slices: [{ ...brief.slices[0], checks: [], scope: { allowed: ["src/main.ts"] } }],
  });
  const { workspace, snapshot } = fixture({
    "src/main.ts": "import { retire } from '../shared/api.js'; export const result = retire();",
    "shared/api.ts": "export function retire() { return 410; }",
  });
  const sources = await reviewCodeSources(
    workspace,
    { ...record, brief: scoped },
    snapshot,
    "current",
  );
  expect(sources.find((source) => source.reference === "shared/api.ts")).toMatchObject({
    available: true,
    coreOutcomes: ["O001"],
    excerpt: "export function retire() { return 410; }",
  });
});

it("retains observed verifier candidates with nonstandard filenames and discloses limited core", async () => {
  const scoped = productBriefSchema.parse({
    ...brief,
    originalRequest: "Build a formula CLI",
    checks: [
      {
        ...brief.checks[0],
        command: ["node", "verify.mjs"],
        files: ["**"],
        verifierFiles: ["verify.mjs"],
      },
    ],
    slices: [{ ...brief.slices[0], scope: { allowed: ["**"] } }],
  });
  const engine = `def evaluate(): return 410\n${"# implementation context\n".repeat(900)}`;
  const { workspace, snapshot } = fixture({
    "cli.py": "from engine import evaluate\nprint(evaluate())\n",
    "engine.py": engine,
    "verify.mjs": `import assert from 'node:assert/strict';\n${"assert.equal(410, 410);\n".repeat(5000)}`,
  });
  const sources = await reviewCodeSources(
    workspace,
    { ...record, brief: scoped },
    snapshot,
    "current",
  );
  expect(sources.find((source) => source.reference === "verify.mjs")?.coreOutcomes).toEqual([
    "O001",
  ]);
  const delivered = await independentSources(workspace, sources);
  if (!delivered.ok) throw new Error(delivered.error.message);
  expect(delivered.value.find((source) => source.reference === "engine.py")?.excerpt).toContain(
    "def evaluate()",
  );
  expect(delivered.value.find((source) => source.id === "CODE-CORE-GAPS")?.excerpt).toContain(
    "O001",
  );
});

it("keeps failed receipts linked to their failure source when stdout matches a passing receipt", async () => {
  const { deliveredSourceEvidence } = await import(
    "../../../../src/workflow/product/review/review-source-delivery.js"
  );
  const sources = ["failed", "passed"].map((status) => ({
    id: `CHECK-${status}`,
    kind: "executed-check" as const,
    reference: status,
    sha256: sha256(status),
    available: true,
    excerpt: `Check ${status}; no output`,
  }));
  const evidence = [
    {
      id: "CHECK-failed",
      kind: "execution" as const,
      status: "failed" as const,
      summary: "C001: same command\n",
      outcomes: ["O001"],
    },
    {
      id: "CHECK-passed",
      kind: "execution" as const,
      status: "available" as const,
      summary: "C001: same command\n",
      outcomes: ["O001"],
    },
  ];
  const delivered = deliveredSourceEvidence(evidence, sources, sources);
  expect(delivered[0]).toMatchObject({
    status: "failed",
    summary: expect.stringContaining("CHECK-failed"),
  });
  expect(delivered[1]).toMatchObject({
    status: "available",
    summary: expect.stringContaining("CHECK-passed"),
  });
});

it("prepares a review when a check reads a non-UTF-8 fixture file", async () => {
  const { productWorkspace } = await import("../../support/product-workspace.js");
  const { updateProductBrief, runProductWork, runProductVerify } = await import(
    "../../../../src/workflow/product/index.js"
  );
  const { runProductReviewRequest } = await import(
    "../../../../src/workflow/product/review/review-request.js"
  );
  const p = await productWorkspace();
  try {
    // Repositories keep encoding fixtures such as Django's tests/i18n/commands/not_utf8.sample.
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
    await p.workspace.write("test/latin1.sample", latin1);
    await p.workspace.write(
      "test/check.mjs",
      "import assert from 'node:assert/strict';\nimport {readFileSync} from 'node:fs';\nimport {value} from '../src/value.mjs';\nassert.equal(readFileSync('test/latin1.sample').length, 5);\nassert.equal(value, 2);\n",
    );
    p.workspace.commit("encoding fixture");
    const updated = await updateProductBrief(await p.workspace.state(), {
      brief: {
        ...p.brief,
        checks: [
          {
            ...p.brief.checks[0],
            command: [process.execPath, "test/check.mjs", "test/latin1.sample"],
            files: [],
          },
        ],
        slices: [
          {
            ...p.brief.slices[0],
            scope: { allowed: ["src/value.mjs", "test/**"], expected: [], forbidden: [] },
          },
        ],
      },
      reason: "Check reads an encoding fixture",
    });
    expect(updated.ok).toBe(true);
    expect((await runProductWork(await p.workspace.state(), { task: "T001" })).ok).toBe(true);
    await p.workspace.write("src/value.mjs", "export const value = 2;\n");
    expect((await runProductVerify(await p.workspace.state(), { task: "T001" })).ok).toBe(true);
    const state = await p.workspace.state();
    const prepared = await runProductReviewRequest(state, { prepare: true, task: "T001" });
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
  } finally {
    await p.workspace.destroy();
  }
});
