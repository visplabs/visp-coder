import { recentCommits } from "../core/git.js";
import { redactRequest } from "../core/redaction.js";
import type { WorkspaceState } from "../workflow/state.js";
import type { EarlierFeature } from "./project-memory.js";

/**
 * Recorded decisions describe what the user asked for in an earlier session; the code can
 * change afterwards without VISP (a commit that raises a limit the request stated). Five of
 * five benchmark runs recalled the old limit as still binding, the reviewer required the old
 * limit, and the worker reverted the newer code. So a recall also lists the code changes made
 * after the earliest earlier request was given, for the gate, the worker and the reviewer to
 * weigh the notes against.
 */
const MAX_LATER_CHANGES = 20;
/** Commits scanned for newer ones, not counting commits that touch only `.visp`; bounds the work on a long history. */
const SCANNED_COMMITS = 200;
const MAX_SUBJECT_CHARS = 120;

/**
 * Commits on HEAD newer than the earliest earlier feature, newest first, as "hash subject"
 * lines with secrets masked. Commits that only touch VISP's own state are left out, so they
 * cannot push an outside change out of the bounded list. Anything that goes wrong (no Git, no commits, unreadable dates)
 * gives no list: the recall is then as before.
 */
export async function laterChanges(
  workspace: WorkspaceState,
  earlier: readonly EarlierFeature[],
): Promise<string[]> {
  const since = earliestCreation(earlier);
  if (since === undefined) return [];
  try {
    const commits = await recentCommits(workspace.paths.root, SCANNED_COMMITS);
    if (!commits.ok) return [];
    return (
      commits.value
        // Git dates have whole seconds; a commit in the second the feature was created counts as later.
        .filter((commit) => (commit.committedAt + 1) * 1000 > since)
        .slice(0, MAX_LATER_CHANGES)
        .map((commit) => `${commit.hash} ${subjectText(commit.subject, workspace.paths.root)}`)
    );
  } catch {
    return [];
  }
}

function earliestCreation(earlier: readonly EarlierFeature[]): number | undefined {
  const times = earlier
    .map((feature) => (feature.createdAt ? Date.parse(feature.createdAt) : Number.NaN))
    .filter(Number.isFinite);
  return times.length ? Math.min(...times) : undefined;
}

function subjectText(subject: string, root: string): string {
  const flat = redactRequest(subject.replace(/\s+/g, " ").trim(), root);
  return flat.length > MAX_SUBJECT_CHARS ? `${flat.slice(0, MAX_SUBJECT_CHARS - 1)}…` : flat;
}
