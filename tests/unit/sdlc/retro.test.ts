import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type SdlcRepo, sdlcRepo } from "./support/sdlc-repo.js";

type Inputs = Record<string, unknown>;
const { renderRetro } = (await import(
  pathToFileURL(join(process.cwd(), "scripts/sdlc/lib/retro.mjs")).href
)) as { renderRetro(inputs: Inputs): string };

const review = (task: string, at: string, findings: { id: string; text: string }[]) => ({
  schema: "review@1",
  task,
  agent: "reviewer",
  created_at: at,
  status: "done",
  body: {
    verdict: "changes_requested",
    findings: findings.map((f) => ({ ...f, severity: "advisory" })),
  },
});

// Shapes taken from pilot 2 (epic VISP-5): rows written before mistakes carried their epic are
// tied to it through the agent's state file, a task key in the reason, or the session.
const inputs: Inputs = {
  feature: "VISP-5",
  rows: [
    {
      hook: "scope",
      agent_type: "coder",
      agent_id: "c7",
      reason: "SDLC scope: docs/adr is outside this task's scope",
      signature: "scope:SDLC scope: PATH is outside",
    },
    {
      hook: "scope",
      agent_type: "coder",
      agent_id: "c7",
      reason: "SDLC scope: docs/adr is outside this task's scope",
      signature: "scope:SDLC scope: PATH is outside",
    },
    {
      hook: "scope",
      agent_type: "coder",
      agent_id: "c6",
      reason: "SDLC scope: $P is outside this task's scope",
      signature: "scope:SDLC scope: $P is outside",
    },
    {
      hook: "safety",
      agent_type: "qe-verify",
      agent_id: "q6",
      reason: "this command removes a worktree",
      signature: "safety:this command removes a worktree",
    },
    {
      hook: "ci",
      agent_type: "ci",
      agent_id: null,
      reason: "VISP-6 CI check sdlc-trace failed on PR #111",
      signature: "ci:KEY CI check sdlc-trace",
    },
    {
      hook: "config-guard",
      agent_type: "manager",
      agent_id: null,
      session_id: "m1",
      reason: "x changed",
      signature: "config-guard:x",
    },
    {
      hook: "scope",
      agent_type: "coder",
      agent_id: "c6",
      session_id: "m1",
      reason: "SDLC scope: package.json is protected",
      signature: "scope:SDLC scope: package.json is protected",
    },
    {
      hook: "safety",
      agent_type: "coder",
      agent_id: "a1",
      reason: "this command force-pushes",
      signature: "safety:this command force-pushes",
    },
    {
      hook: "safety",
      agent_type: null,
      agent_id: null,
      reason: "this command pushes to develop",
      signature: "safety:this command pushes to develop",
    },
  ],
  states: {
    c6: { feature: "VISP-5", task: "VISP-6" },
    c7: { feature: "VISP-5", task: "VISP-7" },
    q6: { feature: "VISP-5", task: "VISP-6" },
  },
  taskFeature: { "VISP-6": "VISP-5", "VISP-7": "VISP-5" },
  tasks: [
    { task: "VISP-6", status: "Done", coderTurns: 3 },
    { task: "VISP-7", status: "Done", coderTurns: 5 },
  ],
  artifacts: [
    review("VISP-6", "2026-11-08T09:12:18Z", [
      {
        id: "R-2",
        text: "No stop-hook run covers head 4dd73e0b. Tests were read without execution.",
      },
    ]),
    review("VISP-6", "2026-11-08T09:19:01Z", [
      { id: "R-2", text: "Earlier R-2 remains unresolved: no stop-hook run covers head 8cb1ad87." },
    ]),
    review("VISP-6", "2026-11-08T09:23:59Z", [
      { id: "R-1", text: "Both earlier R-1 findings are fixed." },
      {
        id: "R-2",
        text: "Both earlier R-2 advisories remain unresolved: no stop-hook run covers head.",
      },
    ]),
    review("VISP-7", "2026-11-08T09:15:27Z", [
      { id: "R-3", text: "No stop-hook run covers ef656be8." },
    ]),
    review("VISP-7", "2026-11-08T09:20:48Z", [
      { id: "R-3", text: "Still unconfirmed: no stop-hook run covers 6f310804." },
    ]),
    review("VISP-7", "2026-11-08T15:34:07Z", [
      { id: "R-3", text: "Resolved. The supplied stop-hook results confirm it." },
    ]),
  ],
  worklog: [
    { agent: "coder", status: "done", created_at: "2026-11-08T09:01:47Z" },
    { agent: "reviewer", status: "done", created_at: "2026-11-08T15:36:26Z" },
    { agent: "reviewer", status: "failed", created_at: "2026-11-08T09:20:41Z" },
  ],
  budget: { agentRuns: 19, coderRuns: 8 },
  notes: undefined,
};

describe("sdlc retro report", () => {
  const report = renderRetro(inputs);

  it("counts only the epic's own mistakes, tied by agent state, task key or session", () => {
    expect(report).toContain(
      "| 2 | scope | coder | VISP-7 | SDLC scope: docs/adr is outside this task's scope |",
    );
    expect(report).toContain(
      "| 1 | scope | coder | VISP-6 | SDLC scope: $P is outside this task's scope |",
    );
    expect(report).toContain("config-guard");
    expect(report).not.toContain("force-pushes");
    expect(report).toContain("2 rows belong to no epic");
  });

  it("lists findings a review carried unresolved over two or more rounds", () => {
    expect(report).toContain(
      "- VISP-6 R-2: unresolved in 3 rounds, still open: No stop-hook run covers head 4dd73e0b.",
    );
    expect(report).toContain(
      "- VISP-7 R-3: unresolved in 2 rounds, resolved in round 3: No stop-hook run covers ef656be8.",
    );
    expect(report).not.toContain("VISP-6 R-1");
  });

  it("lists what was left to the owner and the CI failures", () => {
    expect(report).toMatch(
      /## Left to the owner\n\n- VISP-6 qe-verify: this command removes a worktree/,
    );
    expect(report).toContain("- VISP-6 CI check sdlc-trace failed on PR #111");
  });

  it("summarises the run and says when the packet has no retro notes", () => {
    expect(report).toContain("19 agent runs (8 coder), 1 failed");
    expect(report).toContain("2026-11-08T09:01:47Z to 2026-11-08T15:36:26Z");
    expect(report).toContain("- VISP-6: Done, 3 coder turns, 3 review rounds");
    expect(report).toContain("No retro notes in the latest owner packet.");
  });
});

describe("sdlc retro command", () => {
  let fixture: SdlcRepo;
  afterEach(() => fixture.cleanup());

  it("reads the epic's records from .sdlc and prints the report", () => {
    fixture = sdlcRepo();
    const row = {
      hook: "scope",
      agent_type: "coder",
      agent_id: "c1",
      reason: "SDLC scope: docs/adr is outside",
      signature: "scope:x",
    };
    fixture.write(".sdlc/mistakes.jsonl", `${JSON.stringify(row)}\nnot json\n`);
    fixture.write(".sdlc/run/agents/c1.json", JSON.stringify({ feature: "F-12", task: "T-13" }));
    fixture.write(".sdlc/run/loops/F-12/T-13.json", JSON.stringify({ coderTurns: 2 }));
    fixture.write(".sdlc/features/F-12/tasks/T-13/ticket.yml", 'key: T-13\nstatus: "10013"\n');
    fixture.write(
      ".sdlc/features/F-12/owner-packet-20261108T150000Z.md",
      "# P\n\n## Retro notes\n\n- The scope hook refused docs/adr.\n",
    );
    const result = spawnSync(
      process.execPath,
      [join(process.cwd(), "scripts/sdlc/sdlc.mjs"), "retro", "F-12"],
      {
        cwd: fixture.repo,
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("# Retro: F-12");
    expect(result.stdout).toContain(
      "| 1 | scope | coder | T-13 | SDLC scope: docs/adr is outside |",
    );
    expect(result.stdout).toContain("- T-13: Done, 2 coder turns, 0 review rounds");
    expect(result.stdout).toContain("- The scope hook refused docs/adr.");
  });
});
