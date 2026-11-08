// Whether the owner approved exactly the current spec of an epic. The owner approves by posting
// the line approvalLine() prints as a Jira comment. A comment counts only when the owner wrote
// it, nobody edited it (Jira administrators can edit anyone's comment), it names the current
// spec hash, and it is newer than the last change to the epic's description. A status or label
// never counts: agents can set those.
//
// The line carries the first 12 hash characters, so it pastes cleanly; any longer prefix of the
// hash, up to all 64, counts too. Spaces a paste brings around the line are ignored. Every
// approval-like comment that does not count is listed with its reason, newest first.

const SHORT = 12;
const BLANK = "[ \\t\\u00a0]*";

export function approvalLine(feature, hash) {
  return `SDLC approval ${feature} spec ${hash.slice(0, SHORT)}`;
}

export function checkApproval({ feature, hash, ownerId, comments, bodyChangedAt }) {
  const pattern = new RegExp(
    `^${BLANK}SDLC approval ${feature} spec ([0-9a-f]{${SHORT},64})${BLANK}$`,
    "m",
  );
  const skipped = [];
  for (const comment of [...comments].reverse()) {
    const named = comment.text.match(pattern)?.[1];
    if (!named) continue;
    const reason = refusal(comment, named, { hash, ownerId, bodyChangedAt });
    if (!reason) {
      return { approved: true, hash, comment: comment.id, approved_at: comment.created };
    }
    skipped.push({ comment: comment.id, reason });
  }
  const reason = skipped[0]?.reason ?? "the owner has not approved this spec";
  return { approved: false, hash, reason, ...(skipped.length > 0 ? { skipped } : {}) };
}

function refusal(comment, named, { hash, ownerId, bodyChangedAt }) {
  if (comment.author !== ownerId) {
    return `comment ${comment.id} carries an approval line but was not written by the owner`;
  }
  if (comment.updateAuthor !== ownerId || comment.updated !== comment.created) {
    return `the owner's approval comment ${comment.id} was edited after posting`;
  }
  if (!hash.startsWith(named)) return "the spec changed since the owner approved it";
  if (bodyChangedAt && Date.parse(comment.created) <= Date.parse(bodyChangedAt)) {
    return "the epic's description changed after the owner approved it";
  }
  return undefined;
}
