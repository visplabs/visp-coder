import { describe, expect, it } from "vitest";
import { configSchema } from "../../../../src/config/schema.js";
import type { ProductBrief, ProductState } from "../../../../src/workflow/product/model.js";
import {
  featureProfile,
  largeChange,
  leanCriticConfig,
  profileSettings,
} from "../../../../src/workflow/product/profile.js";
import type { WorkspaceState } from "../../../../src/workflow/state.js";

function workspace(config: Record<string, unknown> = {}): WorkspaceState {
  return { config: configSchema.parse(config) } as unknown as WorkspaceState;
}
const brief = (originalRequest = "Make the value two.") => ({ originalRequest }) as ProductBrief;
const failed = (check: string, subjectDigest: string) => ({
  check,
  subjectDigest,
  status: "failed" as const,
});
const state = (fields: Partial<ProductState>) => fields as ProductState;

describe("featureProfile", () => {
  it("is lean by default", () => {
    expect(featureProfile(workspace(), { brief: brief() })).toEqual({ name: "lean" });
  });

  it("is full when configured, or when the worker is configured as weak", () => {
    expect(
      featureProfile(workspace({ workflow: { profile: "full" } }), { brief: brief() }),
    ).toEqual({
      name: "full",
      reason: "workflow.profile is full",
    });
    expect(featureProfile(workspace({ workflow: { worker: "weak" } }), { brief: brief() })).toEqual(
      {
        name: "full",
        reason: "workflow.worker is weak",
      },
    );
  });

  it("is full when the request lists more than 20 requirements", () => {
    const items = (count: number) =>
      Array.from({ length: count }, (_, index) => `- Field number ${index + 1} is shown.`).join(
        "\n",
      );
    expect(featureProfile(workspace(), { brief: brief(items(20)) }).name).toBe("lean");
    expect(featureProfile(workspace(), { brief: brief(items(21)) })).toEqual({
      name: "full",
      reason: "the request lists 21 requirements, more than 20",
    });
  });

  it("does not count the wrapper or pasted logs as requirements when it decides", () => {
    const items = Array.from({ length: 16 }, (_, index) => `- Field number ${index + 1} is shown.`);
    const wrapper = [
      "This project uses VISP. Read CLAUDE.md and the VISP instructions it references before starting, and follow them.",
      "Run every shell command from that directory and create or edit files only inside it. Do not read other directories. Do not ask questions: make reasonable assumptions and continue. Do not delegate to other agents. Build it, run your tests, and finish with a short report of what you actually verified.",
    ];
    const pasted = Array.from(
      { length: 8 },
      (_, index) => `ValueError: step ${index + 1} should not be reached`,
    );
    const request = [...wrapper, "Task:", "", ...items, "", ...pasted].join("\n");
    expect(featureProfile(workspace(), { brief: brief(request) })).toEqual({ name: "lean" });
    // Real requirements past the limit still escalate.
    const many = [...items, ...items.map((item) => `${item} Also in the export.`)].join("\n");
    expect(featureProfile(workspace(), { brief: brief(`${request}\n${many}`) }).name).toBe("full");
  });

  it("is full once a check has failed on two versions of the product, not on a rerun of one", () => {
    const rerun = state({ executions: [failed("C001", "a"), failed("C001", "a")] as never });
    expect(featureProfile(workspace(), { brief: brief(), state: rerun }).name).toBe("lean");
    const twice = state({
      executions: [failed("C001", "a"), failed("C002", "b"), failed("C001", "c")] as never,
    });
    expect(featureProfile(workspace(), { brief: brief(), state: twice })).toEqual({
      name: "full",
      reason: "check C001 failed on two versions of the product",
    });
  });

  it("keeps an escalation a later step recorded", () => {
    const escalated = state({
      executions: [],
      profileEscalation: { reason: "the change touches 16 files", createdAt: "t" },
    });
    expect(featureProfile(workspace(), { brief: brief(), state: escalated })).toEqual({
      name: "full",
      reason: "the change touches 16 files",
    });
  });
});

describe("profileSettings", () => {
  it("follows the profile unless a switch is set", () => {
    expect(profileSettings(workspace(), { brief: brief() })).toEqual({
      draftFirst: "visual",
      reviewCadence: "feature",
      requestGaps: "required",
    });
    expect(
      profileSettings(workspace({ workflow: { profile: "full" } }), { brief: brief() }),
    ).toEqual({ draftFirst: "off", reviewCadence: "slice", requestGaps: "reviewer" });
    expect(
      profileSettings(workspace({ workflow: { profile: "full", reviewCadence: "feature" } }), {
        brief: brief(),
      }).reviewCadence,
    ).toBe("feature");
  });
});

describe("largeChange", () => {
  it("names a change of more than 15 files or across more than 4 top-level areas", () => {
    const files = (count: number, area = "src") =>
      Array.from({ length: count }, (_, index) => `${area}/f${index}.ts`);
    expect(largeChange(files(15))).toBeUndefined();
    expect(largeChange(files(16))).toBe("the change touches 16 files, more than 15");
    expect(largeChange(["a.ts", "src/b.ts", "test/c.ts", "docs/d.md"])).toBeUndefined();
    expect(largeChange(["a.ts", "src/b.ts", "test/c.ts", "docs/d.md", "scripts/e.sh"])).toBe(
      "the change spans 5 top-level areas, more than 4",
    );
  });
});

describe("leanCriticConfig", () => {
  const config = {
    harness: "claude-code" as const,
    model: "claude-sonnet-5-5",
    maxCalls: 3,
    timeoutMs: 180_000,
    maxImageBytes: 4_194_304,
  };
  it("reviews a lean feature with a Haiku-class model at low effort under Claude Code", () => {
    expect(leanCriticConfig(workspace(), { ...config, reasoningEffort: "high" })).toMatchObject({
      model: "claude-haiku-5-5",
      reasoningEffort: "low",
    });
    expect(
      leanCriticConfig(workspace({ critic: { leanReasoningEffort: "medium" } }), config)
        .reasoningEffort,
    ).toBe("medium");
  });
  it("uses critic.leanModel when set, and the configured model and effort on other hosts", () => {
    expect(
      leanCriticConfig(workspace({ critic: { leanModel: "claude-sonnet-5-5" } }), config).model,
    ).toBe("claude-sonnet-5-5");
    expect(
      leanCriticConfig(workspace(), {
        ...config,
        harness: "codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
      }),
    ).toMatchObject({ model: "gpt-5.6-sol", reasoningEffort: "medium" });
  });
});
