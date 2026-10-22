import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { canonicalJson, hashValue, sha256 } from "../core/hash.js";
import {
  CRITIC_INSTRUCTIONS,
  criticConfigSchema,
  UNDERSTANDING_CRITIC_INSTRUCTIONS,
} from "../workflow/product/critic/critic-model.js";
import { VISUAL_REVIEW_INSTRUCTIONS } from "../workflow/product/review/review-instructions.js";
import {
  COMPARISON_POLICY,
  type PreparedComparison,
  readPreparedComparison,
} from "./comparison.js";

const modelChoiceConfigSchema = z
  .object({
    sameModel: criticConfigSchema,
    strongerModel: criticConfigSchema,
  })
  .strict();

export const criticComparisonConfigSchema = z.union([
  modelChoiceConfigSchema,
  z.object({ study: z.literal("feedback-policy"), reviewer: criticConfigSchema }).strict(),
]);

/** Adds an offline ablation schedule to verified, content-addressed comparison inputs. Never dispatches a model. */
export async function prepareCriticComparison(directory: string, input: unknown) {
  const config = criticComparisonConfigSchema.parse(input);
  if ("study" in config) return prepareFeedbackPolicyComparison(directory, config.reviewer);
  const pins = await readPreparedComparison(directory);
  if (config.sameModel.model !== pins.model.name)
    throw new Error("The same-model critic must match the pinned worker model");
  if (config.strongerModel.model === config.sameModel.model)
    throw new Error(
      "The stronger-model arm must name a different model; relative capability remains a study hypothesis",
    );
  const { model: _same, ...sameLimits } = config.sameModel;
  const { model: _stronger, ...strongerLimits } = config.strongerModel;
  if (hashValue(sameLimits) !== hashValue(strongerLimits))
    throw new Error("Critic limits must match across review arms to isolate model choice");
  const arms = [
    { id: "no-critic", critic: null },
    { id: "same-model-critic", critic: config.sameModel },
    { id: "stronger-model-critic", critic: config.strongerModel },
  ];
  const assignments = assignCriticTrials(pins, arms);
  const manifest = {
    schemaVersion: 1,
    kind: "prepared-critic-comparison",
    status: "prepared-awaiting-budget",
    runnable: false,
    budget: null,
    inputManifestSha256: hashValue(pins),
    candidateBundle: pins.replacement.build.sha256,
    worker: pins.model,
    arms,
    repetitions: 3,
    assignments,
    ...reviewPromptPins(),
    customSkills: "disabled",
    controls:
      "Use the same pinned replacement bundle, tools, starting code, worker settings, common/replacement instructions and environment in all three arms. Only critic configuration differs. The frozen baseline remains a separate reference.",
    evidenceIsolation:
      "Mount only the assigned start tree and implementation prompt for worker and critic. Held-out oracle objects stay evaluator-only; do not expose this preparation directory to either model.",
    policy: {
      ...COMPARISON_POLICY,
      primary: [...COMPARISON_POLICY.primary, "codeQuality"],
      calibration: [
        "supportedFindings",
        "falseAlarmsOnCorrectCandidates",
        "missedSeededDefects",
        "regressionsIntroducedByRepairs",
      ],
      secondary: [
        ...COMPARISON_POLICY.secondary,
        "criticUsd",
        "criticInputTokens",
        "criticOutputTokens",
        "criticReasoningTokens",
        "candidateSelected",
      ],
      gate: "First assess critic findings on faulty and correct candidates. Then run end-to-end trials only with separately authorized budgets. Include failed and unresolved runs; never select only successful outputs.",
    },
  } as const;
  await writeFile(
    join(directory, "critic-comparison.json"),
    `${canonicalJson({ manifest, sha256: hashValue(manifest) })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return manifest;
}

/** Sequential contrasts reuse assignments; this is not a model × mode × budget grid. */
async function prepareFeedbackPolicyComparison(
  directory: string,
  input: z.infer<typeof criticConfigSchema>,
) {
  const reviewer = input;
  const pins = await readPreparedComparison(directory);
  const arms = [
    {
      id: "frozen-baseline",
      bundle: {
        archiveSha256: pins.legacy.archiveSha256,
        manifestSha256: hashValue(pins.legacy.manifest),
      },
      instructions: pins.instructions["frozen-legacy"],
      critic: null,
      reviewMode: "baseline",
      opportunities: [],
    },
    ...(
      [
        ["integration-current-2", "current", 2],
        ["integration-current-3", "current", 3],
      ] as const
    ).map(([id, reviewMode, maxCalls]) => ({
      id,
      bundle: {
        buildSha256: pins.replacement.build.sha256,
        sourceSha256: pins.replacement.source.sha256,
      },
      instructions: pins.instructions.replacement,
      critic: { ...reviewer, maxCalls },
      reviewMode,
      opportunities:
        maxCalls === 2
          ? ["understanding", "product"]
          : ["understanding", "product", "focused-repair"],
    })),
  ];
  const assignments = assignCriticTrials(pins, arms);
  const manifest = {
    schemaVersion: 2,
    kind: "prepared-feedback-policy-comparison",
    status: "prepared-awaiting-budget",
    runnable: false,
    budget: null,
    inputManifestSha256: hashValue(pins),
    worker: pins.model,
    tools: pins.tools,
    environment: pins.environment,
    customSkills: "disabled",
    instructions: { common: pins.instructions.common },
    ...reviewPromptPins(),
    arms,
    repetitions: 3,
    assignments,
    stages: [
      {
        id: "integration",
        arms: ["frozen-baseline", "integration-current-2"],
        hypothesis:
          "The complete engineering treatment improves delivery and reduces administration without worsening product quality; this contrast does not isolate critic effectiveness.",
      },
      {
        id: "repair-opportunity",
        arms: ["integration-current-2", "integration-current-3"],
        hypothesis:
          "A third focused repair review improves net correction enough to justify its measured cost.",
      },
    ],
    policy: {
      ...COMPARISON_POLICY,
      primary: [...COMPARISON_POLICY.primary, "nonFunctionalQuality", "codeQuality"],
      calibration: ["missedDefects", "falseFindings", "actionableCorrections", "repairRegressions"],
      secondary: [
        ...COMPARISON_POLICY.secondary,
        "criticCalls",
        "criticUsd",
        "administrativeTimeMs",
      ],
      controls:
        "Use the same worker settings, tools, task starts, implementation prompts and environment. Candidate arms share one pinned bundle; review mode and call opportunities are explicit treatments. Do not cross this study with model-choice assignments.",
      stopping:
        "Calls are ceilings, not quotas. The third opportunity checks a consequential repair only. Missing required evidence and exhausted budgets remain unresolved; never force a cosmetic edit to spend a call.",
      evidenceIsolation:
        "Oracle objects and variant labels stay evaluator-only. Assess quality blind to arm; independently check behavior and counterexamples. Report all failures and unresolved runs.",
      interpretation:
        "Three repetitions per task form a pilot, not proof of superiority. Evaluate calibration before end-to-end execution. Reuse shared-arm observations across staged contrasts; do not rerun them merely because they appear in two stages. No automatic promotion.",
    },
  };
  await writeFile(
    join(directory, "critic-comparison.json"),
    `${canonicalJson({ manifest, sha256: hashValue(manifest) })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return manifest;
}

function reviewPromptPins() {
  const pin = (text: string) => ({ text, sha256: sha256(text) });
  return {
    criticInstructions: pin(CRITIC_INSTRUCTIONS),
    visualInstructions: pin(VISUAL_REVIEW_INSTRUCTIONS),
    understandingInstructions: pin(UNDERSTANDING_CRITIC_INSTRUCTIONS),
  };
}

function assignCriticTrials(pins: PreparedComparison, arms: readonly { id: string }[]) {
  return pins.tasks
    .flatMap((task) =>
      arms.flatMap((arm) =>
        Array.from({ length: 3 }, (_, index) => ({
          id: `${pins.study}.${task.id}.${arm.id}.${index + 1}`,
          task: task.id,
          arm: arm.id,
          repetition: index + 1,
        })),
      ),
    )
    .sort((a, b) => sha256(`${pins.seed}:${a.id}`).localeCompare(sha256(`${pins.seed}:${b.id}`)))
    .map((assignment, order) => ({ ...assignment, order }));
}
