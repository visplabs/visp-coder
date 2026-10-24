import { z } from "zod";
import { historicalCriticConfigSchema } from "../../config/critic-history.js";
import { PRODUCT_STATE_VERSION } from "../../core/constants.js";
import { vispError } from "../../core/errors.js";
import { hashValue } from "../../core/hash.js";
import { err, ok, type Result } from "../../core/result.js";
import { browserJourneySchema } from "../../testing/browser-journey.js";
import { acceptanceBaselineSchema } from "../artifacts/acceptance.js";
import {
  commandSpecSchema,
  featureIdSchema,
  pathPatternSchema,
  taskClassSchema,
  taskIdSchema,
} from "../artifacts/common.js";
import { flipCheckSchema } from "../artifacts/evidence.js";
import { browserCapabilitySchema } from "./environment-model.js";
import { experimentResolutionsSchema } from "./experiment-model.js";
import { productFeedbackSchema } from "./feedback-model.js";
import { journeyRetirementSchema } from "./journey-ownership.js";
import { reproductionSchema } from "./reproduction-model.js";
import { generatedSourceReferencesSchema } from "./review/review-delivery-validation.js";
import { userFeedbackRecordSchema } from "./user-feedback-model.js";

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
/** An image a check writes, relative to the project root, delivered to the reviewer when it passes. */
export const checkImagePathSchema = z
  .string()
  .regex(
    /\.(?:png|jpe?g|webp|gif|svg)$/i,
    "a check image must be a .png, .jpg, .webp, .gif or .svg file",
  )
  .refine(
    (path) => !/^(?:[A-Za-z]:)?[\\/]/.test(path) && !path.split(/[\\/]/).includes(".."),
    "a check image is a path inside the project",
  )
  .refine(
    (path) =>
      path
        .split(/[\\/]/)
        .find((part) => part && part !== ".")
        ?.toLowerCase() !== ".visp",
    "a check image is a product output, not a file under .visp/",
  );
const provenance = z.enum(["user-stated", "independent", "agent-proposed", "legacy"]);
const productOutcomeSchema = z
  .object({
    id,
    kind: z.enum(["functional", "quality", "experience"]),
    statement: z.string().min(1),
    priority: z.enum(["must", "should", "could"]).default("must"),
    provenance: provenance.default("agent-proposed"),
    source: z.string().trim().min(1).optional(),
    sourceQuote: z.string().optional(),
    target: z.string().optional(),
    reviewRequired: z.boolean().default(false),
    expectations: z
      .array(
        z
          .object({
            id,
            statement: z.string().min(1),
            provenance: provenance.default("agent-proposed"),
            source: z.string().trim().min(1).optional(),
            sourceQuote: z.string().optional(),
            viewport: z
              .object({
                width: z.number().int().positive().max(16384),
                height: z.number().int().positive().max(16384),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const productCheckSchema = z
  .object({
    id,
    command: z.union([
      commandSpecSchema,
      z.object({ kind: z.literal("browser-journey"), journey: browserJourneySchema }).strict(),
    ]),
    outcomes: z.array(id).default([]),
    files: z.array(pathPatternSchema).default([]),
    verifierFiles: z.array(pathPatternSchema).optional(),
    timeoutMs: z.number().int().positive().max(3_600_000).optional(),
    environment: z.enum(["node", "browser", "other"]).default("other"),
    environmentVariables: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).optional(),
    images: z.array(checkImagePathSchema).min(1).max(4).optional(),
  })
  .strict();

export const productSliceSchema = z
  .object({
    id: taskIdSchema,
    taskClass: taskClassSchema.optional(),
    goal: z.string().min(1),
    outcomes: z.array(id).default([]),
    dependsOn: z.array(taskIdSchema).default([]),
    scope: z
      .object({
        allowed: z.array(pathPatternSchema).default([]),
        expected: z.array(pathPatternSchema).default([]),
        forbidden: z.array(pathPatternSchema).default([]),
      })
      .strict(),
    checks: z.array(id).default([]),
    approach: z.string().default(""),
  })
  .strict();

const productBriefFieldsSchema = z
  .object({
    version: z.literal(2),
    feature: featureIdSchema,
    incomplete: z.boolean().default(false),
    originalRequest: z.string().min(1),
    goal: z.string().min(1),
    outcomes: z.array(productOutcomeSchema).default([]),
    examples: z
      .array(
        z
          .object({
            id,
            title: z.string().min(1),
            given: z.array(z.string()).default([]),
            when: z.string(),
            expected: z.array(z.string()).default([]),
            outcomes: z.array(id).default([]),
          })
          .strict(),
      )
      .default([]),
    decisions: z
      .array(
        z
          .object({
            id,
            statement: z.string().min(1),
            rationale: z.string().default(""),
            evidence: z.array(z.string()).default([]),
            implications: z.array(z.string()).default([]),
            outcomes: z.array(id).default([]),
          })
          .strict(),
      )
      .default([]),
    uncertainties: z.array(z.string()).default([]),
    checks: z.array(productCheckSchema).default([]),
    slices: z.array(productSliceSchema).default([]),
    acceptanceBaseline: acceptanceBaselineSchema.default([]),
    design: z
      .object({
        description: z.string().default(""),
        references: z.array(z.string()).default([]),
        refinementCycles: z.number().int().min(0).max(10).default(2),
      })
      .strict()
      .optional(),
  })
  .strict();

export const productBriefSchema = productBriefFieldsSchema.superRefine((brief, context) => {
  validateBriefIds(brief, context);
  validateBriefReferences(brief, context);
  validateSliceCycles(brief, context);
  validateImageChecks(brief, context);
});

/** Authored input exposes the same fields while leaving identifier allocation to VISP. */
export const productBriefInputSchema = productBriefFieldsSchema.extend({
  outcomes: z
    .array(
      productOutcomeSchema.extend({
        id: id.optional(),
        expectations: z
          .array(
            productOutcomeSchema.shape.expectations.removeDefault().element.partial({ id: true }),
          )
          .default([]),
      }),
    )
    .default([]),
  examples: z
    .array(productBriefFieldsSchema.shape.examples.removeDefault().element.partial({ id: true }))
    .default([]),
  decisions: z
    .array(productBriefFieldsSchema.shape.decisions.removeDefault().element.partial({ id: true }))
    .default([]),
  checks: z.array(productCheckSchema.partial({ id: true })).default([]),
  slices: z.array(productSliceSchema.partial({ id: true })).default([]),
});

function validateBriefIds(brief: ProductBrief, context: z.RefinementCtx): void {
  for (const [name, entries] of Object.entries({
    outcomes: brief.outcomes,
    examples: brief.examples,
    decisions: brief.decisions,
    checks: brief.checks,
    slices: brief.slices,
  })) {
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.id))
        context.addIssue({
          code: "custom",
          path: [name],
          message: `Duplicate ${name} id ${entry.id}`,
        });
      seen.add(entry.id);
    }
  }
  for (const [index, outcome] of brief.outcomes.entries()) {
    const seen = new Set<string>();
    for (const expectation of outcome.expectations) {
      if (seen.has(expectation.id))
        context.addIssue({
          code: "custom",
          path: ["outcomes", index, "expectations"],
          message: `Duplicate expectation id ${expectation.id}`,
        });
      seen.add(expectation.id);
    }
  }
}

function validateBriefReferences(brief: ProductBrief, context: z.RefinementCtx): void {
  const outcomes = new Set(brief.outcomes.map((entry) => entry.id));
  for (const entry of [...brief.examples, ...brief.decisions, ...brief.checks, ...brief.slices]) {
    for (const outcome of entry.outcomes)
      if (!brief.incomplete && !outcomes.has(outcome))
        context.addIssue({
          code: "custom",
          message: `${entry.id} references unknown outcome ${outcome}`,
        });
  }
  validateSliceReferences(brief, context);
}

/**
 * A check that declares images delivers a picture for review, so how the picture must look is
 * part of the contract: it covers an experience outcome the reviewer judges from the image.
 * Technical outcomes alone (the file is written, the grid has a size) cannot fail on a scene
 * that does not show what the request names.
 */
function validateImageChecks(brief: ProductBrief, context: z.RefinementCtx): void {
  if (brief.incomplete) return;
  const experiences = new Set(
    brief.outcomes.filter((entry) => entry.kind === "experience").map((entry) => entry.id),
  );
  for (const check of brief.checks)
    if (check.images?.length && typeof check.command === "object" && !Array.isArray(check.command))
      context.addIssue({
        code: "custom",
        path: ["checks"],
        message: `${check.id} is a browser journey, whose captures already reach the reviewer; remove its images, which only a command check writes`,
      });
    else if (check.images?.length && !check.outcomes.some((outcome) => experiences.has(outcome)))
      context.addIssue({
        code: "custom",
        path: ["checks"],
        message: `${check.id} declares images, so it must cover an experience outcome: add an outcome with kind: experience naming what the picture must show (each object, subject and concrete look the request names, recognizable), and list its ID in the outcomes of ${check.id}${checkSlices(brief, check.id)}`,
      });
}

/** " and of slice T001" for the slices that run a check, so the outcome is reviewed with them. */
function checkSlices(brief: ProductBrief, check: string): string {
  const slices = brief.slices
    .filter((slice) => slice.checks.includes(check))
    .map((slice) => slice.id);
  if (!slices.length) return "";
  const listed =
    slices.length === 1 ? slices[0] : `${slices.slice(0, -1).join(", ")} and ${slices.at(-1)}`;
  return ` and of slice${slices.length === 1 ? "" : "s"} ${listed}`;
}

function validateSliceReferences(brief: ProductBrief, context: z.RefinementCtx): void {
  const checks = new Set(brief.checks.map((entry) => entry.id));
  const slices = new Map(brief.slices.map((entry) => [entry.id, entry]));
  for (const slice of brief.slices) {
    for (const check of slice.checks)
      if (!checks.has(check))
        context.addIssue({
          code: "custom",
          message: `${slice.id} references unknown check ${check}`,
        });
    for (const dependency of slice.dependsOn)
      if (!slices.has(dependency))
        context.addIssue({
          code: "custom",
          message: `${slice.id} references unknown slice ${dependency}`,
        });
  }
}

function validateSliceCycles(brief: ProductBrief, context: z.RefinementCtx): void {
  const slices = new Map(brief.slices.map((entry) => [entry.id, entry]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(key: string): void {
    if (visiting.has(key)) {
      context.addIssue({ code: "custom", message: `Slice dependency cycle at ${key}` });
      return;
    }
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of slices.get(key)?.dependsOn ?? []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  }
  for (const slice of brief.slices) visit(slice.id);
}

export type ProductBrief = z.infer<typeof productBriefFieldsSchema>;
export type ProductOutcome = z.infer<typeof productOutcomeSchema>;
export type ProductSlice = z.infer<typeof productSliceSchema>;
export type ProductCheck = z.infer<typeof productCheckSchema>;

/** Omitted identifiers are allocated deterministically; supplied IDs never move. */
export function parseProductBrief(input: unknown): Result<ProductBrief> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return err(vispError("ARTIFACT_INVALID", "A brief must be an object"));
  const structured = productBriefInputSchema.safeParse(input);
  if (!structured.success) return invalidBrief(structured.error);
  const inputBrief = structured.data;
  const authored = {
    ...inputBrief,
    outcomes: allocateIdentifiers(inputBrief.outcomes, "O").map((outcome) => ({
      ...outcome,
      expectations: allocateIdentifiers(outcome.expectations, `${outcome.id}_AC`, 0),
    })),
    examples: allocateIdentifiers(inputBrief.examples, "SCN"),
    decisions: allocateIdentifiers(inputBrief.decisions, "D"),
    checks: allocateIdentifiers(inputBrief.checks, "C"),
    slices: allocateIdentifiers(inputBrief.slices, "T"),
  };
  const parsed = productBriefSchema.safeParse(authored);
  return parsed.success ? ok(parsed.data) : invalidBrief(parsed.error);
}

/** One line per invalid field path, without repeating schema internals. */
export function briefIssueLines(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "brief"}: ${issue.message}`)
    .join("\n");
}

function invalidBrief(error: z.ZodError): Result<never> {
  return err(
    vispError("ARTIFACT_INVALID", `Invalid brief:\n${briefIssueLines(error)}`, {
      recovery:
        "visp brief --help for field examples; keep the current brief from --template and submit changes with --from - --reason <decision>",
      details: { issues: error.issues },
    }),
  );
}

function allocateIdentifiers<T extends { id?: string }>(
  entries: readonly T[],
  prefix: string,
  width = 3,
): (T & { id: string })[] {
  const used = new Set(entries.flatMap((entry) => (entry.id === undefined ? [] : [entry.id])));
  let ordinal = 1;
  return entries.map((entry) => {
    if (entry.id !== undefined) return { ...entry, id: entry.id };
    while (used.has(`${prefix}${String(ordinal).padStart(width, "0")}`)) ordinal++;
    const id = `${prefix}${String(ordinal++).padStart(width, "0")}`;
    used.add(id);
    return { ...entry, id };
  });
}

export function outcomeDigest(brief: ProductBrief): string {
  return hashValue({
    originalRequest: brief.originalRequest,
    outcomes: brief.outcomes,
    examples: brief.examples,
    acceptanceBaseline: brief.acceptanceBaseline,
  });
}

export function sliceDigest(brief: ProductBrief, slice: ProductSlice): string {
  return hashValue({
    originalRequest: brief.originalRequest,
    slice,
    outcomes: brief.outcomes.filter((outcome) => slice.outcomes.includes(outcome.id)),
    examples: brief.examples.filter((example) =>
      example.outcomes.some((id) => slice.outcomes.includes(id)),
    ),
    checks: checksFor(brief, slice),
    decisions: brief.decisions.filter(
      (decision) =>
        decision.outcomes.length > 0 && decision.outcomes.some((id) => slice.outcomes.includes(id)),
    ),
    // Pinned acceptance files are protected by their hashes and by the intent-change rule;
    // leaving them out lets tests written in the background be pinned mid-slice.
    ...(brief.outcomes.some(
      (outcome) => outcome.kind === "experience" && slice.outcomes.includes(outcome.id),
    ) && brief.design
      ? { design: brief.design }
      : {}),
  });
}

/** A slice that may write a page or component file builds a web UI, observed through journeys. */
export function hasWebUiScope(slices: readonly ProductSlice[]): boolean {
  return slices.some((slice) =>
    slice.scope.allowed.some((path) => /\.(?:html?|jsx|tsx|vue|svelte)$/.test(path)),
  );
}

export function checksFor(brief: ProductBrief, slice?: ProductSlice): ProductCheck[] {
  return slice ? brief.checks.filter((check) => slice.checks.includes(check.id)) : brief.checks;
}

const assessmentStatusSchema = z.enum(["satisfied", "failed", "unclear", "unavailable"]);
export const PRODUCT_REVIEW_POLICY = 5 as const;
/** VISP generates these IDs from retained examples; the reviewer supplies observations, not a ledger. */
export const coverageAssessmentSchema = z
  .object({
    id,
    status: assessmentStatusSchema,
    reason: z.string().trim().min(1),
    evidence: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type ProductCoverageAssessment = z.infer<typeof coverageAssessmentSchema>;
export const reviewerContextSchema = z
  .object({
    session: z.string().uuid().optional(),
    // Read-only: reviews recorded before the observation-preview mode was removed carry it.
    reviewMode: z.enum(["current", "observation-preview"]).optional(),
    context: z.enum(["fresh", "current", "unavailable", "unspecified"]),
    reason: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
  })
  .strict();
export type ProductReviewerContext = z.infer<typeof reviewerContextSchema>;
export const assessmentSchema = z
  .object({
    outcome: id,
    status: assessmentStatusSchema,
    provenance: z.literal("agent-reported").default("agent-reported"),
    expectations: z
      .array(
        z
          .object({
            id,
            status: assessmentStatusSchema,
            reason: z.string().trim().min(1),
            evidence: z.array(z.string().min(1)).optional(),
          })
          .strict(),
      )
      .default([]),
    summary: z.string().min(1),
    evidence: z.array(z.string()).default([]),
  })
  .strict();
export type ProductAssessment = z.infer<typeof assessmentSchema>;

export const executionSchema = z
  .object({
    id: z.string(),
    check: z.string(),
    task: taskIdSchema.optional(),
    subjectDigest: z.string(),
    contractDigest: z.string(),
    createdAt: z.string(),
    command: z.string(),
    status: z.enum(["passed", "failed", "environment-failed", "timed-out"]),
    exitCode: z.number(),
    durationMs: z.number(),
    /** Display-only regression comparison; never passing evidence or a gate. */
    flip: flipCheckSchema.optional(),
    flipCacheKey: z.string().optional(),
    flipDurationMs: z.number().nonnegative().optional(),
    output: z.string(),
    /** Complete runner-derived failure attribution, independent of the displayed output budget. */
    pinnedFailures: z
      .object({
        names: z.array(z.string()),
        unattributed: z.number().int().nonnegative(),
        /** Full-output missing results after verified intentional skips; absent on old receipts. */
        unreported: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    provenance: z.enum(["supervisor-executed", "supervisor-reused"]),
    assertions: z.enum(["agent-reported", "runner-observed"]),
    captureRunId: z.string().optional(),
    /** Capture IDs of the images a passing command check declared. */
    checkImages: z.array(z.string()).optional(),
    environmentDigest: z.string().optional(),
    comparisonEnvironment: z.string().optional(),
    reusedEnvironmentFailure: z.boolean().optional(),
    commandVerifier: z
      .object({
        version: z.literal(2),
        verifier: z.string().regex(/^[a-f0-9]{64}$/),
        executable: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
    verifierDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .refine(
    (entry) => !entry.commandVerifier || hashValue(entry.commandVerifier) === entry.verifierDigest,
    {
      path: ["commandVerifier"],
      message: "Observed command verifier components must match the recorded verifier digest",
    },
  );
export type ProductExecution = z.infer<typeof executionSchema>;

/** A later run supersedes only a run owned by the same check and task. */
export function latestExecutionsByOwner(
  executions: readonly ProductExecution[],
): ProductExecution[] {
  const latest = new Map<string, ProductExecution>();
  for (const execution of executions) {
    const owner = JSON.stringify([execution.check, execution.task]);
    latest.delete(owner);
    latest.set(owner, execution);
  }
  return [...latest.values()];
}

export const productStateSchema = z
  .object({
    version: z.literal(PRODUCT_STATE_VERSION),
    feature: featureIdSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    briefDigest: z.string(),
    outcomeDigest: z.string(),
    intentSnapshot: z
      .object({
        originalRequest: z.string().min(1),
        outcomes: z.array(productOutcomeSchema),
        examples: z.array(z.unknown()),
        acceptanceBaseline: acceptanceBaselineSchema,
      })
      .strict(),
    status: z.enum(["active", "accepted", "historical-complete"]).default("active"),
    browserCapability: browserCapabilitySchema.optional(),
    criticDefault: historicalCriticConfigSchema.optional(),
    criticBudgetVersion: z.literal(1).optional(),
    criticEnabled: z.boolean().optional(),
    /** The lean profile turned the reviewer off (no critic mode was set); escalation turns it on. */
    criticLeanOff: z.boolean().optional(),
    /** A lean feature with no reviewer (D13 default or `critic.mode: off`): accepted on its checks. */
    criticAcceptOnChecks: z.boolean().optional(),
    criticManual: z.boolean().optional(),
    userFeedback: z.array(userFeedbackRecordSchema).optional(),
    checkpoints: z
      .array(
        z
          .object({
            task: z.string(),
            candidate: z.string().regex(/^CAN-[a-f0-9]{32}$/),
            subject: z.string(),
            intent: z.string(),
          })
          .strict(),
      )
      .optional(),
    criticPolicyChanges: z
      .array(
        z
          .object({
            enabled: z.boolean(),
            manual: z.boolean().optional(),
            createdAt: z.string(),
            provenance: z.literal("caller-reported"),
            reason: z.string(),
          })
          .strict(),
      )
      .optional(),
    slices: z.record(
      z
        .object({
          status: z.enum(["pending", "in-progress", "closed", "legacy-closed"]),
          contractDigest: z.string(),
        })
        .strict(),
    ),
    sliceHistory: z
      .array(
        z
          .object({
            task: taskIdSchema,
            from: z.string(),
            to: z.string(),
            createdAt: z.string(),
            subjectDigest: z.string(),
            reason: z.string(),
          })
          .strict(),
      )
      .default([]),
    executions: z.array(executionSchema).default([]),
    pendingVerification: z.string().optional(),
    reproductions: z.array(reproductionSchema).optional(),
    captures: z.array(z.unknown()).default([]),
    captureRuns: z.array(z.unknown()).default([]),
    journeyRetirements: z.array(journeyRetirementSchema).optional(),
    controls: z.array(z.unknown()).default([]),
    reviews: z
      .array(
        z
          .object({
            policyVersion: z
              .union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
              .optional(),
            findingIdentityVersion: z.literal(2).optional(),
            // Delivered identities later catalogues cannot re-derive: diffs and broad-scope files.
            deliveredDiffReferences: generatedSourceReferencesSchema.optional(),
            subjectDigest: z.string(),
            implementationDigest: z.string().optional(),
            contractDigest: z.string(),
            task: taskIdSchema.optional(),
            createdAt: z.string(),
            assessments: z.array(assessmentSchema),
            coverage: z.array(coverageAssessmentSchema).optional(),
            reviewer: reviewerContextSchema.optional(),
            feedback: productFeedbackSchema.optional(),
            experimentResolutions: experimentResolutionsSchema.optional(),
            feedbackIntentDigest: z.string().optional(),
            captures: z.array(z.unknown()).default([]),
          })
          .strict(),
      )
      .default([]),
    revisions: z
      .array(
        z
          .object({
            createdAt: z.string(),
            reason: z.string(),
            kind: z.enum(["method", "intent"]),
            provenance: z.string(),
            before: z.string(),
            after: z.string(),
          })
          .strict(),
      )
      .default([]),
    /** Why a lean feature moved to the full profile, when a later step decided it. */
    profileEscalation: z
      .object({ reason: z.string().min(1), createdAt: z.string() })
      .strict()
      .optional(),
    acceptedSubject: z.string().optional(),
    acceptedContract: z.string().optional(),
    acceptedReviewPolicy: z
      .union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
      .optional(),
  })
  .strict();
export type ProductState = z.infer<typeof productStateSchema>;

export function initialProductState(brief: ProductBrief, timestamp: string): ProductState {
  return {
    version: PRODUCT_STATE_VERSION,
    feature: brief.feature,
    createdAt: timestamp,
    updatedAt: timestamp,
    briefDigest: hashValue(brief),
    outcomeDigest: outcomeDigest(brief),
    intentSnapshot: {
      originalRequest: brief.originalRequest,
      outcomes: brief.outcomes,
      examples: brief.examples,
      acceptanceBaseline: brief.acceptanceBaseline,
    },
    status: "active",
    slices: Object.fromEntries(
      brief.slices.map((slice) => [
        slice.id,
        { status: "pending", contractDigest: sliceDigest(brief, slice) },
      ]),
    ),
    sliceHistory: [],
    executions: [],
    captures: [],
    captureRuns: [],
    controls: [],
    reviews: [],
    revisions: [],
  };
}

export const closedSlice = (status: string | undefined): boolean =>
  status === "closed" || status === "legacy-closed";
