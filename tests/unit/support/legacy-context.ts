/** Historical context fixture builder; never imported by production entry points. */
import { FILE } from "../../../src/core/constants.js";
import { vispError } from "../../../src/core/errors.js";
import { applyFileTransaction, withStateMutation } from "../../../src/core/file-transaction.js";
import { err, ok, type Result } from "../../../src/core/result.js";
import { recordActivity } from "../../../src/orchestrate/session.js";
import { now } from "../../../src/workflow/artifacts/common.js";
import type {
  AttemptFeedback,
  ContextContract,
  ContextFile,
  ContextManifest,
  ContextPack,
} from "../../../src/workflow/artifacts/context.js";
import { findTask, type Task, type TaskGraph } from "../../../src/workflow/artifacts/tasks.js";
import { stableContextHash } from "../../../src/workflow/stages/context/digest.js";
import type { WorkspaceState } from "../../../src/workflow/state.js";
import { fitContextBudget } from "./legacy-context/budget.js";
import { readContextContract } from "./legacy-context/contract.js";
import { legacyContextDefaults } from "./legacy-context/defaults.js";
import { readCandidates } from "./legacy-context/delivery.js";
import { extractFailurePaths } from "./legacy-context/failure-paths.js";
import { type Candidate, selectFiles } from "./legacy-context/select.js";
import { sourceHash } from "./legacy-context/source-hash.js";
import type { ContextOptions, ContextOutcome } from "./legacy-context/types.js";
import { updateStatus } from "./writers.js";

export type {
  ContextOptions,
  ContextOutcome,
} from "./legacy-context/types.js";

import { legacyStore } from "./legacy-store.js";

export async function buildContextPack(
  state: WorkspaceState,
  options: ContextOptions,
): Promise<Result<ContextOutcome>> {
  return withStateMutation(state.paths.root, () => buildLockedContextPack(state, options));
}

async function buildLockedContextPack(
  state: WorkspaceState,
  options: ContextOptions,
): Promise<Result<ContextOutcome>> {
  const resolved = await resolveContextTask(state, options);
  if (!resolved.ok) return resolved;

  const compiled = await compileContextPack(state, options, resolved.value);
  if (!compiled.ok) return compiled;

  const manifest = await buildManifest(
    state,
    options.feature,
    resolved.value.task.id,
    compiled.value.pack,
    options.graph?.snapshotId,
  );
  if (!manifest.ok) return manifest;

  const persisted = await persistContextPack(
    state,
    options,
    resolved.value.task.id,
    compiled.value,
    manifest.value,
  );
  if (!persisted.ok) return persisted;

  return ok({
    pack: compiled.value.pack,
    manifest: manifest.value,
    path: persisted.value,
  });
}

interface ResolvedContextTask {
  readonly graph: TaskGraph;
  readonly task: Task;
  readonly repositoryFiles: readonly string[];
}

interface CompiledContext {
  readonly pack: ContextPack;
  readonly feedback?: AttemptFeedback;
}

async function resolveContextTask(
  state: WorkspaceState,
  options: ContextOptions,
): Promise<Result<ResolvedContextTask>> {
  const graph = await legacyStore(state).readTasks(options.feature);
  if (!graph.ok) return graph;

  const task = findTask(graph.value, options.taskId);
  if (!task) {
    return err(
      vispError("TASK_NOT_FOUND", `${options.taskId} is not in the task graph`, {
        recovery: "visp status",
      }),
    );
  }
  return ok({
    graph: graph.value,
    task,
    repositoryFiles: options.graph?.repositoryFiles ?? options.repositoryFiles ?? [],
  });
}

async function compileContextPack(
  state: WorkspaceState,
  options: ContextOptions,
  resolved: ResolvedContextTask,
): Promise<Result<CompiledContext>> {
  const feedback = await readAttemptFeedback(
    state,
    options.feature,
    resolved.task.id,
    resolved.repositoryFiles,
  );
  if (!feedback.ok) return feedback;

  const contract = await readContextContract(state, options.feature, resolved.task);
  if (!contract.ok) return contract;
  const required = assembleContextPack(
    state,
    options,
    resolved.task,
    contract.value,
    feedback.value,
    [],
    [],
  );

  const candidates = contextCandidates(
    options,
    resolved,
    feedback.value,
    legacyContextDefaults.ranking,
  );
  const contents = await readCandidates(
    state,
    candidates,
    options.graph?.regionsByPath ?? {},
    Math.max(0, state.config.context.tokenBudget - required.estimatedTokens),
  );
  if (!contents.ok) return contents;

  return ok({
    pack: assembleContextPack(
      state,
      options,
      resolved.task,
      contract.value,
      feedback.value,
      contents.value.files,
      contents.value.omitted,
    ),
    ...(feedback.value ? { feedback: feedback.value } : {}),
  });
}

function contextCandidates(
  options: ContextOptions,
  resolved: ResolvedContextTask,
  feedback?: AttemptFeedback,
  ranking?: "priority" | "fused",
): Candidate[] {
  return selectFiles({
    ranking,
    task: resolved.task,
    repositoryFiles: resolved.repositoryFiles,
    dependencyFiles: dependencyOutputs(resolved.graph, resolved.task),
    tests: [...resolved.task.validationFiles, ...(options.graph?.tests ?? [])],
    ...(feedback ? { failureFiles: feedback.referencedFiles } : {}),
    ...(options.graph
      ? {
          neighbours: options.graph.neighbours,
          entrypoints: options.graph.entrypoints,
        }
      : {}),
  });
}

function assembleContextPack(
  state: WorkspaceState,
  options: ContextOptions,
  task: Task,
  contract: ContextContract,
  feedback: AttemptFeedback | undefined,
  files: readonly ContextFile[],
  omitted: ContextPack["omitted"],
): ContextPack {
  const budget = state.config.context.tokenBudget;
  const pack: ContextPack = {
    kind: "context",
    createdAt: now(),
    feature: options.feature,
    task: task.id,
    goal: task.title,
    contract,
    artifactRef: state.paths.relative(state.paths.contextFile(options.feature, task.id)),
    files: [...files],
    omitted,
    entrypoints: [...(options.graph?.entrypoints ?? [])],
    unknowns: [...(options.graph?.unknowns ?? [])],
    ...(feedback ? { attemptFeedback: feedback } : {}),
    ...(options.staleIndex ? { staleIndex: options.staleIndex } : {}),
    estimatedTokens: 0,
    tokenBudget: budget,
    graphAvailable: options.graph !== undefined,
    graphDeferred: options.graphDeferred === true,
  };
  return fitContextBudget(pack, task, legacyContextDefaults.includeSnippets);
}

async function persistContextPack(
  state: WorkspaceState,
  options: ContextOptions,
  taskId: string,
  compiled: CompiledContext,
  manifest: ContextManifest,
): Promise<Result<string>> {
  const packPath = state.paths.contextFile(options.feature, taskId);
  const written = await applyFileTransaction(state.paths.root, "compile-context", [
    { kind: "write", path: packPath, content: `${JSON.stringify(compiled.pack, null, 2)}\n` },
    {
      kind: "write",
      path: state.paths.contextManifest(options.feature, taskId),
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    },
  ]);
  if (!written.ok) return written;

  const status = await updateStatus(state, {
    activeTask: taskId,
    stage: "context",
    lastCommand: `context ${taskId}`,
  });
  if (!status.ok) return status;

  // The trail used to record `done` and nothing else, which made "did the
  // agent ever rebuild context?" unanswerable for every finished run.
  await recordActivity(state, {
    command: "context",
    outcome: "ok",
    detail: compiled.feedback
      ? `${taskId} (answering a failed ${compiled.feedback.source})`
      : taskId,
  });
  return ok(packPath);
}

/** Per failing command, so one noisy command cannot spend the whole feedback. */
const FAILURE_OUTPUT_CAP = 2000;

/**
 * What the last failed attempt at this task said, if there was one. Only a
 * record written for *this* task counts — the store falls back to the
 * feature-wide file, and another task's failure must not brief this one.
 */
async function readAttemptFeedback(
  state: WorkspaceState,
  feature: string,
  taskId: string,
  repositoryFiles: readonly string[],
): Promise<Result<AttemptFeedback | undefined>> {
  const verification = await state.store.readVerification(feature, taskId);
  if (!verification.ok) return verification;
  const review = await state.store.readReview(feature, taskId);
  if (!review.ok) return review;

  const failed = [
    ...(isTaskFailure(verification.value, taskId) ? [verification.value] : []),
    ...(isTaskFailure(review.value, taskId) ? [review.value] : []),
  ].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

  // Verify and review answer different questions; the newest is the one the
  // next attempt has to fix.
  const record = failed.at(-1);
  if (!record) return ok(undefined);

  const failingCommands =
    record.kind === "verification"
      ? record.commands
          .filter((entry) => !entry.passed)
          .map((entry) => ({
            command: entry.command,
            exitCode: entry.exitCode,
            output: (entry.output ?? "").slice(0, FAILURE_OUTPUT_CAP),
          }))
      : [];

  const unresolvedFindings = record.findings.filter((finding) => finding.severity !== "info");

  const recordFiles = record.kind === "verification" ? record.changedFiles : record.reviewedFiles;
  const known = [...new Set([...recordFiles, ...repositoryFiles])];
  const referencedFiles = [
    ...new Set([
      ...extractFailurePaths(
        failingCommands.map((entry) => entry.output),
        known,
      ),
      // A finding that names a path has already done the resolution.
      ...unresolvedFindings.flatMap((finding) => (finding.path ? [finding.path] : [])),
    ]),
  ];

  return ok({
    source: record.kind === "verification" ? "verification" : "review",
    capturedAt: record.createdAt,
    ...(record.kind === "verification" && record.attempt !== undefined
      ? { attempt: record.attempt }
      : {}),
    failingCommands,
    unresolvedFindings,
    referencedFiles,
  });
}

function isTaskFailure<T extends { task?: string; passed: boolean }>(
  record: T | undefined,
  taskId: string,
): record is T {
  if (record === undefined || record.passed) return false;
  // A record naming another task is that task's failure and must not brief
  // this one. A record naming no task at all was a feature-wide run — the
  // active task is the one being worked, and briefing it beats silence.
  return record.task === undefined || record.task === taskId;
}

/**
 * The files produced by the tasks this one depends on. The dependency edge in
 * the task graph already says "that had to exist before this could start", so
 * its output is the code this task will be calling.
 */
function dependencyOutputs(graph: TaskGraph, task: Task): string[] {
  const byId = new Map(graph.tasks.map((entry) => [entry.id, entry]));

  return [
    ...new Set(
      task.dependsOn.flatMap((id) => {
        const dependency = byId.get(id);
        if (!dependency) return [];
        return dependency.expectedFiles.length > 0
          ? dependency.expectedFiles
          : dependency.allowedFiles;
      }),
    ),
  ];
}

/**
 * Records the hashes of the artifacts this pack was derived from, so a later
 * checkpoint can tell whether the ground moved underneath the work.
 */
async function buildManifest(
  state: WorkspaceState,
  feature: string,
  taskId: string,
  pack: ContextPack,
  graphSnapshotId?: string,
): Promise<Result<ContextManifest>> {
  const sources: ContextManifest["sources"] = [];

  for (const name of [FILE.intent, FILE.spec, FILE.plan, FILE.tasks] as const) {
    const path = state.paths.featureFile(feature, name);
    const text = await state.files.readTextIfExists(path);
    if (!text.ok) return text;
    if (text.value !== undefined) {
      // The same normalisation freshness applies: task-status flips are the
      // loop's own bookkeeping, not drift underneath the pack.
      sources.push({
        path: `${feature}/${name}`,
        hash: sourceHash(`${feature}/${name}`, text.value),
      });
    }
  }

  return ok({
    kind: "context-manifest",
    createdAt: now(),
    feature,
    task: taskId,
    sources,
    contextHash: stableContextHash(pack, graphSnapshotId),
    ...(graphSnapshotId ? { graphSnapshotId } : {}),
  });
}

export { stableContextHash } from "../../../src/workflow/stages/context/digest.js";
