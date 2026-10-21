import { ok, type Result } from "../../core/result.js";
import { checkCurrency, openProjectStore } from "../../graph/index.js";
import { getQueryIndex, type SnapshotIndex } from "../../graph/query/index.js";
import { readFeatureDiff, uiFile } from "../../workflow/product/feature-diff.js";
import { readProductRecord } from "../../workflow/product/store.js";
import type { WorkspaceState } from "../../workflow/state.js";
import type { UiChangeMap, UiFeature, UiMapNode } from "../contract.js";
import { featureView } from "../views.js";
import { checkpointHistory } from "./checkpoints.js";
import { egoGraph, NODE_CAP } from "./graph.js";
import { annotate, readingOrder } from "./records.js";

/**
 * The feature's diff as a small graph with VISP's records on each node. It reads git, the
 * graph index and the product record; it writes nothing and never refreshes the index.
 */
export async function changeMapView(
  state: WorkspaceState,
  feature: string,
  explicitBase?: string,
): Promise<Result<UiChangeMap>> {
  const record = await readProductRecord(state, { feature });
  if (!record.ok) return record;
  const view = await featureView(state, feature);
  if (!view.ok) return view;
  const read = await readFeatureDiff(state, feature, explicitBase);
  if (!read.ok) return read;
  const { base, end, diff } = read.value;
  const root = state.paths.root;
  const notes = [...diff.notes];
  const graph = await readIndex(state);
  if (graph.note) notes.push(graph.note);
  const ego = egoGraph(graph.index, diff.files);
  const history = await checkpointHistory(
    state,
    record.value,
    diff.files.map((file) => file.path),
    base,
    end,
  );
  notes.push(...history.notes);
  const nodes: UiMapNode[] = ego.nodes.map((node) =>
    annotate(node, {
      record: record.value,
      view: view.value,
      index: graph.index,
      root,
      history: history.files,
      behind: graph.behind,
    }),
  );
  if (ego.omittedChanged > 0)
    notes.push(
      `${ego.omittedChanged} changed declarations are past the ${NODE_CAP}-node drawing limit; they are in the reading order.`,
    );
  return ok({
    feature,
    base: base,
    end: end,
    graph: { state: graph.state, ...(graph.note ? { note: graph.note } : {}) },
    files: diff.files.map(uiFile),
    nodes,
    edges: ego.edges,
    readingOrder: readingOrder(
      nodes,
      ego.edges,
      view.value.slices.map((slice) => slice.id),
    ),
    slices: slicesView(view.value, history.checkpointed),
    omitted: {
      changedNodes: ego.omittedChanged,
      neighbours: ego.omittedNeighbours,
      files: diff.omittedFiles,
      hiddenFiles: diff.hiddenFiles,
    },
    notes,
    readAt: new Date().toISOString(),
  });
}

interface IndexRead {
  readonly index?: SnapshotIndex;
  readonly state: UiChangeMap["graph"]["state"];
  readonly note?: string;
  /** Files changed since the index was built. */
  readonly behind: ReadonlySet<string>;
}

async function readIndex(state: WorkspaceState): Promise<IndexRead> {
  const missing = (note: string): IndexRead => ({ state: "missing", note, behind: new Set() });
  const exists = await state.files.exists(state.paths.graphStore);
  if (!exists.ok || !exists.value)
    return missing(
      "No graph index, so changed files are shown without callers or tests. Run visp index.",
    );
  const store = await openProjectStore(state.files, state.paths.graphStore, { writable: false });
  if (!store.ok) return missing(`The graph index could not be opened: ${store.error.message}`);
  try {
    const index = getQueryIndex(store.value);
    if (!index.ok) return missing(`${index.error.message}. Run visp index.`);
    const snapshot = index.value.snapshot;
    if (snapshot.root !== state.paths.root)
      return missing("The graph index belongs to another checkout. Run visp index --refresh.");
    const currency = await checkCurrency(state.paths.root, snapshot, state.config.graph);
    if (!currency.ok)
      return {
        index: index.value,
        state: "unverified",
        note: currency.error.message,
        behind: new Set(),
      };
    const report = currency.value;
    const behind = new Set([...report.added, ...report.changed, ...report.deleted]);
    if (report.state === "current") return { index: index.value, state: "current", behind };
    const count = report.counts.added + report.counts.changed + report.counts.deleted;
    return {
      index: index.value,
      state: report.state,
      note:
        report.state === "divergent"
          ? `The graph index is older than ${count} file${count === 1 ? "" : "s"}${report.listsTruncated ? " (not all listed)" : ""}; their callers, tests and line ranges may be out of date. Run visp index --refresh.`
          : (report.reason ?? "Whether the graph index is current could not be checked."),
      behind,
    };
  } finally {
    store.value.close();
  }
}

function slicesView(view: UiFeature, checkpointed: ReadonlySet<string>): UiChangeMap["slices"] {
  return view.slices.map((slice) => ({
    id: slice.id,
    goal: slice.goal,
    status: slice.status,
    outcomes: slice.outcomes,
    checkpoint: checkpointed.has(slice.id),
  }));
}
