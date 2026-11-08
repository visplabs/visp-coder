// sdlc sync-status VISP-12: move the epic's task tickets (and the epic) forward to match their
// pull requests: In Review while a PR is open, Done once it is merged. The ticket-status Stop
// hook runs the same after each turn of the manager.

import { loadConfig } from "../lib/config.mjs";
import { jiraClient } from "../lib/jira.mjs";
import { parseFeature } from "../lib/paths.mjs";
import { syncEpic } from "../lib/ticket-status.mjs";

export async function run(args) {
  const feature = parseFeature(args[0]);
  const lines = await syncEpic(jiraClient(), loadConfig(), feature);
  console.log(lines.length > 0 ? lines.join("\n") : `${feature}: tickets already up to date`);
  return 0;
}
