import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import {
  type CriticPacket,
  type ProductCriticHost,
  runProductCritic,
} from "../../../../src/workflow/product/critic/critic.js";
import type { CriticState } from "../../../../src/workflow/product/critic/critic-model.js";
import {
  criticSelection,
  readCriticState,
} from "../../../../src/workflow/product/critic/critic-store.js";
import { runProductNext, runProductVerify } from "../../../../src/workflow/product/index.js";
import type { ProductReviewBundle } from "../../../../src/workflow/product/review/review.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { legacyReview } from "../../support/legacy-critic.js";
import { moduleFeedback } from "../../support/product-feedback.js";
import { productWorkspace } from "../../support/product-workspace.js";

const config = {
  model: "test-critic",
  maxCalls: 5,
  timeoutMs: 5000,
  maxImageBytes: 4 * 1024 * 1024,
};
const capabilities = {
  harness: "codex",
  model: config.model,
  reasoningEffort: "high",
  freshContext: true,
  images: true,
  readOnly: true,
  delegationAllowed: true,
};

function answer(packet: CriticPacket, required = false) {
  const feedback = moduleFeedback(packet.current as unknown as ProductReviewBundle);
  if (required)
    feedback.findings = [
      {
        dimension: "functional",
        problem: "The alternative invocation has not been verified",
        nextCheck: "Exercise the alternate invocation before changing its handler",
        outcomes: ["O001"],
        required: true,
        evidence: packet.current.evidence
          .filter((entry) => entry.kind === "execution")
          .slice(0, 1)
          .map((entry) => entry.id),
      },
    ];
  return {
    review: {
      ...legacyReview(packet),
      assessments: packet.current.outcomes.map((o) => ({
        outcome: o.id,
        status: "satisfied",
        summary: "Executed the module and observed the promised value",
        evidence: packet.current.evidence
          .filter((entry) => entry.kind === "execution")
          .slice(0, 1)
          .map((entry) => entry.id),
        expectations: [],
      })),
      feedback,
    },
    comparison: [],
  };
}

describe("critic advice when VISP launches the reviewer", () => {
  const workspaces: Awaited<ReturnType<typeof productWorkspace>>[] = [];
  let setup: Awaited<ReturnType<typeof productWorkspace>>;
  const crashing: ProductCriticHost = {
    review: async () => {
      throw new Error("codex exec crashed");
    },
  };

  async function scenario(launch: boolean, limits: object = config) {
    const made = await productWorkspace({ critic: true });
    workspaces.push(made);
    const raw = parse(await readFile(join(made.workspace.root, "visp.yml"), "utf8"));
    raw.critic = {
      ...raw.critic,
      harness: "codex",
      mode: "auto",
      launch: launch ? "codex-exec" : undefined,
    };
    await made.workspace.write("visp.yml", stringify(raw));
    made.workspace.commit("reviewer launch mode");
    expect((await runProductWork(await made.workspace.state(), { task: "T001" })).ok).toBe(true);
    await made.workspace.write("src/value.mjs", "export const value = 2;\n");
    expect((await runProductVerify(await made.workspace.state(), { task: "T001" })).ok).toBe(true);
    const configured = await runProductCritic(await made.workspace.state(), {
      task: "T001",
      operation: "configure",
      config: limits,
    });
    expect(configured.ok).toBe(true);
    return made;
  }
  const critic = async (input: object, host?: ProductCriticHost) =>
    runProductCritic(await setup.workspace.state(), { task: "T001", ...input }, host);
  const next = async (made = setup) => {
    const result = await runProductNext(await made.workspace.state(), { task: "T001" });
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };
  async function rewrite(change: (state: CriticState) => void) {
    const workspace = await setup.workspace.state();
    const selected = await criticSelection(workspace, { task: "T001" });
    if (!selected.ok) throw new Error("selection");
    const stored = await readCriticState(workspace, selected.value);
    if (!stored.ok || !stored.value.state) throw new Error("state");
    change(stored.value.state);
    await writeFile(selected.value.path, JSON.stringify(stored.value.state));
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const made of workspaces.splice(0)) await made.workspace.destroy();
  });

  it("gives no review command once the product is observed, and leaves routing and budgets alone", async () => {
    const baseline = await scenario(false);
    const launched = await scenario(true);
    const before = await next(baseline);
    const after = await next(launched);
    expect(before.criticAdvice).toMatchObject({ status: "suggested" });
    expect(after.criticAdvice).toBeUndefined();
    const route = (value: typeof after) => ({
      action: value.action,
      completion: value.completion,
      mayEdit: value.mayEdit,
      objective: value.objective,
      command: value.command,
      feature: value.feature,
      task: value.task,
    });
    expect(route(after)).toEqual(route(before));
    const budget = async (made: typeof baseline) => {
      const status = await runProductCritic(await made.workspace.state(), {
        task: "T001",
        operation: "status",
      });
      if (!status.ok) throw new Error(status.error.message);
      const { callsUsed, callsRemaining, featureBudget } = status.value as Record<string, unknown>;
      return { callsUsed, callsRemaining, featureBudget };
    };
    expect(await budget(launched)).toEqual(await budget(baseline));
    expect(await budget(launched)).toMatchObject({ callsUsed: 0, callsRemaining: 5 });
  });

  it("returns findings without a review command and tells the worker to delegate nothing", async () => {
    setup = await scenario(true);
    const reviewed = await critic(
      { operation: "review" },
      {
        review: async (packet) => ({ model: config.model, response: answer(packet, true) }),
      },
    );
    expect(reviewed).toMatchObject({ ok: true, value: { action: "worker", callsUsed: 1 } });
    const value = await next();
    expect(value.criticAdvice).toMatchObject({
      status: "feedback",
      guidance: expect.stringContaining("delegate nothing"),
      findings: [expect.objectContaining({ required: true })],
    });
    expect(value.criticAdvice?.command).toBeUndefined();
    expect(value.criticAdvice?.guidance).toContain("run no review command");
  });

  it("ends stopped advice with the visp next route instead of a host review", async () => {
    setup = await scenario(true);
    await critic({ operation: "review" }, crashing);
    // One failure is retried by VISP itself, so nothing is stopped yet.
    expect((await next()).criticAdvice).toBeUndefined();
    await critic({ operation: "review" }, crashing);
    const before = await next();
    const advice = before.criticAdvice;
    expect(advice).toMatchObject({ status: "unavailable" });
    expect(advice?.command).toBeUndefined();
    expect(advice?.guidance).toContain(
      "VISP's reviewer has not reviewed this version: Previous critic attempt unavailable: ",
    );
    expect(advice?.guidance).not.toContain("No new invocation");
    expect(advice?.guidance).not.toContain("baseline");
    expect(advice?.guidance).toMatch(
      /Follow `visp next`: it says when to run visp done again and when the rest goes to a human reviewer\.$/,
    );
    const status = await critic({ operation: "status" });
    expect(status).toMatchObject({
      ok: true,
      value: { callsUsed: 0, featureBudget: { reservedMs: 2 * config.timeoutMs } },
    });
  });

  it("tells the worker to wait while VISP's reviewer is still running", async () => {
    setup = await scenario(true);
    await critic({ operation: "review" }, crashing);
    await rewrite((state) => {
      const [attempt] = state.attempts;
      if (!attempt) throw new Error("attempt");
      attempt.status = "pending";
      attempt.startedAt = Date.now();
    });
    const advice = (await next()).criticAdvice;
    expect(advice).toMatchObject({
      status: "unavailable",
      guidance: "VISP's reviewer is still running. Wait: run visp next.",
    });
    expect(advice?.command).toBeUndefined();
  });

  it("keeps the source-only and host advice for a project without a launched reviewer", async () => {
    setup = await scenario(false);
    await critic({ operation: "review" }, crashing);
    const advice = (await next()).criticAdvice;
    expect(advice?.guidance).toContain("Continue the baseline build–observe–fix loop");
    expect(advice?.guidance).toContain("Previous critic attempt unavailable");
  });

  it("preflights a launched reviewer without a host report, and still checks one when given", async () => {
    setup = await scenario(true);
    const plain = await critic({ operation: "preflight" });
    expect(plain).toMatchObject({
      ok: true,
      value: {
        status: "ready",
        ready: true,
        launcher: "visp",
        gaps: [],
        next: expect.stringContaining("run visp done"),
      },
    });
    if (!plain.ok) throw new Error("preflight");
    expect(plain.value).not.toHaveProperty("hostSetup");
    expect(plain.value).not.toHaveProperty("prepareCommand");
    const refused = await critic({
      operation: "preflight",
      capabilities: { ...capabilities, readOnly: false },
    });
    expect(refused).toMatchObject({
      ok: true,
      value: { status: "unavailable", ready: false, launcher: "visp" },
    });
    if (!refused.ok) throw new Error("preflight");
    expect((refused.value as { gaps: string[] }).gaps.length).toBeGreaterThan(0);
    expect(refused.value).not.toHaveProperty("hostSetup");
  });

  it("keeps the host preflight for a project without a launched reviewer", async () => {
    setup = await scenario(false);
    expect(await critic({ operation: "preflight" })).toMatchObject({
      ok: true,
      value: {
        status: "setup-needed",
        ready: false,
        hostSetup: expect.any(Object),
        prepareCommand: expect.stringContaining("--prepare"),
      },
    });
  });

  it("answers a launched preflight only for what visp done actually runs", async () => {
    setup = await scenario(true);
    const answered = async (input: object) => {
      const result = await critic({ operation: "preflight", ...input });
      if (!result.ok) throw new Error(result.error.message);
      return result.value as { next: string; gaps: string[]; capabilityProvenance: string };
    };
    const plain = await answered({});
    expect(plain.next).toContain("run visp done. Nothing to prepare");
    expect(plain.capabilityProvenance).toBe(
      "not checked here; visp done verifies the reviewer when it runs",
    );
    for (const request of [{ sourceOnly: true }, { phase: "understanding" }]) {
      const other = await answered(request);
      expect(other.next).not.toContain("Nothing to prepare");
      expect(other.next).toMatch(/visp done|Resolve the gap/);
    }
    expect((await answered({ sourceOnly: true })).next).toContain("source-only review");
    const reported = await answered({ capabilities: { ...capabilities, readOnly: false } });
    expect(reported.capabilityProvenance).toBe("host-reported; not independently verified");
    expect(reported.gaps.length).toBeGreaterThan(0);
    expect(reported.next).toContain("Resolve the gap: ");
    expect(reported.next).toContain(reported.gaps[0]);
  });

  it("preflight matches what done would do: relaunch after one failure, stop after two", async () => {
    setup = await scenario(true);
    await critic({ operation: "review" }, crashing);
    const once = await critic({ operation: "preflight" });
    expect(once).toMatchObject({ ok: true, value: { status: "ready", gaps: [] } });
    await critic({ operation: "review" }, crashing);
    const twice = await critic({ operation: "preflight" });
    if (!twice.ok) throw new Error(twice.error.message);
    const value = twice.value as { status: string; next: string; gaps: string[] };
    expect(value.status).toBe("unavailable");
    expect(value.gaps.join(" ")).toContain("VISP's reviewer will try again on the next visp done");
    expect(value.next).toContain("Resolve the gap");
    expect(value.next).not.toContain("baseline host review");
  });

  it("points a preflight at visp next while the reviewer is still running", async () => {
    setup = await scenario(true);
    await critic({ operation: "review" }, crashing);
    await rewrite((state) => {
      const [attempt] = state.attempts;
      if (!attempt) throw new Error("attempt");
      attempt.status = "pending";
      attempt.startedAt = Date.now();
    });
    expect(await critic({ operation: "preflight" })).toMatchObject({
      ok: true,
      value: { ready: false, next: "VISP's reviewer is still running. Wait: run visp next." },
    });
  });

  it("keeps the host recovery command out of launched status", async () => {
    const recovery = async (launch: boolean) => {
      setup = await scenario(launch);
      await critic({ operation: "review" }, crashing);
      const status = await critic({ operation: "status" });
      if (!status.ok) throw new Error(status.error.message);
      return (status.value as { recovery?: { command?: string } }).recovery;
    };
    expect((await recovery(false))?.command).toContain("--capabilities");
    const launched = await recovery(true);
    expect(launched).toBeDefined();
    expect(launched?.command).toBeUndefined();
  });

  it("does not say the version was unreviewed when findings exist and the reviewer is out of calls", async () => {
    setup = await scenario(true, { ...config, maxCalls: 1 });
    await critic(
      { operation: "review" },
      {
        review: async (packet) => ({ model: config.model, response: answer(packet, true) }),
      },
    );
    const advice = (await next()).criticAdvice;
    expect(advice).toMatchObject({
      status: "unavailable",
      findings: [expect.objectContaining({ required: true })],
    });
    expect(advice?.guidance).toContain("Use the recorded findings");
    expect(advice?.guidance).toContain("cannot review a new version now");
    expect(advice?.guidance).toContain("budget exhausted");
    expect(advice?.guidance).not.toContain("has not reviewed this version");
    expect(advice?.guidance).toMatch(/Follow `visp next`.*human reviewer\.$/);
    expect(advice?.command).toBeUndefined();
  });
});
