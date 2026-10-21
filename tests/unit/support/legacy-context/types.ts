/** Historical context-builder options, kept only for the fixture builder. */
import type {
  ContextManifest,
  ContextPack,
  ContextRegion,
} from "../../../../src/workflow/artifacts/context.js";

/** Structural facts supplied by the graph, when one has been built. */
export interface GraphFacts {
  /** Exact published graph this reading plan was derived from. */
  readonly snapshotId: string;
  readonly repositoryFiles: readonly string[];
  readonly neighbours: readonly { path: string; hops: number }[];
  readonly tests: readonly string[];
  readonly entrypoints: readonly string[];
  /** The entity spans worth reading in each candidate file, when the graph knows them. */
  readonly regionsByPath: Readonly<Record<string, readonly ContextRegion[]>>;
  readonly unknowns: readonly string[];
  /** Distinct entrypoint kinds the index found, for skills that trigger on them. */
  readonly entrypointKinds: readonly string[];
  /** Languages the index actually parsed, which is not the same as those configured. */
  readonly languages: readonly string[];
}

export interface ContextOptions {
  readonly feature: string;
  readonly taskId: string;
  readonly graph?: GraphFacts;
  /** Fallback file list when no graph exists yet. */
  readonly repositoryFiles?: readonly string[];
  /**
   * The bridge's staleness report, when the index trails the worktree. Written
   * into the pack so the agent reading the JSON sees it — a warning that only
   * ever reached the terminal reached nobody in six real runs.
   */
  readonly staleIndex?: string;
  /** The missing graph is intentional because no indexable project source exists yet. */
  readonly graphDeferred?: boolean;
}

export interface ContextOutcome {
  readonly pack: ContextPack;
  readonly manifest: ContextManifest;
  readonly path: string;
}
