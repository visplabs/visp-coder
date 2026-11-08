// Keeps Jira ticket statuses in step with the work, so no agent has to remember: a task moves
// to In Progress when its coder starts, to In Review while a PR names it, to Done once that PR
// is merged, and the epic to Done once every task is. Tickets only move forward. PRs are found
// by their "Task: VISP-<n>" line. A failed CI run on a task PR's merge commit is reported, so a
// broken base branch is seen when it breaks.

import { ghJson } from "./gh.mjs";

const ORDER = ["todo", "ready", "inProgress", "inReview", "done"];
const NAMES = { inProgress: "In Progress", inReview: "In Review", done: "Done" };

// Moves `key` to `target` if that is further along; returns what it did, or undefined.
export async function advance(jira, statuses, key, target, why) {
  const issue = await jira.readIssue(key);
  const current = ORDER.find((name) => statuses[name] === issue.status);
  if (current && ORDER.indexOf(current) >= ORDER.indexOf(target)) return undefined;
  await jira.moveTo(key, statuses[target]);
  return `${key} -> ${NAMES[target]} (${why})`;
}

// Brings an epic's tasks, and the epic, up to date with their pull requests.
export async function syncEpic(jira, config, feature) {
  const { statuses, issueTypes } = config.jira;
  const prs = ghJson([
    "pr",
    "list",
    "--state",
    "all",
    "--limit",
    "200",
    "--json",
    "number,state,body,mergeCommit",
  ]);
  const lines = [];
  const tasks = await jira.children(feature, issueTypes.task);
  for (const task of tasks) {
    const named = new RegExp(`^Task: ${task.key}\\s*$`, "m");
    const mine = prs.filter((pr) => named.test(pr.body ?? ""));
    const merged = mine.find((pr) => pr.state === "MERGED");
    const open = mine.find((pr) => pr.state === "OPEN");
    const move = merged
      ? await advance(jira, statuses, task.key, "done", `PR #${merged.number} merged`)
      : open && (await advance(jira, statuses, task.key, "inReview", `PR #${open.number} open`));
    if (move) lines.push(move);
    if (merged) lines.push(...mergeFailures(merged));
  }
  const after = await jira.children(feature, issueTypes.task);
  if (after.length > 0 && after.every((task) => task.status === statuses.done)) {
    const move = await advance(jira, statuses, feature, "done", "every task is Done");
    if (move) lines.push(move);
  }
  return lines;
}

const FAILED = new Set(["failure", "cancelled", "timed_out", "startup_failure"]);

function mergeFailures(pr) {
  const sha = pr.mergeCommit?.oid;
  if (!sha) return [];
  try {
    const runs = ghJson(["run", "list", "--commit", sha, "--json", "name,conclusion,status,url"]);
    return runs
      .filter((run) => FAILED.has(run.conclusion))
      .map((run) => `after PR #${pr.number} merged, CI ${run.name} failed on ${sha}: ${run.url}`);
  } catch (error) {
    return [`CI on PR #${pr.number}'s merge commit ${sha} not read: ${error.message}`];
  }
}
