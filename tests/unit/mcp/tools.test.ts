import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { runtimeIdentity } from "../../../src/core/version.js";
import { TOOL } from "../../../src/mcp/constants.js";
import { scopePayload } from "../../../src/mcp/resources/payloads.js";
import { registerTools } from "../../../src/mcp/tools/index.js";
import { now } from "../../../src/workflow/artifacts/common.js";
import { runInit } from "../../../src/workflow/stages/init.js";
import { runJson } from "../cli/support/cli.js";
import { legacyStore } from "../support/legacy-store.js";
import { TestWorkspace, task } from "../support/workspace.js";

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

/** Captures what `registerTools` registers, without standing up a transport. */
function collectTools(root: string): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const recorder = {
    registerTool(
      name: string,
      config: { inputSchema: z.ZodRawShape | z.AnyZodObject },
      callback: Handler,
    ) {
      expect(handlers.has(name), `${name} must only be registered once`).toBe(false);
      expect(
        (config.inputSchema instanceof z.ZodObject
          ? config.inputSchema
          : z.object(config.inputSchema)
        ).safeParse(VALID_ARGS[name]).success,
        `${name} fixture arguments satisfy the published schema`,
      ).toBe(true);
      handlers.set(name, callback);
      return {};
    },
  };

  registerTools(recorder as unknown as McpServer, root);
  return handlers;
}

/** Arguments that satisfy each tool's schema, so the handler runs its real path. */
const VALID_ARGS: Record<string, Record<string, unknown>> = {
  [TOOL.reproduce]: {
    finding: "FB-missing",
    execution: "missing",
    explanation: "Reproduce the report",
  },
  [TOOL.critic]: {},
  [TOOL.userFeedback]: { operation: "status" },
  [TOOL.next]: {},
  [TOOL.status]: {},
  [TOOL.feature]: { goal: "add login" },
  [TOOL.brief]: {},
  [TOOL.work]: {},
  [TOOL.capture]: { journey: { url: "http://localhost:3000", actions: [] } },
  [TOOL.observations]: { criterion: "AC001" },
  [TOOL.guard]: { paths: ["src/a.ts"] },
  [TOOL.verify]: {},
  [TOOL.review]: {},
  [TOOL.done]: {},
  [TOOL.accept]: {},
  [TOOL.query]: { operation: "describe" },
  [TOOL.index]: {},
  [TOOL.doctor]: {},
};

const roots: string[] = [];

async function tempProject(initialize: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "visp-mcp-unit-"));
  roots.push(root);
  if (initialize) {
    // A manifest gives init a detectable preset, so the generated visp.yml
    // lists validation commands rather than an empty (null) YAML key.
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "fixture", scripts: { test: "echo ok" } }),
    );
    execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
    const init = await runInit({ root, harness: "generic" });
    expect(init.ok).toBe(true);
  }
  return root;
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("registerTools", () => {
  it("registers exactly the documented tool names", async () => {
    const handlers = collectTools(await tempProject(false));
    expect([...handlers.keys()].sort()).toEqual(Object.values(TOOL).sort());
  });

  it("covers every registered tool with valid arguments", async () => {
    const handlers = collectTools(await tempProject(false));
    expect(Object.keys(VALID_ARGS).sort()).toEqual([...handlers.keys()].sort());
  });
});

it("includes the calling MCP runtime in structured and human-readable doctor output", async () => {
  const handlers = collectTools(await tempProject(true));
  const result = await handlers.get(TOOL.doctor)?.({});
  expect(result?.structuredContent).toMatchObject({
    ok: true,
    data: { runtime: runtimeIdentity() },
  });
  expect(JSON.stringify(result?.content)).toContain(runtimeIdentity().buildId);
});

it.each(["missing", "malformed"])(
  "keeps CLI and MCP runtime identity available for a %s workspace",
  async (kind) => {
    const root = await tempProject(kind === "malformed");
    if (kind === "malformed") await writeFile(join(root, "visp.yml"), "bad: [");
    const handlers = collectTools(root);
    const mcp = await handlers.get(TOOL.doctor)?.({});
    const cli = await runJson(root, "doctor");
    expect(mcp?.structuredContent).toMatchObject({
      ok: false,
      error: { details: { runtime: runtimeIdentity() } },
    });
    expect(cli.envelope).toMatchObject({
      ok: false,
      error: { details: { runtime: runtimeIdentity() } },
    });
  },
);

describe("tool error mapping", () => {
  it("turns a missing workspace into isError with a recovery command", async () => {
    const handlers = collectTools(await tempProject(false));

    for (const [name, handler] of handlers) {
      const result = await handler(VALID_ARGS[name] ?? {});
      const structured = result.structuredContent as
        | { tool: string; ok: boolean; error?: { code: string; recovery?: string } }
        | undefined;

      expect(result.isError, `${name} should refuse an uninitialized project`).toBe(true);
      expect(structured?.tool).toBe(name);
      expect(structured?.ok).toBe(false);
      expect(structured?.error?.code).toBe("NOT_INITIALIZED");
      expect(structured?.error?.recovery).toBe("visp init --harness <name>");
    }
  });
});

describe("tool structured content", () => {
  it("returns structuredContent from every tool on an initialized project", async () => {
    for (const [name, args] of Object.entries(VALID_ARGS)) {
      // A fresh project per tool, so one tool's writes cannot alter the next.
      const handlers = collectTools(await tempProject(true));
      const handler = handlers.get(name);
      expect(handler, `${name} is registered`).toBeDefined();
      if (!handler) continue;

      const result = await handler(args);
      const structured = result.structuredContent as { tool: string; ok: boolean } | undefined;

      expect(structured, `${name} returns structuredContent`).toBeDefined();
      expect(structured?.tool).toBe(name);
      expect(typeof structured?.ok).toBe("boolean");
      expect(result.content?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe("historical scope authorization", () => {
  it("refuses both closed and unknown legacy task markers without rewriting them", async () => {
    const workspace = await TestWorkspace.create({ "src/app.ts": "export const app = true;\n" });
    try {
      await workspace.withFeature("001-closed", [task({ status: "done" })]);
      const state = await workspace.state();
      for (const taskId of ["T001", "T999"]) {
        const written = await legacyStore(state).writeImplementMarker({
          kind: "implement-marker",
          createdAt: now(),
          feature: "001-closed",
          task: taskId,
          allowedFiles: ["src/**/*.ts"],
          expectedFiles: ["src/app.ts"],
          forbiddenFiles: [],
        });
        if (!written.ok) throw new Error(written.error.message);
      }
      const handlers = collectTools(workspace.root);
      const before = await Promise.all(
        ["T001", "T999"].map((id) => state.files.readText(state.paths.implementMarker(id))),
      );
      const guarded = await handlers.get(TOOL.guard)?.({ paths: ["src/app.ts"] });
      expect(guarded?.isError).toBe(true);
      expect(guarded?.structuredContent).toMatchObject({ error: { code: "MIGRATION_REQUIRED" } });
      const status = await handlers.get(TOOL.status)?.({});
      expect(status?.structuredContent).toMatchObject({
        data: {
          feature: "001-closed",
          next: {
            action: "understand",
            mayEdit: false,
            command: "visp migrate --feature 001-closed --dry-run",
          },
        },
      });
      const scope = await scopePayload(workspace.root);
      expect(scope).toMatchObject({ ok: false, error: { code: "MIGRATION_REQUIRED" } });
      expect(
        await Promise.all(
          ["T001", "T999"].map((id) => state.files.readText(state.paths.implementMarker(id))),
        ),
      ).toEqual(before);
      expect(
        await state.files.exists(state.paths.featureFile("001-closed", "brief.yaml")),
      ).toMatchObject({ ok: true, value: false });
    } finally {
      await workspace.destroy();
    }
  });
});
