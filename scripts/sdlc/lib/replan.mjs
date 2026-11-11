// The manager may change its own task tickets (owner decision D11, Nov 9 2026) through the
// clerk's `sdlc jira edit-task`. The owner approved the epic's intent and acceptance, not the
// tasks, so a re-plan needs no approval, but it must leave a record and stay narrow:
// - before the task starts (To Do, Ready) anything but its epic and key may change;
// - once In Progress only its scope may change, and only grow, so the coder's work so far
//   stays inside it;
// - an In Review or Done task has a pull request; plan a new task instead;
// - an added path names files, or one folder like docs/adr/**, never a wider tree.

const STARTED = new Set(["inProgress"]);
const CLOSED = { inReview: "In Review", done: "Done" };

// Why `next` may not replace `old` for a task in `status` (a config status name), or undefined.
export function replanRefusal(old, next, status) {
  if (next.feature !== old.feature || next.task !== old.task) {
    return `the draft names ${next.feature}/${next.task}, but this is ${old.feature}/${old.task}; a task's epic and key never change`;
  }
  if (CLOSED[status]) {
    return `${old.task} is ${CLOSED[status]}: its pull request is open or merged, so plan a new task instead`;
  }
  const { added, removed } = scopeChange(old, next);
  const wide = added.find(tooWide);
  if (wide) return `${wide} is wider than one folder; name files, or one folder like docs/adr/**`;
  if (STARTED.has(status)) {
    if (removed.length > 0) {
      return `${old.task} is In Progress, so its scope may only grow; it would lose ${removed.join(", ")}`;
    }
    if (!sameSet(old.criteria, next.criteria)) {
      return `${old.task} is In Progress, so its criteria are frozen`;
    }
    if (old.track !== next.track || old.size !== next.size) {
      return `${old.task} is In Progress, so only its scope may change`;
    }
  }
  if (added.length === 0 && removed.length === 0 && sameTask(old, next)) {
    return "the draft changes nothing";
  }
  return undefined;
}

export function scopeChange(old, next) {
  return {
    added: next.scope.paths.filter((path) => !old.scope.paths.includes(path)),
    removed: old.scope.paths.filter((path) => !next.scope.paths.includes(path)),
  };
}

// `**` may only end a path, after at least two folders: docs/adr/** but not src/** or **.
function tooWide(path) {
  const parts = path.split("/");
  const last = parts.length - 1;
  return parts.some((part, i) => part.includes("**") && (i !== last || part !== "**" || i < 2));
}

function sameSet(a, b) {
  return a.length === b.length && a.every((item) => b.includes(item));
}

function sameTask(old, next) {
  return sameSet(old.criteria, next.criteria) && old.track === next.track && old.size === next.size;
}
