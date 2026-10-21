import { matchesAny } from "../../../core/patterns.js";
import type { Result } from "../../../core/result.js";
import type { Override } from "../../policy/schema.js";
import type { FeatureDiffRead } from "../feature-diff.js";
import type { ProductRecord } from "../store.js";
import type { EvidenceChanges, EvidenceFile } from "./record-types.js";

/** What the feature changed, set against the scope its slices declared. */
export function evidenceChanges(
  record: ProductRecord,
  read: Result<FeatureDiffRead>,
  earlierWork: ReadonlySet<string>,
  overrides: readonly Override[],
  now: string,
): EvidenceChanges {
  const scope = {
    declared: record.brief.slices.map((slice) => ({
      slice: slice.id,
      allowed: [...new Set([...slice.scope.allowed, ...slice.scope.expected])],
      forbidden: slice.scope.forbidden,
    })),
    overrides: overrides
      .filter(
        (entry) =>
          !entry.revokedAt &&
          entry.expiresAt > now &&
          (!entry.scope.feature || entry.scope.feature === record.brief.feature),
      )
      .map((entry) => ({ rule: entry.rule, reason: entry.reason })),
    refusedEdits: { recorded: false } as const,
  };
  if (!read.ok)
    return {
      available: false,
      note: read.error.message,
      end: "working-tree",
      files: [],
      totals: { files: 0, added: 0, removed: 0 },
      omittedFiles: 0,
      hiddenFiles: 0,
      scope: { ...scope, outside: [] },
    };
  const { base, end, diff } = read.value;
  const pinned = new Set(
    record.brief.acceptanceBaseline.flatMap((check) => check.files.map((file) => file.path)),
  );
  const files: EvidenceFile[] = diff.files.map((file) => ({
    path: file.path,
    status: file.status,
    added: file.added,
    removed: file.removed,
    binary: file.binary,
    slices: scope.declared
      .filter(
        (slice) => matchesAny(file.path, slice.allowed) && !matchesAny(file.path, slice.forbidden),
      )
      .map((slice) => slice.slice),
    origin: pinned.has(file.path)
      ? "independent-tests"
      : earlierWork.has(file.path)
        ? "earlier-work"
        : "feature",
  }));
  return {
    available: true,
    ...(diff.notes.length ? { note: diff.notes.join(" ") } : {}),
    base: { ref: base.ref, how: base.how },
    end: end.how,
    files,
    totals: {
      files: files.length + diff.omittedFiles,
      added: files.reduce((sum, file) => sum + file.added, 0),
      removed: files.reduce((sum, file) => sum + file.removed, 0),
    },
    omittedFiles: diff.omittedFiles,
    hiddenFiles: diff.hiddenFiles,
    scope: {
      ...scope,
      outside: files
        .filter((file) => !file.slices.length && file.origin === "feature")
        .map((file) => file.path),
    },
  };
}
