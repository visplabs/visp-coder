import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { canonicalJson, hashValue, sha256 } from "../core/hash.js";
import { criticConfigSchema } from "../workflow/product/critic/critic-model.js";
import { productReviewInstructions } from "../workflow/product/review/review-instructions.js";
import { readPreparedComparison } from "./comparison.js";

const absolute = z.string().refine(isAbsolute, "Use an absolute file path");
export const reviewCalibrationSchema = z
  .object({
    reviewer: criticConfigSchema,
    cases: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9-]+$/),
            scenario: z.string().min(1),
            variant: z.enum(["defective", "control"]),
            promptFile: absolute,
            assets: z.array(absolute).min(1).max(12),
            oracleFile: absolute,
          })
          .strict(),
      )
      .min(6)
      .max(16),
  })
  .strict();

/** Offline only. Model packets exclude variant labels and evaluator expectations. */
export async function prepareReviewCalibration(directory: string, input: unknown) {
  const spec = reviewCalibrationSchema.parse(input);
  const comparison = await readPreparedComparison(directory);
  if (new Set(spec.cases.map((entry) => entry.id)).size !== spec.cases.length)
    throw new Error("Duplicate calibration IDs");
  const scenarios = new Set(spec.cases.map((entry) => entry.scenario));
  if (
    scenarios.size < 3 ||
    spec.cases.length !== scenarios.size * 2 ||
    [...scenarios].some(
      (scenario) =>
        new Set(
          spec.cases.filter((entry) => entry.scenario === scenario).map((entry) => entry.variant),
        ).size !== 2,
    )
  )
    throw new Error(
      "Calibration requires at least three scenarios with one defective and one control case each",
    );
  const objects = join(directory, "objects");
  // lstat refuses a symlinked file; symlinked parent directories are ordinary (macOS keeps
  // temporary directories under the /var symlink) and do not change the pinned bytes.
  const pin = async (path: string) => {
    if (!(await lstat(path)).isFile())
      throw new Error("Calibration inputs must be regular, non-symlinked files");
    const bytes = await readFile(path);
    if (bytes.length > 16 * 1024 * 1024) throw new Error("Calibration input exceeds 16 MiB");
    const digest = sha256(bytes);
    const destination = join(objects, digest);
    await mkdir(objects, { recursive: true });
    try {
      await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    } catch (cause) {
      if (
        (cause as NodeJS.ErrnoException).code !== "EEXIST" ||
        sha256(await readFile(destination)) !== digest
      )
        throw cause;
    }
    return { sha256: digest, bytes: bytes.length };
  };
  const cases = [];
  for (const entry of spec.cases) {
    if (entry.assets.includes(entry.oracleFile) || entry.promptFile === entry.oracleFile)
      throw new Error("Evaluator expectations must not be reviewer inputs");
    const prompt = await pin(entry.promptFile);
    const oracle = await pin(entry.oracleFile);
    const assets = await Promise.all(entry.assets.map(pin));
    if ([prompt, ...assets].some((asset) => asset.sha256 === oracle.sha256))
      throw new Error("Evaluator bytes leaked into reviewer inputs");
    cases.push({
      id: entry.id,
      scenario: entry.scenario,
      variant: entry.variant,
      reviewer: { prompt, assets },
      evaluator: oracle,
    });
  }
  const assignments = cases
    .flatMap((entry) =>
      Array.from({ length: 3 }, (_, repetition) => ({
        id: `${entry.id}.current.${repetition + 1}`,
        case: entry.id,
        mode: "current",
        repetition: repetition + 1,
      })),
    )
    .sort((a, b) =>
      sha256(`${comparison.seed}:${a.id}`).localeCompare(sha256(`${comparison.seed}:${b.id}`)),
    );
  const manifest = {
    schemaVersion: 1,
    kind: "prepared-review-calibration",
    runnable: false,
    budget: null,
    provenance: "Public regression fixtures; not a held-out model study",
    comparisonSha256: hashValue(comparison),
    reviewer: spec.reviewer,
    worker: comparison.model,
    tools: comparison.tools,
    environment: comparison.environment,
    customSkills: "disabled",
    cases,
    assignments,
    currentInstructions: {
      text: productReviewInstructions({ visual: true }),
      sha256: sha256(productReviewInstructions({ visual: true })),
    },
    metrics: [
      "missedDefects",
      "falseFindings",
      "unsupportedFindings",
      "actionableCorrections",
      "repairRegressions",
      "functionalQuality",
      "nonFunctionalQuality",
      "experienceQuality",
      "visualQuality",
      "codeQuality",
      "administrativeRepairs",
      "administrativeTimeMs",
      "time",
      "cost",
    ],
    interpretation:
      "Paired defective and scoped-control cases calibrate both missed defects and false findings. Three repetitions are a descriptive pilot. Aesthetic preference is assessed separately from reproducible behavior; image delivery alone does not establish inspection or quality.",
    isolation:
      "Only reviewer.prompt and reviewer.assets belong in a review sandbox. Variant labels, evaluator objects and this manifest remain outside. No automatic promotion or model execution.",
  };
  await writeFile(
    join(directory, "review-calibration.json"),
    `${canonicalJson({ manifest, sha256: hashValue(manifest) })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return manifest;
}
