import type { WorkspaceState } from "../state.js";
import { readProductRecord } from "./store.js";
import {
  productImplementationDigest,
  productSourceDigest,
  productSourceSnapshot,
} from "./subject.js";

/**
 * The accepted feature whose work the uncommitted changes are, if they are all its work.
 * Claude Code commits only when the user asks, so a worker left its accepted feature
 * uncommitted, and the next session's `visp feature` refused to start from it (bench run
 * co1-conventions-carryover-prose-visp-dev-1). They are the feature's work when the source
 * is still what was accepted and every changed file is part of that source. The digest that
 * proves it is the accepted subject, or, under another VISP build, the implementation digest
 * of the review behind the acceptance, which leaves VISP's own config out, so a changed
 * config file is then not the feature's work. Anything unreadable attributes nothing.
 */
export async function acceptedWorkOwner(
  workspace: WorkspaceState,
  changed: readonly string[],
): Promise<string | undefined> {
  const record = await readProductRecord(workspace);
  if (!record.ok) return undefined;
  const { brief, state } = record.value;
  if (state.status !== "accepted" || !state.acceptedSubject) return undefined;
  const snapshot = await productSourceSnapshot(workspace, brief);
  if (!snapshot.ok) return undefined;
  for (const path of changed) {
    if (path in snapshot.value) continue;
    // A deletion the feature made is absent from the source it accepted; any other file left
    // out of the source (a byproduct, another host's file) is not part of what was accepted.
    const exists = await workspace.files.exists(path);
    if (!exists.ok || exists.value) return undefined;
  }
  const subject = await productSourceDigest(workspace, brief, snapshot.value);
  if (!subject.ok) return undefined;
  if (subject.value === state.acceptedSubject) return brief.feature;
  const controls = new Set(
    [workspace.paths.config, workspace.paths.policy, workspace.paths.overrides].map((path) =>
      workspace.paths.relative(path),
    ),
  );
  const reviewed = state.reviews.findLast(
    (review) =>
      review.subjectDigest === state.acceptedSubject && review.implementationDigest !== undefined,
  );
  return reviewed?.implementationDigest ===
    productImplementationDigest(workspace, snapshot.value) &&
    !changed.some((path) => controls.has(path))
    ? brief.feature
    : undefined;
}
