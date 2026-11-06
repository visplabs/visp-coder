// Whether the owner approved exactly the current spec of an epic. The owner approves by posting
// the line approvalLine() prints as a Jira comment. A comment counts only when the owner wrote
// it, nobody edited it (Jira administrators can edit anyone's comment), it names the current
// spec hash, and it is newer than the last change to the epic's description. A status or label
// never counts: agents can set those.

export function approvalLine(feature, hash) {
  return `SDLC approval ${feature} spec ${hash}`;
}

export function checkApproval({ feature, hash, ownerId, comments, bodyChangedAt }) {
  const pattern = new RegExp(`^SDLC approval ${feature} spec ([0-9a-f]{64})$`, "m");
  let reason = "the owner has not approved this spec";
  for (const comment of [...comments].reverse()) {
    const named = comment.text.match(pattern)?.[1];
    if (!named) continue;
    if (comment.author !== ownerId) {
      reason = `comment ${comment.id} carries an approval line but was not written by the owner`;
    } else if (comment.updateAuthor !== ownerId || comment.updated !== comment.created) {
      reason = `the owner's approval comment ${comment.id} was edited after posting`;
    } else if (named !== hash) {
      reason = "the spec changed since the owner approved it";
    } else if (bodyChangedAt && Date.parse(comment.created) <= Date.parse(bodyChangedAt)) {
      reason = "the epic's description changed after the owner approved it";
    } else {
      return { approved: true, hash, comment: comment.id, approved_at: comment.created };
    }
  }
  return { approved: false, hash, reason };
}
