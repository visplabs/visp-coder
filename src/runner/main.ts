import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { VERSION } from "../core/version.js";
import { reportError, startErrorReporting } from "../telemetry/error-reporting.js";
import { adapterFor } from "./adapters.js";
import {
  comparisonObservationSchema,
  comparisonSpecSchema,
  prepareComparison,
  readPreparedComparison,
  summarizeComparison,
} from "./comparison.js";
import { runnerSpecSchema } from "./contracts.js";
import { prepareCriticComparison } from "./critic-comparison.js";
import {
  assignPilot,
  confirmationSchema,
  decideEscalation,
  type EscalationInput,
  type PilotScenario,
  studyObservationSchema,
  summarizeStudy,
} from "./evaluation.js";
import {
  evaluateRun,
  evaluatorSpecSchema,
  hashEvaluatorPolicy,
  inspectEvaluation,
} from "./evaluator.js";
import { prepareReviewCalibration } from "./review-calibration.js";
import { inspectRun, runExperiment, summarizeRun } from "./run.js";

async function jsonFile(path: string): Promise<unknown> {
  const bytes = await readFile(path);
  if (bytes.length > 16 * 1024 * 1024) throw new Error("Input file exceeds 16 MiB");
  return JSON.parse(bytes.toString("utf8"));
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function buildRunnerProgram(signal?: AbortSignal): Command {
  const program = new Command("visp-runner")
    .description("Optional, explicitly budgeted coding-agent experiment runner")
    .version(VERSION)
    .exitOverride();
  program
    .command("prepare-review-calibration")
    .description(
      "Pin current/preview reviewer calibration with isolated expectations; no model runs",
    )
    .requiredOption("--comparison <directory>")
    .requiredOption("--spec <path>")
    .action(async (options: { comparison: string; spec: string }) =>
      print(await prepareReviewCalibration(options.comparison, await jsonFile(options.spec))),
    );
  program
    .command("prepare-critic-comparison")
    .description(
      "Prepare a 27-run critic ablation against pinned inputs; no model calls or live budget",
    )
    .requiredOption("--comparison <directory>")
    .requiredOption("--config <path>")
    .action(async (options: { comparison: string; config: string }) => {
      print(await prepareCriticComparison(options.comparison, await jsonFile(options.config)));
    });
  program
    .command("capabilities")
    .description("Show enforced controls and observable host evidence")
    .action(() =>
      print({
        schemaVersion: 1,
        codex: adapterFor("codex").capabilities,
        claude: adapterFor("claude").capabilities,
        hostExecutor: "local-posix",
        independentEvaluator: "pinned-oci",
        ciAuthenticity: "external-attestation-required",
      }),
    );
  program
    .command("run")
    .requiredOption("--spec <path>")
    .requiredOption("--output <directory>")
    .option("--resume-from <directory>")
    .action(async (options: { spec: string; output: string; resumeFrom?: string }) => {
      const result = await runExperiment(runnerSpecSchema.parse(await jsonFile(options.spec)), {
        outputRoot: options.output,
        resumeFrom: options.resumeFrom,
        signal,
      });
      print(result);
      if (result.status !== "completed") process.exitCode = 1;
    });
  program
    .command("inspect")
    .argument("<directory>")
    .option("--full", "Print the complete manifest, result, and snapshot")
    .action(async (directory: string, options: { full?: boolean }) => {
      const run = await inspectRun(directory);
      print(options.full ? run : summarizeRun(run));
    });
  program
    .command("evaluate")
    .requiredOption("--run <directory>")
    .requiredOption("--spec <path>")
    .action(async (options: { run: string; spec: string }) => {
      const result = await evaluateRun(
        options.run,
        evaluatorSpecSchema.parse(await jsonFile(options.spec)),
        signal,
      );
      print(result);
      if (result.status !== "accepted") process.exitCode = 1;
    });
  program
    .command("inspect-evaluation")
    .argument("<runDirectory>")
    .argument("<evaluationId>")
    .action(async (directory: string, id: string) => print(await inspectEvaluation(directory, id)));
  program
    .command("hash-policy")
    .argument("<directory>")
    .action(async (directory: string) => print({ sha256: await hashEvaluatorPolicy(directory) }));
  program
    .command("prepare-comparison")
    .description(
      "Pin a quality-first 27-run comparison locally; never launch models or authorize a budget",
    )
    .requiredOption("--spec <path>")
    .requiredOption("--output <directory>")
    .action(async (options: { spec: string; output: string }) => {
      print(
        await prepareComparison(
          comparisonSpecSchema.parse(await jsonFile(options.spec)),
          options.output,
        ),
      );
    });
  program
    .command("summarize-comparison")
    .description("Describe quality dimensions and resource use without promoting a small pilot")
    .requiredOption("--prepared <directory>")
    .requiredOption("--observations <path>")
    .action(async (options: { prepared: string; observations: string }) => {
      print(
        summarizeComparison(
          await readPreparedComparison(options.prepared),
          comparisonObservationSchema.array().parse(await jsonFile(options.observations)),
        ),
      );
    });
  program
    .command("pilot")
    .description("Prepare historical 72-cell cost-policy pilot assignments")
    .requiredOption("--study <id>")
    .requiredOption("--seed <value>")
    .requiredOption("--scenarios <path>")
    .action(async (options: { study: string; seed: string; scenarios: string }) => {
      const scenarios = await jsonFile(options.scenarios);
      if (!Array.isArray(scenarios)) throw new Error("Scenarios must be an array");
      print(assignPilot(options.study, options.seed, scenarios as PilotScenario[]));
    });
  program
    .command("summarize")
    .description(
      "Summarize the historical cost-first policy; use summarize-comparison for product quality",
    )
    .requiredOption("--observations <path>")
    .option("--confirmation <path>")
    .action(async (options: { observations: string; confirmation?: string }) => {
      const rows = studyObservationSchema.array().parse(await jsonFile(options.observations));
      const confirmation = options.confirmation
        ? confirmationSchema.parse(await jsonFile(options.confirmation))
        : undefined;
      print(summarizeStudy(rows, confirmation));
    });
  program
    .command("escalation")
    .argument("<inputFile>")
    .action(async (file: string) =>
      print(decideEscalation((await jsonFile(file)) as EscalationInput)),
    );
  return program;
}

export async function main(argv: readonly string[]): Promise<number> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    await buildRunnerProgram(controller.signal).parseAsync([...argv]);
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (cause) {
    if (
      cause &&
      typeof cause === "object" &&
      "code" in cause &&
      String(cause.code).startsWith("commander.")
    ) {
      return "exitCode" in cause && typeof cause.exitCode === "number" ? cause.exitCode : 1;
    }
    await reportError(cause);
    print({ ok: false, error: cause instanceof Error ? cause.message : String(cause) });
    return 1;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

const invoked = (() => {
  try {
    return (
      Boolean(process.argv[1]) &&
      import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href
    );
  } catch {
    return false;
  }
})();
if (invoked)
  startErrorReporting()
    .then(() => main(process.argv))
    .then((code) => {
      process.exitCode = code;
    });
