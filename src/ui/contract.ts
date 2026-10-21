/**
 * The resources `visp ui` serves. The browser app imports these types, so the
 * server and the page cannot disagree about a field without the build failing.
 *
 * Every value here is read from a workflow service or a recorded file. The page
 * formats; it never decides whether something passed.
 */

import type { EvidenceRecord } from "../workflow/product/evidence-record/record-types.js";

export type { EvidenceRecord } from "../workflow/product/evidence-record/record-types.js";

export const UI_CONTRACT_VERSION = 1;

export interface UiMeta {
  readonly contractVersion: typeof UI_CONTRACT_VERSION;
  readonly version: string;
  readonly buildId: string;
  readonly repository: { readonly root: string; readonly name: string };
  readonly activeFeature?: string;
  readonly startedAt: string;
}

export type FeatureLifecycle =
  | "active"
  | "accepted"
  | "historical-complete"
  | "legacy"
  | "unreadable";

export interface SliceCounts {
  readonly total: number;
  readonly closed: number;
  readonly inProgress: number;
}

export interface FeatureSummary {
  readonly id: string;
  readonly goal: string;
  readonly lifecycle: FeatureLifecycle;
  readonly active: boolean;
  readonly updatedAt?: string;
  readonly slices: SliceCounts;
  readonly openFindings: number;
  readonly pendingQuestions: number;
  /** Why the feature could not be read, when `lifecycle` is `legacy` or `unreadable`. */
  readonly problem?: { readonly message: string; readonly recovery?: string };
}

export interface UiOverview {
  readonly features: readonly FeatureSummary[];
}

export type NextAction =
  | "understand"
  | "implement"
  | "fix"
  | "refine"
  | "accept"
  | "complete"
  | "wait";

export interface UiNext {
  readonly action: NextAction;
  readonly objective: string;
  readonly command?: string;
  readonly task?: string;
  readonly mayEdit: boolean;
  readonly completion?: "unresolved-environment" | "unresolved-product" | "handoff";
  readonly recovery?: string;
  readonly evidence: readonly string[];
}

export interface UiOutcome {
  readonly id: string;
  readonly kind: "functional" | "quality" | "experience";
  readonly statement: string;
  readonly priority: "must" | "should" | "could";
  readonly provenance: string;
  readonly behavior: "passed" | "failed" | "unassessed";
  readonly review: "satisfied" | "failed" | "unclear" | "unavailable" | "unassessed";
  readonly requiredReview: boolean;
  readonly satisfied: boolean;
  /** The latest run of each agent check that names this outcome, counted by result. */
  readonly checks: UiEvidenceCount;
  readonly expectations: readonly { readonly id: string; readonly statement: string }[];
}

/** Checks counted by their latest run. A stale run counts as stale, never as passed. */
export interface UiEvidenceCount {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly stale: number;
  readonly notRun: number;
}

export type ExecutionStatus = "passed" | "failed" | "timed-out" | "environment-failed";

/** Who wrote a check: the agent in its brief, or VISP's independent tester (a pinned suite). */
export type CheckSource = "agent" | "tester";

export interface UiExecutionSummary {
  readonly id: string;
  readonly check: string;
  readonly task?: string;
  readonly createdAt: string;
  readonly command: string;
  readonly status: ExecutionStatus;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly source: CheckSource;
  readonly provenance: "supervisor-executed" | "supervisor-reused";
  readonly assertions: "agent-reported" | "runner-observed";
  /** False when the product, the slice contract or the verifier changed after this run. */
  readonly current: boolean;
  /** The most telling line of output: the first failure, else the last non-empty line. */
  readonly headline: string;
  readonly outputBytes: number;
}

export interface UiExecution extends UiExecutionSummary {
  readonly output: string;
  readonly truncated: boolean;
}

export interface UiCheck {
  readonly id: string;
  readonly command: string;
  readonly kind: "command" | "browser-journey";
  readonly outcomes: readonly string[];
  /** The latest run of this check for the slice, if any. */
  readonly latest?: UiExecutionSummary;
}

export interface UiSlice {
  readonly id: string;
  readonly goal: string;
  readonly status: "pending" | "in-progress" | "closed" | "legacy-closed" | "unknown";
  readonly outcomes: readonly string[];
  readonly dependsOn: readonly string[];
  readonly scope: {
    readonly allowed: readonly string[];
    readonly expected: readonly string[];
    readonly forbidden: readonly string[];
  };
  readonly approach: string;
  readonly checks: readonly UiCheck[];
}

export type Judgment = "satisfied" | "failed" | "unclear" | "unavailable" | "not-applicable";

export interface UiFinding {
  readonly id: string;
  readonly dimension: string;
  readonly problem: string;
  readonly nextCheck: string;
  readonly required: boolean;
  readonly outcomes: readonly string[];
  readonly evidence: readonly string[];
  readonly task?: string;
  readonly repeats: number;
  readonly phase: "understanding" | "product";
}

export interface UiReview {
  readonly createdAt: string;
  readonly task?: string;
  readonly reviewer?: { readonly model?: string; readonly context: string };
  readonly summary?: string;
  readonly limitations: readonly string[];
  readonly dimensions: readonly {
    readonly dimension: string;
    readonly status: Judgment;
    readonly reason: string;
  }[];
  readonly findings: number;
  readonly resolutions: readonly {
    readonly id: string;
    readonly disposition: "repaired" | "disproved" | "still-open" | "not-reproducible";
    readonly explanation: string;
  }[];
}

export interface UiQuestion {
  readonly id: string;
  readonly task?: string;
  readonly question: string;
  readonly context?: string;
  readonly createdAt: string;
  readonly status: "pending" | "answered" | "deferred";
  readonly reply?: string;
  readonly respondedAt?: string;
  readonly provenance: "caller-reported" | "host-elicited";
}

export type ActivityKind =
  | "created"
  | "slice"
  | "execution"
  | "review"
  | "revision"
  | "question"
  | "answer";

export interface UiActivity {
  readonly at: string;
  readonly kind: ActivityKind;
  readonly title: string;
  readonly detail?: string;
  readonly tone: "neutral" | "good" | "bad" | "warn";
  /** An execution the entry links to, when there is one. */
  readonly execution?: string;
}

export interface UiCapture {
  readonly path: string;
  readonly name: string;
  readonly modifiedAt: string;
}

export interface UiFeature {
  readonly id: string;
  readonly goal: string;
  readonly originalRequest: string;
  readonly lifecycle: FeatureLifecycle;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly subjectDigest?: string;
  readonly next: UiNext;
  readonly outcomes: readonly UiOutcome[];
  readonly slices: readonly UiSlice[];
  readonly findings: readonly UiFinding[];
  readonly reviews: readonly UiReview[];
  readonly questions: readonly UiQuestion[];
  readonly executions: readonly UiExecutionSummary[];
  readonly activity: readonly UiActivity[];
  readonly captures: readonly UiCapture[];
  readonly decisions: readonly { readonly id: string; readonly statement: string }[];
  readonly uncertainties: readonly string[];
  readonly report: string;
  readonly tester: UiTester;
  /** When the server read this state. The product can change after it. */
  readonly readAt: string;
}

/**
 * VISP's independent tester: it writes an acceptance suite from the original request
 * alone, which is pinned so the agent cannot edit it. It covers the whole request,
 * not one outcome.
 */
export interface UiTester {
  readonly status:
    | "none"
    | "running"
    | "pinned"
    | "rejected"
    | "failed"
    | "declined"
    | "unreadable";
  readonly model?: string;
  /** Tests the suite declares. */
  readonly tests: number;
  readonly ambiguities: number;
  readonly at?: string;
  readonly reason?: string;
  /** The newest run of the pinned suite, current or not. */
  readonly latest?: UiExecutionSummary;
}

export type RequestKind = "question" | "handoff" | "acceptance" | "environment" | "review";

export interface UiRequest {
  readonly id: string;
  readonly kind: RequestKind;
  readonly feature: string;
  readonly featureGoal: string;
  readonly title: string;
  readonly detail: string;
  readonly createdAt?: string;
  /** A command the person can run to act on this request; the page never runs it. */
  readonly command?: string;
  readonly question?: UiQuestion;
  /** For a question: the command that records an answer, before the quoted answer. */
  readonly replyCommand?: string;
}

export interface UiRequests {
  readonly requests: readonly UiRequest[];
}

export interface UiHealthCheck {
  readonly name: string;
  readonly status: string;
  readonly detail: string;
  readonly recovery?: string;
}

export interface UiHealth {
  readonly verdict: string;
  readonly checks: readonly UiHealthCheck[];
}

/** One hunk of the feature's diff, with its lines as `git diff` prints them (` `, `+`, `-`). */
export interface UiMapHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly header: string;
  readonly lines: readonly string[];
  /** Lines left out of `lines` at the shown-lines limit. */
  readonly omittedLines: number;
}

export interface UiMapFile {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted";
  readonly added: number;
  readonly removed: number;
  readonly binary: boolean;
  readonly hunks: readonly UiMapHunk[];
}

/** Why a slice is linked to a change: its scope names the file, or its checkpoint saw it change. */
export interface UiMapSliceLink {
  readonly id: string;
  readonly via: "scope" | "checkpoint";
}

export interface UiMapCheckLink {
  readonly id: string;
  /** `declared`: the check's files name the path; `test-command`: it runs a test the graph links. */
  readonly via: "declared" | "test-command";
  readonly status: ExecutionStatus | "not-run";
  /** False when the latest run is out of date; it then never counts as a pass. */
  readonly current: boolean;
  readonly execution?: string;
}

export interface UiMapFindingLink {
  readonly id: string;
  readonly required: boolean;
  readonly problem: string;
  /**
   * The finding's text names this file, a line inside this node, or this declaration as a call
   * (`name(`). A text match, not a record.
   */
  readonly via: "names-file" | "names-line" | "names-symbol";
}

export type UiMapRole = "changed" | "caller" | "callee" | "test";

export interface UiMapNode {
  /** The graph entity id; a file is `<path>#file`, as in the index, even when the index lacks it. */
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly kind: string;
  readonly role: UiMapRole;
  /** Hops from the nearest changed node; 0 for changed nodes. */
  readonly distance: number;
  readonly startLine?: number;
  readonly endLine?: number;
  /** The directory the page groups the node under. */
  readonly module: string;
  /** For changed nodes: which hunks of the file fall inside, and the lines they add and remove. */
  readonly change?: {
    readonly hunks: readonly number[];
    readonly added: number;
    readonly removed: number;
    /** Digest of those hunks, so a reviewed tick can tell when the code changed after it. */
    readonly digest: string;
  };
  readonly slices: readonly UiMapSliceLink[];
  readonly outcomes: readonly string[];
  readonly checks: readonly UiMapCheckLink[];
  readonly findings: readonly UiMapFindingLink[];
  /** Changed, with no test in the graph and no check covering it. */
  readonly untested: boolean;
  /** Unresolved calls elsewhere whose text ends with this name, as `path: call text`. */
  readonly unseenCallers: readonly string[];
  readonly dynamicImports: number;
  /** The file changed after the index was built, so the line range may be off. */
  readonly indexBehind: boolean;
  /** Changed after the last slice checkpoint recorded it. */
  readonly afterCheckpoints: boolean;
  /** False for changed nodes past the node cap: listed in the reading order, not drawn. */
  readonly drawn: boolean;
}

export interface UiMapEdge {
  readonly source: string;
  readonly target: string;
  readonly kind: "calls" | "tested_by" | "possible-call";
  /** True only for relations the index resolved. Everything else is drawn dashed. */
  readonly resolved: boolean;
  /** Where the relation is written, as `path:line`, when known. */
  readonly at?: string;
}

export interface UiMapSlice {
  readonly id: string;
  readonly goal: string;
  readonly status: UiSlice["status"];
  readonly outcomes: readonly string[];
  readonly checkpoint: boolean;
}

export interface UiChangeMap {
  readonly feature: string;
  readonly base: {
    readonly ref: string;
    readonly commit?: string;
    readonly how: "explicit" | "feature-start" | "head" | "empty-tree";
  };
  readonly end: { readonly how: "working-tree" | "feature-end"; readonly commit?: string };
  readonly graph: {
    readonly state: "current" | "divergent" | "unverified" | "missing";
    readonly note?: string;
  };
  readonly files: readonly UiMapFile[];
  readonly nodes: readonly UiMapNode[];
  readonly edges: readonly UiMapEdge[];
  /** Changed node ids in the suggested reading order, including ones not drawn. */
  readonly readingOrder: readonly string[];
  readonly slices: readonly UiMapSlice[];
  readonly omitted: {
    /** Changed nodes not drawn at the node cap; they stay in the reading order. */
    readonly changedNodes: number;
    readonly neighbours: number;
    readonly files: number;
    /** Changed files left out as VISP state, secrets or blocked paths. */
    readonly hiddenFiles: number;
  };
  readonly notes: readonly string[];
  readonly readAt: string;
}

/** The server's live-update message. The page re-fetches what it names. */
export interface UiChange {
  readonly revision: number;
  readonly features: readonly string[];
}

export interface UiError {
  readonly code: string;
  readonly message: string;
  readonly recovery?: string;
}

/** The envelope every `--json` command prints, reused for every resource. */
export interface UiEnvelope<T> {
  readonly command: string;
  readonly ok: boolean;
  readonly data?: T;
  readonly error?: UiError;
}

/** The Evidence tab: the record `visp pr` prints, as data and as the Markdown it prints. */
export interface UiEvidence {
  readonly record: EvidenceRecord;
  readonly markdown: string;
}
