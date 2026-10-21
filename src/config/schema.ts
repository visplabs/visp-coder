import { z } from "zod";
import {
  DEFAULT_BLOCKED_PATHS,
  DEFAULT_HARNESS,
  DEFAULT_PRESET,
  DEFAULT_PROFILE,
  DEFAULT_STRICTNESS,
  HARNESSES,
  LANGUAGES,
  LIMITS,
  PRESETS,
  PROFILES,
  STRICTNESS_MODES,
} from "../core/constants.js";
import { acceptanceCheckSchema } from "../workflow/artifacts/acceptance.js";
import { commandSpecSchema } from "../workflow/artifacts/common.js";
import { criticDefaultsSchema } from "./critic.js";

/**
 * The `visp.yml` contract. Every key is optional; defaults come from
 * core/constants so the file and the code cannot disagree.
 */

const workflowSchema = z
  .object({
    strictness: z.enum(STRICTNESS_MODES).default(DEFAULT_STRICTNESS),
    reviewMode: z.enum(["current", "observation-preview"]).default("current"),
    maxChangedFiles: z.number().int().positive().default(40),
    blockedPaths: z.array(z.string()).default([...DEFAULT_BLOCKED_PATHS]),
    validationCommands: z.array(commandSpecSchema).default([]),
    /** Operator-defined feature checks, pinned at feature creation and run by final-task verify. */
    acceptanceChecks: z.array(acceptanceCheckSchema).default([]),
    /**
     * Display-only regression comparison for passing declared slice checks: the check runs again on
     * the old implementation, repeating its external side effects. Never an acceptance gate; off stops it.
     */
    flipCheck: z.enum(["off", "auto", "on"]).default("auto"),
    /**
     * Lean mode. `visual`: a picture request is authorized as one slice at `visp work` without a
     * check, so the worker drafts the whole picture before declaring its check.
     */
    draftFirst: z.enum(["off", "visual"]).default("off"),
    /**
     * Lean mode. `feature`: only the slice that completes the feature is reviewed, and a review
     * after the second runs only while required findings remain open.
     */
    reviewCadence: z.enum(["slice", "feature"]).default("slice"),
    /**
     * Lean mode. `required`: a reviewer finding tagged as a gap against the request is required;
     * other findings reach the worker as notes it is not asked to act on.
     */
    requestGaps: z.enum(["reviewer", "required"]).default("reviewer"),
    /**
     * At `done` and `accept`, run the existing tests the change reaches and earlier work's checks,
     * and compare failures with the old code. `advise` reports; `gate` also blocks on a test that
     * passed before and fails now. Off by default.
     */
    regressionGate: z.enum(["off", "advise", "gate"]).default("off"),
  })
  .strict()
  .default({});

const graphSchema = z
  .object({
    languages: z.array(z.enum(LANGUAGES)).default([...LANGUAGES]),
    exclude: z.array(z.string()).default([]),
    maxFileBytes: z.number().int().positive().default(LIMITS.maxFileBytes),
  })
  .strict()
  .default({});

const contextSchema = z
  .object({
    tokenBudget: z.number().int().positive().default(LIMITS.contextTokenBudget),
    maxSnippets: z.number().int().positive().default(LIMITS.maxSnippets),
  })
  .strict()
  .default({});

const memorySchema = z
  .object({
    enabled: z.boolean().default(true),
    /**
     * With a VISP-launched reviewer, VISP records earlier requests and its model passes a new
     * feature the recorded decisions that constrain it, usually none. Off skips that call.
     */
    recall: z.boolean().default(true),
  })
  .strict()
  .default({});

const telemetrySchema = z
  .object({ enabled: z.boolean().default(true) })
  .strict()
  .default({});

export const configSchema = z
  .object({
    preset: z.enum(PRESETS).default(DEFAULT_PRESET),
    harness: z.enum(HARNESSES).default(DEFAULT_HARNESS),
    profile: z.enum(PROFILES).default(DEFAULT_PROFILE),
    workflow: workflowSchema,
    graph: graphSchema,
    context: contextSchema,
    memory: memorySchema,
    telemetry: telemetrySchema,
    critic: criticDefaultsSchema.optional(),
  })
  .strict();

export type VispConfig = z.output<typeof configSchema>;
export type GraphConfig = VispConfig["graph"];

/** The config that applies when no `visp.yml` exists. */
export function defaultConfig(): VispConfig {
  return configSchema.parse({});
}
