// Copies an epic from Jira into the local read-only cache: the owner's words as owner-text.md,
// the spec blocks under spec/, whether the owner approved that exact spec as spec/approval.yml,
// and each child task's task@1 block and ticket (status, link) under tasks/<key>/. An epic
// without a spec yet keeps only the owner's words. Returns what it did, line by line.

import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { checkApproval } from "./approval.mjs";
import { specHash } from "./hash.mjs";
import { ownerTextOf } from "./issue-body.mjs";
import { jiraClient } from "./jira.mjs";
import { featureDir } from "./paths.mjs";
import { SPEC_FILES, specDocuments, taskDocument } from "./spec-store.mjs";
import { yamlBlocks } from "./yaml-blocks.mjs";

export async function pullFeature(feature, cwd = process.cwd()) {
  const jira = jiraClient(cwd);
  const epic = await jira.readIssue(feature);
  const root = featureDir(feature, cwd);
  const lines = [];
  mkdirSync(root, { recursive: true });
  const ownerText = ownerTextOf(epic.body);
  if (ownerText !== undefined) writeReadOnly(join(root, "owner-text.md"), ownerText);
  const dir = join(root, "spec");
  rmSync(dir, { recursive: true, force: true });
  const hasSpec = yamlBlocks(epic.body).some((block) => block.schema in SPEC_FILES);
  if (!hasSpec) {
    lines.push(`${feature} has no spec yet; kept the owner's words only`);
    return lines;
  }
  const docs = specDocuments(epic.body, feature);
  mkdirSync(dir, { recursive: true });
  for (const [schema, file] of Object.entries(SPEC_FILES)) {
    writeReadOnly(join(dir, file), stringify(docs[schema]));
  }
  const source = {
    issue: epic.url,
    title: epic.title,
    updated_at: epic.updated,
    pulled_at: new Date().toISOString(),
  };
  writeReadOnly(join(dir, "source.yml"), stringify(source));
  const approval = checkApproval({
    feature,
    hash: specHash(docs["intent@1"], docs["acceptance@1"]),
    ownerId: jira.config.owner.accountId,
    comments: await jira.comments(feature),
    bodyChangedAt: await jira.bodyChangedAt(feature),
  });
  writeReadOnly(join(dir, "approval.yml"), stringify(approval));
  lines.push(`pulled ${feature} into ${dir} (${approval.approved ? "approved" : approval.reason})`);
  return [...lines, ...(await pullTasks(jira, feature, root))];
}

async function pullTasks(jira, feature, root) {
  const lines = [];
  for (const issue of await jira.children(feature, jira.config.jira.issueTypes.task)) {
    const task = taskDocument(issue.body, feature, issue.key);
    if (!task) {
      lines.push(`${issue.key} has no task@1 block; skipped`);
      continue;
    }
    const dir = join(root, "tasks", task.task);
    mkdirSync(dir, { recursive: true });
    writeReadOnly(join(dir, "task.yml"), stringify(task));
    const ticket = { key: issue.key, title: issue.title, status: issue.status, url: issue.url };
    writeReadOnly(join(dir, "ticket.yml"), stringify(ticket));
    lines.push(`pulled ${task.task} into ${dir}`);
  }
  return lines;
}

function writeReadOnly(path, text) {
  rmSync(path, { force: true });
  writeFileSync(path, text);
  chmodSync(path, 0o444);
}
