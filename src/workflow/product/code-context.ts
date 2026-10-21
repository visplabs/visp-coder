import { isUtf8 } from "node:buffer";
import { sha256 } from "../../core/hash.js";
import { matchesAny } from "../../core/patterns.js";
import { privatePath } from "../../core/redaction.js";
import { ok } from "../../core/result.js";
import { isApplicationSource } from "../../graph/coverage-notes.js";
import { isIndexableProjectPath } from "../../graph/paths.js";
import type { WorkspaceState } from "../state.js";
import { productBehaviorProbes } from "./behavior-probes.js";
import { pinnedAcceptanceChecks } from "./check/acceptance-checks.js";
import { isBrowserCheckCommand } from "./check/check-command.js";
import { type CoreReviewPaths, coreReviewPaths } from "./core-review-sources.js";
import {
  latestExecutionsByOwner,
  type ProductCheck,
  type ProductExecution,
  type ProductSlice,
} from "./model.js";
import { reviewCheckPaths, reviewCheckResult } from "./review/review-check-context.js";
import { reviewDiffSource } from "./review/review-diff.js";
import { reviewExcerpt } from "./review/review-excerpts.js";
import { readProductAuthorizationBaseline } from "./scopes.js";
import { BROAD_SCOPE_SOURCE_ID, type ProductSource } from "./sources.js";
import type { ProductRecord } from "./store.js";
import { productSourceChanges, productSourceDigest, productSourceSnapshot } from "./subject.js";
import { unobservedGoalRounds } from "./unobserved-goals.js";

/**
 * Paths added, modified or deleted since the retained authorization baseline (including
 * metadata/binary changes), before delivery filters. Closed-slice and whole-feature reviews
 * use the same read-only baseline; a selected slice must own it. This grants no edit authority.
 */
export async function reviewChangedPaths(
  workspace: WorkspaceState,
  record: ProductRecord,
  snapshot: Record<string, string>,
  slice?: ProductSlice,
) {
  const authorization = await readProductAuthorizationBaseline(workspace, record);
  if (!authorization.ok) return authorization;
  if (!authorization.value || (slice && authorization.value.task !== slice.id))
    return ok(new Set<string>());
  const changes = await productSourceChanges(workspace, authorization.value.baseline, snapshot);
  return changes.ok ? ok(new Set(changes.value)) : changes;
}

export async function reviewCodeSources(
  workspace: WorkspaceState,
  record: ProductRecord,
  sourceSnapshot?: Record<string, string>,
  subject?: string,
  slice?: ProductSlice,
  changedPaths: ReadonlySet<string> = new Set(),
) {
  const snapshot =
    sourceSnapshot === undefined
      ? await productSourceSnapshot(workspace, record.brief)
      : ({ ok: true, value: sourceSnapshot } as const);
  if (!snapshot.ok)
    return [
      {
        id: "CODE-UNAVAILABLE",
        kind: "implementation-file" as const,
        reference: "Current implementation",
        sha256: "",
        available: false,
        excerpt: snapshot.error.message,
      },
    ];
  const readSource = reviewSourceReader(workspace);
  const { candidates, declarations, broad } = await sourceCandidates(
    workspace,
    record,
    snapshot.value,
    subject,
    slice,
    changedPaths,
    readSource,
  );
  const question = reviewQuestion(record);
  const spentGoals = subject ? unobservedGoalRounds(record, subject).spent : [];
  const diff = await reviewDiffSource(workspace, record, changedPaths, slice);
  const sources: ProductSource[] = diff ? [diff] : [];
  if (broad) sources.push(broadScopeSource(broad, candidates));
  let remaining = 31000; // Reserve space within the existing 32k budget for cutoff disclosures.
  const core = candidates.filter((candidate) => candidate.coreOutcomes !== undefined);
  const secondary = candidates.filter((candidate) => candidate.coreOutcomes === undefined);
  const results = secondary.filter((candidate) => candidate.execution);
  const files = secondary.filter((candidate) => !candidate.execution);
  const selected = [...core, ...results, ...files.slice(0, 8)];
  for (const [index, candidate] of selected.entries()) {
    const limit = Math.max(0, Math.min(6000, Math.floor(remaining / (selected.length - index))));
    const source = await readReviewSource(
      readSource,
      candidate,
      snapshot.value,
      declarations,
      question,
      limit,
      spentGoals,
    );
    remaining -= source.excerpt.length;
    sources.push(source);
  }
  if (candidates.length > selected.length) {
    const omitted = files.slice(8);
    sources.push({
      id: "CODE-OMITTED",
      kind: "implementation-file",
      reference: "Additional review evidence",
      sha256: "",
      available: false,
      excerpt:
        `Review packet cutoff: ${[...new Set(candidates.map((entry) => entry.category))].map((category) => `${omitted.filter((candidate) => candidate.category === category).length} ${category}`).join(", ")} entries omitted. Inspect before judging them. First omitted: ${omitted
          .slice(0, 8)
          .map((entry) => entry.path ?? entry.execution?.id)
          .join(", ")}`.slice(0, 1000),
    });
  }
  return sources;
}

function isReviewablePath(path: string) {
  return (
    !privatePath(path) &&
    (isIndexableProjectPath(path) ||
      (/\.(md|mdx|txt|rst|adoc|json|ya?ml)$/i.test(path) &&
        !/^\.(visp|agents|claude|codex|cursor)\//.test(path)))
  );
}

/** Dependency discovery and excerpts share one observation, never cached across reviews. */
/**
 * Review sources are verified later by hashing their bytes, so text is read only from bytes that
 * are valid UTF-8 (decoding keeps them identical). Other files (Latin-1 fixtures, binaries) are
 * delivered as unavailable instead of being hashed as replacement-character text that never
 * matches the file and makes every review fail as "source changed".
 */
function reviewSourceReader(workspace: WorkspaceState) {
  const reads = new Map<string, ReturnType<WorkspaceState["files"]["readTextIfExists"]>>();
  return (path: string): ReturnType<WorkspaceState["files"]["readTextIfExists"]> => {
    const cached = reads.get(path);
    if (cached) return cached;
    const read = workspace.files.readBytesIfExists(path).then((bytes) => {
      if (!bytes.ok) return bytes;
      const value = bytes.value;
      return ok(value && isUtf8(value) ? Buffer.from(value).toString("utf8") : undefined);
    });
    reads.set(path, read);
    return read;
  };
}

/** A named file or a requested class of documents; scope keeps unrelated project docs out. */
function requestedDocument(path: string, request: string): number {
  if (!/\.(md|mdx|txt|rst|adoc|json|ya?ml)$/i.test(path)) return 0;
  const lower = request.toLowerCase();
  const name = path.split("/").at(-1)?.toLowerCase() ?? path;
  const named: string[] = lower.match(/[\w./-]+\.(?:md|mdx|txt|rst|adoc|json|ya?ml)\b/g) ?? [];
  if (named.includes(path.toLowerCase())) return 3;
  const generic = request.replace(/[\w./-]+\.(?:md|mdx|txt|rst|adoc|json|ya?ml)\b/gi, "");
  if (named.includes(name)) return 2;
  if (/^readme(?:\.|$)/i.test(name) && /\breadme\b/i.test(generic)) return 1;
  return Number(
    (/\b(?:docs|documentation)\b/i.test(generic) && /^(?:docs?|documentation)\//i.test(path)) ||
      (/\bcontract\b/i.test(generic) && /contract/i.test(name)),
  );
}

interface SourceCandidate {
  path?: string;
  execution?: ProductExecution;
  category: string;
  sourceUnresolved?: boolean;
  coreOutcomes?: string[];
}

async function sourceCandidates(
  workspace: WorkspaceState,
  record: ProductRecord,
  snapshot: Record<string, string>,
  subject?: string,
  slice?: ProductSlice,
  changedPaths: ReadonlySet<string> = new Set(),
  readSource = workspace.files.readTextIfExists.bind(workspace.files),
) {
  const scope = (slice ? [slice] : record.brief.slices).flatMap((entry) => entry.scope.allowed);
  const { applicableExecutions } = await import("./assessment.js");
  const digest =
    subject === undefined
      ? await productSourceDigest(workspace, record.brief, snapshot)
      : { ok: true as const, value: subject };
  const executions = digest.ok
    ? latestExecutionsByOwner(applicableExecutions(record, digest.value, slice))
    : [];
  const declarations = [...record.brief.checks, ...pinnedAcceptanceChecks(record.brief)];
  const executedChecks = declarations.filter((check) =>
    executions.some((execution) => execution.check === check.id),
  );
  const checkPaths = await Promise.all(
    declarations.map(async (check) => ({
      check,
      paths: await reviewCheckPaths(workspace, [check], snapshot),
      observedPaths: await reviewCheckPaths(
        workspace,
        [{ ...check, files: [], verifierFiles: [] }],
        snapshot,
      ),
    })),
  );
  const { core, broad } = await coreReviewPaths(
    workspace,
    record,
    snapshot,
    checkPaths.map(({ check, observedPaths }) => ({ check, paths: observedPaths })),
    slice,
    changedPaths,
    readSource,
  );
  const unresolvedChecks = new Set(
    checkPaths
      .filter(({ check, paths }) => !paths.length && !isBrowserCheckCommand(check.command))
      .map(({ check }) => check.id),
  );
  const checks = checkPaths
    .filter(({ check }) => executedChecks.includes(check))
    .flatMap(({ paths }) => paths);
  // Preserve declared check inputs in read-only packets before a check has run as well.
  checks.push(
    ...Object.keys(snapshot).filter(
      (path) =>
        matchesAny(
          path,
          record.brief.checks.flatMap((check) => check.files),
        ) && isReviewablePath(path),
    ),
  );
  const documents = requestedDocuments(
    snapshot,
    scope,
    record.brief.originalRequest,
    changedPaths,
    broad !== undefined,
  );
  const requiredOutcomes = record.brief.outcomes
    .filter(
      (outcome) => outcome.priority === "must" && (!slice || slice.outcomes.includes(outcome.id)),
    )
    .map((outcome) => outcome.id);
  addDocumentCore(core, documents, requiredOutcomes, broad !== undefined);
  const classes = [
    {
      name: "executed check results",
      entries: executions.map((execution) => ({
        execution,
        sourceUnresolved: unresolvedChecks.has(execution.check),
      })),
    },
    { name: "verifier/check source", entries: [...new Set(checks)].map((path) => ({ path })) },
    { name: "requested deliverables", entries: documents.map((path) => ({ path })) },
    {
      name: "implementation",
      entries: implementationContext(snapshot, scope, broad).map((path) => ({ path })),
    },
  ];
  const candidates = coreCandidates(core, requiredOutcomes);
  const seen = new Set(core.keys());
  for (let index = 0; classes.some((entry) => entry.entries.length > index); index++)
    for (const category of classes) {
      const entry = category.entries[index];
      if (!entry) continue;
      const key = "path" in entry ? entry.path : entry.execution.id;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ ...entry, category: category.name });
    }
  return { candidates, declarations, broad };
}

/** In-scope application files, or only what the change imports when the scope is too broad. */
function implementationContext(
  snapshot: Record<string, string>,
  scope: string[],
  broad: CoreReviewPaths["broad"],
) {
  if (broad) return [...broad.neighbors];
  return Object.keys(snapshot).filter(
    (path) =>
      (isApplicationSource(path) || /\.(?:css|scss|sass|less)$/i.test(path)) &&
      matchesAny(path, scope),
  );
}

/** With a broad scope the change is the core and documents the request names are context. */
function addDocumentCore(
  core: Map<string, string[]>,
  documents: string[],
  outcomes: string[],
  broad: boolean,
) {
  if (broad) return;
  documents.forEach((path) => {
    core.set(path, outcomes);
  });
}

/** Requested documents in scope; with a broad scope, only changed or explicitly named ones. */
function requestedDocuments(
  snapshot: Record<string, string>,
  scope: string[],
  request: string,
  changedPaths: ReadonlySet<string>,
  broad: boolean,
) {
  return Object.keys(snapshot)
    .filter(
      (path) =>
        matchesAny(path, scope) &&
        isReviewablePath(path) &&
        requestedDocument(path, request) > (broad && !changedPaths.has(path) ? 1 : 0),
    )
    .sort(
      (a, b) =>
        requestedDocument(b, request) - requestedDocument(a, request) ||
        Number(changedPaths.has(b)) - Number(changedPaths.has(a)),
    );
}

/** Disclose that the change, not the whole scope, is the core of this review. */
function broadScopeSource(
  broad: NonNullable<CoreReviewPaths["broad"]>,
  candidates: readonly SourceCandidate[],
): ProductSource {
  const changed = candidates.filter((entry) => entry.path && entry.coreOutcomes !== undefined);
  const deleted = broad.deleted.length
    ? ` ${broad.deleted.length} changed paths no longer exist (deleted or renamed); the change diff shows them: ${broad.deleted
        .slice(0, 8)
        .map((path) => path.slice(0, 160))
        .join(", ")}.`
    : "";
  return {
    id: BROAD_SCOPE_SOURCE_ID,
    kind: "implementation-file",
    reference: "Review source selection",
    sha256: "",
    available: false,
    excerpt: `The reviewed scope covers ${broad.scoped} project files, more than one review can deliver, so core sources are the ${changed.length} files changed since the work authorization${broad.neighbors.length ? ", with unchanged files they import as context" : ""}.${deleted} Unchanged in-scope files were not delivered and are not evidence either way; read them in the repository where a judgment depends on them.`,
  };
}

function coreCandidates(core: ReadonlyMap<string, string[]>, required: string[]) {
  const candidates: SourceCandidate[] = [...core].map(([path, coreOutcomes]) => ({
    path,
    category: "implementation",
    coreOutcomes,
  }));
  const resolved = new Set([...core.values()].flat());
  const unresolved = required.filter((outcome) => !resolved.has(outcome));
  if (unresolved.length) candidates.push({ category: "implementation", coreOutcomes: unresolved });
  return candidates;
}

function reviewQuestion(record: ProductRecord) {
  const findings = record.state.reviews
    .slice(-3)
    .flatMap((review) => review.feedback?.findings.map((finding) => finding.problem) ?? [])
    .join(" ");
  return [
    findings,
    ...record.state.reviews
      .slice(-3)
      .flatMap((review) =>
        (review.feedback?.probes ?? [])
          .filter((probe) => probe.status !== "satisfied")
          .flatMap((probe) => [probe.expected, probe.exercise, probe.observed]),
      ),
    ...productBehaviorProbes(record).probes.map((probe) => probe.question),
    record.brief.originalRequest,
    ...record.brief.outcomes.map((outcome) => outcome.statement),
    ...record.brief.examples.flatMap((example) => [
      example.title,
      example.when,
      ...example.expected,
    ]),
  ].join(" ");
}

async function readReviewSource(
  readSource: WorkspaceState["files"]["readTextIfExists"],
  candidate: SourceCandidate,
  snapshot: Record<string, string>,
  declarations: ProductCheck[],
  question: string,
  limit: number,
  spentGoals: readonly string[] = [],
): Promise<ProductSource> {
  if (!candidate.path && !candidate.execution)
    return {
      id: "CODE-CORE-UNRESOLVED",
      kind: "implementation-file",
      reference: "Unresolved required implementation",
      sha256: "",
      available: false,
      coreOutcomes: candidate.coreOutcomes,
      excerpt: `No implementation source could be resolved from scope, checks or changed files for outcomes: ${candidate.coreOutcomes?.join(", ")}. Their implementation cannot be assessed from delivered source.`,
    };
  if (candidate.execution) {
    const execution = candidate.execution;
    const declaration = declarations.find((check) => check.id === execution.check);
    const text = reviewCheckResult(execution, declaration, { spentGoals });
    // The identity excludes wall-clock timing, which changes on every run of the same execution.
    const identity = reviewCheckResult(execution, declaration, { timing: false, spentGoals });
    const gap = candidate.sourceUnresolved
      ? "Evidence gap: executed verifier/check source is unresolved or unavailable. Inspect the runner's selected assertion sources before judging coverage.\n"
      : "";

    return {
      id: `CHECK-${execution.id}`,
      kind: "executed-check",
      reference: `Executed ${execution.check} at ${execution.subjectDigest}`,
      sha256: sha256(identity),
      available: true,
      excerpt: gap + text,
      omittedRegions: [],
    };
  }
  const path = candidate.path as string;
  const read = await readSource(path);
  if (!read.ok || read.value === undefined || read.value.includes("\0")) {
    return {
      id: `CODE-${sha256(path).slice(0, 16)}`,
      kind: "implementation-file" as const,
      reference: path,
      sha256: snapshot[path] ?? "",
      available: false,
      ...(candidate.coreOutcomes !== undefined ? { coreOutcomes: candidate.coreOutcomes } : {}),
      excerpt: read.ok
        ? "Source is missing or binary; inspect with an appropriate reader"
        : read.error.message,
      truncated: true,
    };
  }
  const digest = sha256(read.value);
  const selection = await reviewExcerpt(path, read.value, question, limit);
  return {
    id: `CODE-${sha256(`${path}:${digest}`).slice(0, 16)}`,
    kind: "implementation-file" as const,
    reference: path,
    sha256: digest,
    available: true,
    excerpt: selection.excerpt,
    ...(candidate.coreOutcomes !== undefined ? { coreOutcomes: candidate.coreOutcomes } : {}),
    truncated: selection.omitted.length > 0,
    omittedRegions: selection.omitted,
    ...(selection.omitted.length
      ? { nextRead: `Read ${path} at the omitted line ranges before judging those behaviors` }
      : {}),
  };
}
