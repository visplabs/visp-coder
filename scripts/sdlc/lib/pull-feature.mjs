// Copies a feature issue into the local read-only cache: the owner's words as owner-text.md,
// the spec blocks under spec/, and each task sub-issue's task@1 block as tasks/T-<n>/task.yml.
// A feature without a spec yet keeps only the owner's words. Returns what it did, line by line.

import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { ghJson } from "./gh.mjs";
import { ownerTextOf } from "./issue-body.mjs";
import { featureDir } from "./paths.mjs";
import { SPEC_FILES, specDocuments, taskDocument } from "./spec-store.mjs";
import { yamlBlocks } from "./yaml-blocks.mjs";

const ISSUE_FIELDS = "title,body,updatedAt,url";

export function pullFeature(feature, cwd = process.cwd()) {
  const number = feature.slice(2);
  const issue = ghJson(["issue", "view", number, "--json", ISSUE_FIELDS]);
  const root = featureDir(feature, cwd);
  const lines = [];
  mkdirSync(root, { recursive: true });
  const ownerText = ownerTextOf(issue.body);
  if (ownerText !== undefined) writeReadOnly(join(root, "owner-text.md"), ownerText);
  const dir = join(root, "spec");
  rmSync(dir, { recursive: true, force: true });
  const hasSpec = yamlBlocks(issue.body ?? "").some((block) => block.schema in SPEC_FILES);
  if (!hasSpec) {
    lines.push(`${feature} has no spec yet; kept the owner's words only`);
    return lines;
  }
  const docs = specDocuments(issue.body ?? "", feature);
  mkdirSync(dir, { recursive: true });
  for (const [schema, file] of Object.entries(SPEC_FILES)) {
    writeReadOnly(join(dir, file), stringify(docs[schema]));
  }
  const source = {
    issue: issue.url,
    title: issue.title,
    updated_at: issue.updatedAt,
    pulled_at: new Date().toISOString(),
  };
  writeReadOnly(join(dir, "source.yml"), stringify(source));
  lines.push(`pulled ${feature} into ${dir}`);
  return [...lines, ...pullTasks(feature, number, root)];
}

function pullTasks(feature, number, root) {
  const lines = [];
  const subIssues = ghJson(["api", `repos/{owner}/{repo}/issues/${number}/sub_issues`]);
  for (const { number: taskNumber } of subIssues) {
    const issue = ghJson(["issue", "view", String(taskNumber), "--json", ISSUE_FIELDS]);
    const task = taskDocument(issue.body ?? "", feature, taskNumber);
    if (!task) {
      lines.push(`#${taskNumber} has no task@1 block; skipped`);
      continue;
    }
    const dir = join(root, "tasks", task.task);
    mkdirSync(dir, { recursive: true });
    writeReadOnly(join(dir, "task.yml"), stringify(task));
    lines.push(`pulled ${task.task} into ${dir}`);
  }
  return lines;
}

function writeReadOnly(path, text) {
  rmSync(path, { force: true });
  writeFileSync(path, text);
  chmodSync(path, 0o444);
}
