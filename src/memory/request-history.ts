import { z } from "zod";
import { type FileMutation, filePrecondition } from "../core/file-transaction.js";
import { ok, type Result } from "../core/result.js";
import type { WorkspaceState } from "../workflow/state.js";
import { type EarlierFeature, requestChunks } from "./project-memory.js";

/**
 * VISP's own long-term store: what users asked for in earlier features, split as Visp Memory
 * recorded it. Given every recorded note, the reviewer's model chose the decisions a new
 * request needed (18 of 18 and 21 of 21 across three stores), where Visp Memory's keyword
 * selection, which the model's candidates came from, fell short alone (15 and 17). At these
 * sizes every note fits in one call, so VISP keeps the notes itself and needs no service.
 */
const REQUEST_HISTORY_STATE = "state/request-history.json";
/** The newest notes the gate reads; older ones are left out. */
const MAX_CANDIDATE_CHARS = 40_000;

const historySchema = z.object({
  version: z.literal(1),
  requests: z.array(
    z.object({ feature: z.string(), goal: z.string(), notes: z.array(z.string()) }),
  ),
});
type History = z.infer<typeof historySchema>;

/**
 * Records the requests of earlier features not yet recorded, in the order given, and returns
 * every recorded note, oldest first, with the state update the caller commits with the feature.
 */
export async function recordRequestHistory(
  workspace: WorkspaceState,
  earlier: readonly EarlierFeature[],
): Promise<Result<{ notes: string[]; mutation?: FileMutation }>> {
  const path = workspace.paths.stateFile(REQUEST_HISTORY_STATE);
  const before = await workspace.files.readTextIfExists(path);
  if (!before.ok) return before;
  const history = parseHistory(before.value);
  const recorded = new Set(history.requests.map((request) => request.feature));
  const added = earlier
    .filter((feature) => !recorded.has(feature.feature))
    .map((feature) => ({
      feature: feature.feature,
      goal: feature.goal,
      notes: requestChunks(feature.originalRequest),
    }));
  const requests = [...history.requests, ...added];
  const notes = newestWithin(requests.flatMap((request) => request.notes));
  if (added.length === 0) return ok({ notes });
  return ok({
    notes,
    mutation: {
      kind: "write",
      path,
      content: `${JSON.stringify({ version: 1, requests }, null, 2)}\n`,
      expectedBefore: filePrecondition(before.value),
    },
  });
}

/** Drops the oldest notes once all of them would not fit the gate's reading. */
function newestWithin(notes: readonly string[]): string[] {
  let total = 0;
  let first = notes.length;
  while (first > 0 && total + (notes[first - 1]?.length ?? 0) <= MAX_CANDIDATE_CHARS) {
    first -= 1;
    total += notes[first]?.length ?? 0;
  }
  return notes.slice(first);
}

function parseHistory(text: string | undefined): History {
  if (!text) return { version: 1, requests: [] };
  try {
    const parsed = historySchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : { version: 1, requests: [] };
  } catch {
    return { version: 1, requests: [] };
  }
}
