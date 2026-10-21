import type { FileMutation } from "../../core/file-transaction.js";
import { ok, type Result } from "../../core/result.js";
import { laterChanges } from "../../memory/later-changes.js";
import {
  type EarlierFeature,
  notInRequest,
  PROJECT_MEMORY_FILE,
} from "../../memory/project-memory.js";
import { recordRequestHistory } from "../../memory/request-history.js";
import type { WorkspaceState } from "../state.js";
import { reviewerMemoryGate } from "./memory-gate.js";
import { type ReviewerModel, reviewerModel } from "./reviewer-model.js";
import { json } from "./store.js";

/** Every recorded note goes to the reviewer's model, which passes on only what applies. */
async function recallMemories(
  workspace: WorkspaceState,
  model: ReviewerModel,
  earlier: readonly EarlierFeature[],
  request: string,
  rules: readonly string[],
  later: readonly string[],
): Promise<Result<{ memories: string[]; mutation?: FileMutation }>> {
  const history = await recordRequestHistory(workspace, earlier);
  if (!history.ok) return history;
  let memories: string[] = [];
  try {
    memories = await reviewerMemoryGate(model)(
      request,
      notInRequest(request, history.value.notes),
      rules,
      later,
    );
  } catch {
    // Without its model, nothing is selected: every note unfiltered would be noise.
  }
  return ok({
    memories,
    ...(history.value.mutation ? { mutation: history.value.mutation } : {}),
  });
}

export interface FeatureMemory {
  readonly memories: string[];
  readonly laterChanges: string[];
  readonly mutations: FileMutation[];
  readonly reported: { projectMemory?: string[]; projectMemoryLaterChanges?: string[] };
}

/** The decisions a feature carries, and the code changes listed with them, for its `work` replies. */
export function memoryFileMutations(
  workspace: WorkspaceState,
  feature: string,
  memory: { memories: readonly string[]; laterChanges: readonly string[] },
): FileMutation[] {
  if (memory.memories.length === 0) return [];
  const { memories, laterChanges: later } = memory;
  return [
    {
      kind: "write",
      path: workspace.paths.featureFile(feature, PROJECT_MEMORY_FILE),
      content: json({ version: 1, memories, ...(later.length ? { laterChanges: later } : {}) }),
      expectedBefore: { existed: false },
    },
  ];
}

/**
 * Earlier features' requests are recorded and the decisions that constrain this request join
 * it; the feature keeps them for `work` replies. Only a reviewer model VISP launches chooses.
 */
export async function featureMemory(
  workspace: WorkspaceState,
  request: string,
  rules: readonly string[],
): Promise<Result<FeatureMemory>> {
  const none = ok({ memories: [], laterChanges: [], mutations: [], reported: {} });
  // memory.enabled switches off every memory path, the long-term store included.
  if (!workspace.config.memory.enabled) return none;
  const model = workspace.config.memory.recall ? await reviewerModel(workspace) : undefined;
  if (!model) return none;
  const earlier = await earlierFeatures(workspace);
  if (!earlier.ok) return earlier;
  // Code can change after a decision was recorded; the gate, the worker and the reviewer are told.
  const later = await laterChanges(workspace, earlier.value);
  const chosen = await recallMemories(workspace, model, earlier.value, request, rules, later);
  if (!chosen.ok) return chosen;
  const { memories } = chosen.value;
  const mutations: FileMutation[] = chosen.value.mutation ? [chosen.value.mutation] : [];
  // Nothing is listed without a note to weigh against it.
  const listed = memories.length ? later : [];
  return ok({
    memories,
    laterChanges: listed,
    mutations,
    reported: {
      ...(memories.length ? { projectMemory: memories } : {}),
      ...(listed.length ? { projectMemoryLaterChanges: listed } : {}),
    },
  });
}

async function earlierFeatures(workspace: WorkspaceState): Promise<Result<EarlierFeature[]>> {
  const listed = await workspace.store.listFeatures();
  if (!listed.ok) return listed;
  const earlier: EarlierFeature[] = [];
  for (const id of listed.value) {
    const intent = await workspace.store.readIntent(id);
    if (intent.ok && intent.value.sourceBrief)
      earlier.push({
        feature: id,
        goal: intent.value.goal,
        originalRequest: intent.value.sourceBrief,
        createdAt: intent.value.createdAt,
      });
  }
  return ok(earlier);
}
