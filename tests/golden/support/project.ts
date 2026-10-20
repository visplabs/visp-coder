import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, expect, vi } from "vitest";
import { parse, stringify } from "yaml";
import { registerTools } from "../../../src/mcp/tools/index.js";
import { outstandingFeedback } from "../../../src/workflow/product/findings.js";
import { runProductNext } from "../../../src/workflow/product/status.js";
import { type ProductRecord, readProductRecord } from "../../../src/workflow/product/store.js";
import { readTestsRecord } from "../../../src/workflow/product/tester/independent-tests-record.js";
import { type CliResult, runCli } from "../../unit/cli/support/cli.js";
import { TestWorkspace } from "../../unit/support/workspace.js";
import { type FakeModels, modelCallTranscript, testerSuite } from "./fake-models.js";
import { type NormalizeContext, normalize } from "./normalize.js";

/**
 * A private HOME for this test file: VISP reads user critic defaults and the Codex sign-in
 * from it, and the developer's own settings must not change what a scenario prints.
 *
 * Fixture commits carry a fixed date long before any feature, so VISP's list of commits made
 * after an earlier feature does not depend on whether setup and the feature fell in one second.
 */
const FIXTURE_COMMIT_DATE = "2026-01-01T00:00:00Z";
const LATER_DATE = "2099-01-01T00:00:00Z";
const home = mkdtempSync(join(tmpdir(), "visp-golden-home-"));
const isolated = {
  HOME: home,
  CODEX_HOME: join(home, ".codex"),
  // Git reads $XDG_CONFIG_HOME/git/config and the system config too; a developer's
  // core.hooksPath there would bypass the hook VISP installs.
  XDG_CONFIG_HOME: join(home, ".config"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_DATE: FIXTURE_COMMIT_DATE,
  GIT_COMMITTER_DATE: FIXTURE_COMMIT_DATE,
};
const outer = Object.fromEntries(Object.keys(isolated).map((name) => [name, process.env[name]]));
Object.assign(process.env, isolated);
// A scenario is many real commands in sequence: 10-25 s when the machine is busy.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
afterAll(async () => {
  for (const [name, value] of Object.entries(outer)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(home, { recursive: true, force: true });
});

/** The request every scenario starts from: one module whose public value must become two. */
export const REQUEST = "Make the public value module return two instead of one.";
export const GOAL = "Return two from the public value module";

const FILES = {
  "src/value.mjs": "export const value = 1;\n",
  // A trivial, deterministic check: it prints what it saw and passes only for the promised
  // export (`value`, two, by default; `label`, "two", when named).
  "checks/value.check.mjs": [
    'import * as product from "../src/value.mjs";',
    'const name = process.argv[2] ?? "value";',
    'const expected = name === "label" ? "two" : 2;',
    'if (product[name] === expected) console.log(name + " is " + expected);',
    "else {",
    '  console.log("expected " + expected + ", got " + product[name]);',
    "  process.exitCode = 1;",
    "}",
    "",
  ].join("\n"),
};

export const BRIEF = {
  incomplete: false,
  outcomes: [
    {
      id: "O001",
      kind: "functional",
      statement: "The public value is two",
      priority: "must",
      provenance: "user-stated",
    },
  ],
  checks: [
    {
      id: "C001",
      command: ["node", "checks/value.check.mjs"],
      outcomes: ["O001"],
      files: ["src/value.mjs", "checks/value.check.mjs"],
      environment: "node",
    },
  ],
  slices: [
    {
      id: "T001",
      goal: "Return the promised value",
      outcomes: ["O001"],
      scope: {
        allowed: ["src/value.mjs", "checks/value.check.mjs"],
        expected: ["src/value.mjs"],
        forbidden: [],
      },
      checks: ["C001"],
    },
  ],
};

/** visp.yml as `visp init` writes it for Codex: VISP launches its own reviewer and tester. */
export const CODEX: ProjectOptions = {
  harness: "codex",
  critic: {
    enabled: true,
    harness: "codex",
    launch: "codex-exec",
    reasoningEffort: "medium",
    webSearch: true,
  },
};

/** Claude Code with VISP launching a `claude -p` reviewer and tester. */
export const CLAUDE: ProjectOptions = {
  harness: "claude-code",
  critic: { enabled: true, harness: "claude-code", launch: "claude-exec" },
};

/** A pinned suite with one test the request contradicts: two is not odd. */
export const DISPUTED_SUITE = testerSuite([
  ["value is two", "value === 2"],
  ["value is odd", "value % 2 === 1"],
]);
export const DISPUTE = [
  "--dispute",
  "value is odd",
  "--reason",
  "The request says return two; two is even",
];

export interface ProjectOptions {
  /** Merged into `critic` in visp.yml; omitted keeps the critic off. */
  readonly critic?: Record<string, unknown>;
  /** Merged into `workflow` in visp.yml, for example lean mode's switches. */
  readonly workflow?: Record<string, unknown>;
  /** The project's host, written to visp.yml before the foundation is installed. */
  readonly harness?: string;
  /** Extra files committed with the fixture. */
  readonly files?: Record<string, string>;
  /** False leaves VISP initialized but not installed into any host. */
  readonly install?: boolean;
}

/** One scenario's project: a real repository with VISP installed, driven through its adapters. */
export class GoldenProject {
  private constructor(readonly workspace: TestWorkspace) {}

  /** Built once per test file and copied for each scenario, as the unit fixtures do. */
  static async create(options: ProjectOptions = {}): Promise<GoldenProject> {
    const { workspace } = await TestWorkspace.cached(
      `golden:${JSON.stringify(options)}`,
      async () => {
        const built = await TestWorkspace.create(
          { ...FILES, ...options.files },
          { critic: !!options.critic },
        );
        const config = parse(await readFile(join(built.root, "visp.yml"), "utf8"));
        if (options.harness) config.harness = options.harness;
        if (options.critic) config.critic = { ...config.critic, ...options.critic };
        if (options.workflow) config.workflow = { ...config.workflow, ...options.workflow };
        await built.write("visp.yml", stringify(config));
        if (options.install !== false) {
          await built.installFoundation();
          built.commit("install foundation");
        }
        return { workspace: built, value: undefined };
      },
    );
    return new GoldenProject(workspace);
  }

  get root(): string {
    return this.workspace.root;
  }

  destroy(): Promise<void> {
    return this.workspace.destroy();
  }

  async cli(...args: string[]): Promise<CliResult> {
    return runCli(this.root, ...args);
  }

  /** The exact text an MCP host receives for one tool call, and the structured envelope. */
  async mcp(tool: string, args: Record<string, unknown> = {}, options: { aborted?: boolean } = {}) {
    const handler = (await this.tools()).get(tool);
    if (!handler) throw new Error(`No MCP tool ${tool}`);
    const controller = new AbortController();
    // A cancelled request stops waiting at once: it reaches the reply a deadline would.
    if (options.aborted) controller.abort();
    const result = await handler(args, { signal: controller.signal });
    return { text: mcpText(result), result };
  }

  private handlers?: Map<string, ToolHandler>;
  private async tools(): Promise<Map<string, ToolHandler>> {
    if (this.handlers) return this.handlers;
    const handlers = new Map<string, ToolHandler>();
    const server = {
      server: {},
      registerTool(name: string, _config: unknown, callback: ToolHandler) {
        handlers.set(name, callback);
        return {};
      },
    } as unknown as McpServer;
    registerTools(server, this.root, "standard");
    this.handlers = handlers;
    return handlers;
  }

  /** Starts the fixture feature and writes its brief, as a worker would through the CLI. */
  async startFeature(brief: Record<string, unknown> = BRIEF): Promise<string> {
    const started = await this.cli("feature", GOAL, "--source-brief", REQUEST);
    expect(started.exitCode, started.stderr).toBe(0);
    const feature = await this.activeFeature();
    await this.writeBrief(brief);
    return feature;
  }

  async writeBrief(brief: Record<string, unknown> = BRIEF): Promise<CliResult> {
    await this.workspace.write(".visp/drafts/brief.json", JSON.stringify(brief));
    const updated = await this.cli(
      "brief",
      "--patch",
      ".visp/drafts/brief.json",
      "--reason",
      "Define the first usable behavior",
    );
    expect(updated.exitCode, updated.stdout + updated.stderr).toBe(0);
    return updated;
  }

  /** A commit dated after every feature, as a change made outside VISP after earlier work. */
  laterCommit(message: string): void {
    const env = { ...process.env, GIT_AUTHOR_DATE: LATER_DATE, GIT_COMMITTER_DATE: LATER_DATE };
    execFileSync("git", ["add", "-A"], { cwd: this.root, env });
    execFileSync("git", ["commit", "-q", "--no-verify", "-m", message], { cwd: this.root, env });
  }

  async activeFeature(): Promise<string> {
    const state = await this.workspace.state();
    const feature = state.status?.activeFeature;
    if (!feature) throw new Error("No active feature");
    return feature;
  }

  /** The product's value module: two satisfies the request, anything else fails the check. */
  setValue(value: number): Promise<void> {
    return this.workspace.write("src/value.mjs", `export const value = ${value};\n`);
  }

  /**
   * What VISP decided, independent of how it was worded: the next action and the gates the
   * product state holds. A changed decision is agent-facing even when the text is unchanged.
   */
  async decision(extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const state = await this.workspace.state();
    const next = await runProductNext(state, {});
    const record = await readProductRecord(state, {});
    const tests = record.ok ? await readTestsRecord(state, record.value.brief.feature) : undefined;
    return {
      ...extra,
      next: next.ok
        ? {
            action: next.value.action,
            command: next.value.command,
            mayEdit: next.value.mayEdit,
            completion: next.value.completion,
            task: next.value.task,
            evidence: next.value.evidence.length,
            critic: next.value.criticAdvice?.status,
          }
        : { error: next.error.code },
      product: record.ok ? productGates(record.value) : { unavailable: record.error.code },
      ...(tests?.ok && tests.value
        ? {
            independentTests: {
              status: tests.value.status,
              disputes: (tests.value.disputes ?? []).map(
                (entry) => `${entry.test}: ${entry.status}`,
              ),
            },
          }
        : {}),
    };
  }

  /** The normalization this project needs: its own path, and the shared machine values. */
  context(): NormalizeContext {
    return { paths: [[this.root, "<PROJECT>"]] };
  }
}

function productGates(record: ProductRecord) {
  const { state } = record;
  const findings = outstandingFeedback(record);
  return {
    status: state.status,
    slices: Object.fromEntries(
      Object.entries(state.slices).map(([id, slice]) => [id, slice.status]),
    ),
    executions: state.executions.map(
      (execution) =>
        `${execution.check}${execution.task ? `/${execution.task}` : ""}: ${execution.status}`,
    ),
    reviews: state.reviews.length,
    openFindings: {
      required: findings.filter((finding) => finding.required).length,
      advisory: findings.filter((finding) => !finding.required).length,
    },
  };
}

/** Commands that read state without changing it. */
function readOnly(args: readonly string[]): boolean {
  const [command, ...flags] = args;
  if (command === "next" || command === "status" || command === "pr" || command === "rules")
    return true;
  if (command === "brief") return !flags.includes("--patch") && !flags.includes("--from");
  return command === "work" && flags.includes("--inspect");
}
function readOnlyTool(tool: string, args: Record<string, unknown>): boolean {
  if (tool === "visp_brief") return args.patch === undefined && args.brief === undefined;
  return tool === "visp_next" || tool === "visp_status" || (tool === "visp_work" && !!args.inspect);
}

type ToolHandler = (args: Record<string, unknown>, extra: object) => Promise<CallToolResult>;

function mcpText(result: CallToolResult): string {
  return result.content
    .map((entry) => (entry.type === "text" ? entry.text : `[${entry.type} content]`))
    .join("\n--- next content block\n");
}

/**
 * One CLI call as an agent reads it. Each stream is followed by exactly one added newline
 * before the next marker, so a missing or extra trailing newline still shows.
 */
export function cliTranscript(args: readonly string[], result: CliResult): string {
  return [
    `$ visp ${args.map(shellWord).join(" ")}`,
    "--- stdout",
    result.stdout,
    "--- stderr",
    result.stderr,
    `--- exit ${result.exitCode}`,
  ].join("\n");
}

/** One MCP tool call as the host's model reads it: the text content, then whether it failed. */
export function mcpTranscript(
  tool: string,
  args: Record<string, unknown>,
  reply: { text: string; result: CallToolResult },
): string {
  return [
    `> ${tool} ${JSON.stringify(args)}`,
    "--- text",
    reply.text,
    `--- isError ${reply.result.isError === true}`,
  ].join("\n");
}

function shellWord(word: string): string {
  return /^[\w./:=@,+-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

const SNAPSHOTS = new URL("../__snapshots__/", import.meta.url);

/** Compares normalized text with its file snapshot; one file per surface and scenario. */
export async function golden(
  name: string,
  text: string,
  context: NormalizeContext = {},
): Promise<void> {
  // Soft, so one run reports every changed surface of a scenario, not only the first.
  await expect
    .soft(`${normalize(text, context)}\n`)
    .toMatchFileSnapshot(new URL(name, SNAPSHOTS).pathname);
}

/**
 * Records a scenario's steps under one folder: each CLI or MCP call's text, and after it the
 * decision VISP holds (`<step>.decision.json`).
 */
export class Recorder {
  constructor(
    readonly project: GoldenProject,
    readonly folder: string,
  ) {}

  async cli(name: string, args: readonly string[]): Promise<CliResult> {
    const result = await this.project.cli(...args);
    await this.save(`${name}.txt`, cliTranscript(args, result));
    // A read-only step cannot change the decision the step before it recorded.
    if (!readOnly(args)) await this.decision(name, { exitCode: result.exitCode });
    return result;
  }

  async mcp(
    name: string,
    tool: string,
    args: Record<string, unknown> = {},
    options: { aborted?: boolean } = {},
  ) {
    const reply = await this.project.mcp(tool, args, options);
    await this.save(`${name}.mcp.txt`, mcpTranscript(tool, args, reply));
    // Hosts that forward only structured content give the model this, not the text.
    await this.save(
      `${name}.mcp.data.json`,
      JSON.stringify(reply.result.structuredContent ?? null, null, 2),
    );
    if (!readOnlyTool(tool, args))
      await this.decision(`${name}.mcp`, { isError: reply.result.isError === true });
    return reply;
  }

  async decision(name: string, extra: Record<string, unknown> = {}): Promise<void> {
    await this.save(
      `${name}.decision.json`,
      JSON.stringify(await this.project.decision(extra), null, 2),
    );
  }

  /** Every model call VISP made since the last plan, one file per call, named by role. */
  async models(name: string, models: FakeModels): Promise<void> {
    const calls = await models.calls();
    for (const call of calls) {
      const same = calls.filter((entry) => entry.role === call.role);
      const suffix = same.length > 1 ? `-${same.indexOf(call) + 1}` : "";
      await this.save(`${name}.${call.role}${suffix}.prompt.txt`, modelCallTranscript(call));
    }
    await models.clear();
  }

  save(file: string, text: string): Promise<void> {
    return golden(`${this.folder}/${file}`, text, this.project.context());
  }
}
