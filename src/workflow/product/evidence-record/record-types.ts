/**
 * The evidence record `visp pr` prints and `visp ui` shows. Tools read it from
 * `visp pr --json` (`value.record`). It is built from recorded state only: a result says
 * `passed` only for a run VISP executed on the current version of the product, and a
 * reviewer's verdict is always labelled as a model's judgment.
 *
 * This file has no imports so the dashboard page can share it.
 */
export interface EvidenceRecord {
  readonly version: 1;
  readonly feature: string;
  readonly lifecycle: "active" | "accepted" | "historical-complete";
  /** The product version every `current` result below was checked against. */
  readonly subjectDigest: string;
  readonly summary: EvidenceSummary;
  /** Everything a reviewer must not assume is proven, most serious first. */
  readonly notVerified: readonly EvidenceGap[];
  readonly asked: EvidenceAsked;
  /** One entry per requirement, in the brief's order. */
  readonly done: readonly RequirementEvidence[];
  /** Checks no requirement names, such as the independent tester's suite for the whole request. */
  readonly suites: readonly CheckEvidence[];
  readonly changed: EvidenceChanges;
  readonly regressions: EvidenceRegressions;
  readonly cost: EvidenceCost;
  readonly outsideAccess: EvidenceOutsideAccess;
  readonly next: { readonly objective: string; readonly command?: string };
  readonly readAt: string;
}

export interface EvidenceSummary {
  readonly requirements: number;
  /** Shown by a passing check VISP ran on the current version. */
  readonly verified: number;
  /** Satisfied only by a reviewer's judgment, with no executed check behind it. */
  readonly judged: number;
  readonly failed: number;
  readonly unverified: number;
  readonly gaps: number;
}

export interface EvidenceAsked {
  /** The request as recorded at `visp feature`, with credentials and local paths masked. */
  readonly request: string;
  readonly requirements: readonly EvidenceRequirement[];
  /** Changes to the protected intent after the request was recorded. */
  readonly intentChanges: readonly {
    readonly at: string;
    readonly provenance: string;
    readonly reason: string;
  }[];
}

export interface EvidenceRequirement {
  readonly id: string;
  readonly statement: string;
  readonly priority: string;
  readonly kind: string;
  readonly provenance: string;
}

/**
 * - `passed`, `failed`, `timed-out`, `environment-failed`: the latest run on the current version.
 * - `stale`: it ran, but only on an earlier version of the product, check or slice.
 * - `not-run`: no run is recorded.
 */
export type EvidenceResult =
  | "passed"
  | "failed"
  | "timed-out"
  | "environment-failed"
  | "stale"
  | "not-run";

export interface CheckEvidence {
  readonly check: string;
  /** Who wrote the assertions: the worker, or VISP's independent tester from the request. */
  readonly author: "worker" | "independent-tester";
  readonly result: EvidenceResult;
  /** False for checks that only inspect source or syntax; they never prove behaviour. */
  readonly exercisesBehavior: boolean;
  /** False when the check also passes with the feature's change reverted. */
  readonly failsWithoutChange?: boolean;
  /** When the run behind `result` happened; for `stale`, the last run on any version. */
  readonly ranAt?: string;
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly execution?: string;
  /** The check's own command, to rerun by hand. */
  readonly command: string;
  /** The VISP command that runs it again and records the result. */
  readonly record: string;
}

export interface RequirementEvidence {
  readonly requirement: string;
  /**
   * - `verified`: a passing check on the current version shows it (and any required review agrees).
   * - `judged`: satisfied by a reviewer's judgment alone.
   * - `failed`: a current check failed or the reviewer judged it failed.
   * - `unverified`: anything else.
   */
  readonly status: "verified" | "judged" | "failed" | "unverified";
  readonly checks: readonly CheckEvidence[];
  readonly review: {
    readonly status: "satisfied" | "failed" | "unclear" | "unavailable" | "unassessed";
    /** A model's judgment, never an executed result. */
    readonly source: "model-judgment";
    readonly reviewer?: string;
    readonly required: boolean;
  };
}

export type EvidenceGapKind =
  | "requirement"
  | "check"
  | "regression"
  | "finding"
  | "dispute"
  | "independent-tests"
  | "not-observed"
  | "flaky"
  | "out-of-scope"
  | "review";

export interface EvidenceGap {
  readonly kind: EvidenceGapKind;
  /** `blocking`: a required requirement, failing evidence, a required finding or a regression. */
  readonly severity: "blocking" | "attention";
  /** The requirement, check, finding, test or path it is about. */
  readonly ref?: string;
  readonly text: string;
}

export interface EvidenceChanges {
  /** False when git could not produce the diff; `note` says why. */
  readonly available: boolean;
  readonly note?: string;
  readonly base?: { readonly ref: string; readonly how: string };
  readonly end: "working-tree" | "feature-end";
  readonly files: readonly EvidenceFile[];
  readonly totals: { readonly files: number; readonly added: number; readonly removed: number };
  readonly omittedFiles: number;
  readonly hiddenFiles: number;
  readonly scope: {
    readonly declared: readonly {
      readonly slice: string;
      readonly allowed: readonly string[];
      readonly forbidden: readonly string[];
    }[];
    /** Files the feature changed that no slice's scope allows. */
    readonly outside: readonly string[];
    /** Recorded exceptions to VISP's rules that cover this feature. */
    readonly overrides: readonly { readonly rule: string; readonly reason: string }[];
    /** Edits the hooks refused are not recorded yet. */
    readonly refusedEdits: { readonly recorded: false };
  };
}

export interface EvidenceFile {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted";
  readonly added: number;
  readonly removed: number;
  readonly binary: boolean;
  /** Slices whose scope allows the file. */
  readonly slices: readonly string[];
  /**
   * - `feature`: changed by this feature's work.
   * - `earlier-work`: uncommitted before the feature started and unchanged since.
   * - `independent-tests`: the tests VISP's tester wrote and pinned.
   */
  readonly origin: "feature" | "earlier-work" | "independent-tests";
}

export interface EvidenceRegressions {
  readonly mode: "off" | "advise" | "gate";
  /** `stale`: the last gate ran on an earlier version; `not-run`: no gate result is recorded. */
  readonly status: "clear" | "regression" | "unchecked" | "stale" | "not-run";
  readonly commands?: number;
  readonly selection?: {
    readonly linked: number;
    readonly earlierWork: number;
    readonly unlinked: number;
  };
  readonly regressions: readonly string[];
  readonly unchecked: readonly string[];
  readonly preExisting: number;
  readonly leftOut: number;
  readonly durationMs?: number;
}

export interface EvidenceCost {
  readonly startedAt: string;
  readonly lastRecordAt: string;
  /** From `visp feature` to the feature's latest record. */
  readonly elapsedMs: number;
  readonly checkRuns: number;
  /** Time VISP spent running checks, including old-code comparisons. */
  readonly checkTimeMs: number;
  readonly regressionGateMs?: number;
  readonly modelCalls: {
    /** Reviewer calls VISP launched itself, including ones that failed. */
    readonly reviewerLaunched: number;
    /** Independent reviews recorded, whoever launched them. */
    readonly reviewsRecorded: number;
    readonly testerSessions: number;
    /** The worker's own calls are not measured by VISP. */
    readonly worker: null;
  };
  readonly models: readonly string[];
}

/** What VISP's reviewer and tester reached outside the repository, from their activity logs. */
export interface EvidenceOutsideAccess {
  readonly webSearches: readonly { readonly at: string; readonly query: string }[];
  /** Commands the execution-mode tester ran with network access; `visp pr --full` lists them. */
  readonly testerNetworkCommands: number;
}
