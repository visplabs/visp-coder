// No work before a ticket: a task agent starts only when the epic's spec is approved as it is
// now cached, and the task's Jira ticket is Ready (or already in progress or review, for later
// rounds). Both come from the last `sdlc pull`, so the hook needs no network.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { specHash } from "./hash.mjs";
import { featureDir } from "./paths.mjs";

export function gateRefusal(cwd, config, { feature, task, spec }) {
  const root = featureDir(feature, cwd);
  const pull = `run "pnpm sdlc pull ${feature}"`;
  const approval = readYaml(join(root, "spec", "approval.yml"));
  if (!approval) return `${feature} has no approval record; ${pull}`;
  if (!approval.approved) return `${feature} is not approved: ${approval.reason}`;
  if (approval.hash !== specHash(spec.intent, spec.acceptance)) {
    return `the cached spec of ${feature} is not the one the owner approved; ${pull}`;
  }
  const ticket = readYaml(join(root, "tasks", task, "ticket.yml"));
  if (!ticket) return `${task} has no Jira ticket in the cache; ${pull}`;
  const { ready, inProgress, inReview } = config.jira.statuses;
  if (![ready, inProgress, inReview].includes(ticket.status)) {
    return `${task} is not Ready in Jira (status ${ticket.status}); the clerk moves it once planned`;
  }
  return undefined;
}

function readYaml(path) {
  return existsSync(path) ? parse(readFileSync(path, "utf8")) : undefined;
}
