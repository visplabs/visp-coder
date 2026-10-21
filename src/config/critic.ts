import { z } from "zod";

export const CRITIC_MAX_CALLS = 6;
/**
 * Default reviews per feature. In weak-actor runs the first three reviews found every
 * contract gap the hidden tests checked; later ones raised untested edge cases and
 * doubled the time. Repair gains also flatten after 2–3 rounds in published studies.
 */
const CRITIC_DEFAULT_CALLS = 3;
export const CRITIC_MIN_TIMEOUT_MS = 1000;
export const CRITIC_CALL_TIMEOUT_MS = 180_000;
export const CRITIC_FEATURE_TIMEOUT_MS = 18 * 60 * 1000;

export const CRITIC_HARNESSES = ["codex", "claude-code", "cursor", "copilot"] as const;
export const criticHarnessSchema = z.enum(CRITIC_HARNESSES);
export const reasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh"]);

/** VISP bounds calls, time and images; native hosts own context/generation/billing limits. */
export const criticConfigSchema = z
  .object({
    model: z.string().trim().min(1).max(200),
    reasoningEffort: reasoningEffortSchema.optional(),
    transport: z.enum(["sampling", "native"]).optional(),
    harness: criticHarnessSchema.optional(),
    maxCalls: z.number().int().min(1).max(CRITIC_MAX_CALLS),
    timeoutMs: z.number().int().min(CRITIC_MIN_TIMEOUT_MS).max(300_000),
    maxImageBytes: z
      .number()
      .int()
      .min(1024)
      .max(12 * 1024 * 1024),
  })
  .strict();
export type CriticConfig = z.infer<typeof criticConfigSchema>;

export const criticModeSchema = z.enum(["auto", "manual", "both", "off"]);
export type CriticMode = z.infer<typeof criticModeSchema>;
export function criticMode(automatic: boolean, manual: boolean): CriticMode {
  return automatic ? (manual ? "both" : "auto") : manual ? "manual" : "off";
}
export function configuredCriticMode(
  settings: { mode?: CriticMode; enabled?: boolean } | undefined,
) {
  return (
    settings?.mode ??
    (settings?.enabled === undefined ? undefined : settings.enabled ? "auto" : "off")
  );
}

/**
 * `host`: the worker's host delegates the review through the native handoff (default).
 * `codex-exec`: VISP launches a read-only, ephemeral `codex exec` reviewer itself, so a
 * worker that never orchestrates delegation still receives independent review.
 * `claude-exec`: the same with a read-only `claude -p` reviewer (critic.harness: claude-code).
 */
const criticLaunchSchema = z.enum(["host", "codex-exec", "claude-exec"]);

/** Whether VISP launches the reviewer itself instead of the worker's host delegating it. */
export function launchesReviewer(critic: { launch?: string } | undefined): boolean {
  return critic?.launch === "codex-exec" || critic?.launch === "claude-exec";
}

export const criticDefaultsSchema = criticConfigSchema
  .partial()
  .extend({
    enabled: z.boolean().optional(),
    mode: criticModeSchema.optional(),
    launch: criticLaunchSchema.optional(),
    /** With codex-exec: the reviewer may search the web; every query is logged. */
    webSearch: z.boolean().optional(),
    /** Run the independent tester on existing codebases too (execution mode, opt-in). */
    existingCodeTests: z.boolean().optional(),
    /** The reviewer model of a lean feature; `model` reviews full ones. */
    leanModel: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type CriticDefaults = z.infer<typeof criticDefaultsSchema>;

/** Pinned policy, not a live price optimizer or a claim of measured superiority. */
export function balancedCritic(harness: string): CriticConfig | undefined {
  const parsed = criticHarnessSchema.safeParse(harness);
  if (!parsed.success) return undefined;
  return {
    harness: parsed.data,
    transport: "native",
    model: harness === "claude-code" ? "claude-sonnet-5" : "gpt-5.6-sol",
    reasoningEffort: "high",
    maxCalls: CRITIC_DEFAULT_CALLS,
    timeoutMs: CRITIC_CALL_TIMEOUT_MS,
    maxImageBytes: 4 * 1024 * 1024,
  };
}
