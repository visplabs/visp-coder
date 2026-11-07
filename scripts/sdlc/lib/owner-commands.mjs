// What /feature and /approve do. Both run only from a command the owner types (the commands
// have disable-model-invocation, and the hook fires on UserPromptExpansion). /feature opens the
// epic through the agent bot user; the owner's own Jira token is never stored. /approve
// only reads: it shows the owner's words, the spec and its hash, and the exact line the owner
// posts as a Jira comment to approve it. That comment, written by the owner's own account, is
// the approval; see approval.mjs.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approvalLine } from "./approval.mjs";
import { specHash } from "./hash.mjs";
import { newFeatureBody, ownerTextOf } from "./issue-body.mjs";
import { jiraClient } from "./jira.mjs";
import { featureDir, parseFeature } from "./paths.mjs";
import { pullFeature } from "./pull-feature.mjs";
import { specDocuments } from "./spec-store.mjs";

// Opens the epic with the owner's words and returns the context for the session.
export async function featureCommand(args, cwd) {
  const words = args.trim();
  if (!words) throw new Error("usage: /feature <your request>; its first line becomes the title");
  const title = words.split("\n")[0].trim().slice(0, 80);
  const jira = jiraClient(cwd);
  const { key, url } = await jira.createIssue({
    type: jira.config.jira.issueTypes.epic,
    summary: title,
    body: newFeatureBody(words),
  });
  const dir = featureDir(key, cwd);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "owner-text.md");
  rmSync(path, { force: true });
  writeFileSync(path, words);
  return (
    `Epic ${key} holds the owner's words verbatim: ${url}. ` +
    `Next, start the qe-spec agent with a prompt containing the line "SDLC-Feature: ${key}".`
  );
}

// "/approve VISP-12" shows what the owner would approve and the line that approves it.
export async function approveCommand(args, cwd) {
  const feature = parseFeature(args.trim().split(/\s+/)[0]);
  const jira = jiraClient(cwd);
  const epic = await jira.readIssue(feature);
  const ownerText = ownerTextOf(epic.body);
  if (ownerText === undefined) {
    throw new Error(`${feature} has no owner's words section; was it opened with /feature?`);
  }
  const docs = specDocuments(epic.body, feature);
  if (docs["intent@1"].owner_text.trim() !== ownerText.trim()) {
    throw new Error(
      "intent@1 owner_text differs from the words /feature recorded; fix the spec first",
    );
  }
  const hash = specHash(docs["intent@1"], docs["acceptance@1"]);
  const status = (await pullFeature(feature, cwd))[0];
  return [
    `${feature}: ${epic.title}`,
    "",
    "Your words, as recorded:",
    ...ownerText.split("\n").map((line) => `> ${line}`),
    "",
    "Clauses:",
    ...docs["intent@1"].clauses.map((c) => `- ${c.id} (${c.kind}) ${c.text}`),
    "",
    "Criteria:",
    ...docs["acceptance@1"].criteria.map((c) => `- ${c.id} [${c.clauses.join(", ")}] ${c.expect}`),
    "",
    `Test cases: ${docs["test-cases@1"].cases.length}. Full spec: ${epic.url}`,
    `Now: ${status}`,
    "",
    "To approve exactly this, post this line as a comment on the epic from your own Jira account:",
    "",
    approvalLine(feature, hash),
  ].join("\n");
}
