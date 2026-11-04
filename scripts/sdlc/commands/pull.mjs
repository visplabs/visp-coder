// sdlc pull F-12: copies the spec blocks of feature issue #12 into .sdlc/features/F-12/spec/
// and each task sub-issue's task@1 block into .sdlc/features/F-12/tasks/T-<n>/task.yml, all
// read-only, so agents and hooks never need the network.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { stringify } from "yaml";
import { featureDir, parseFeature } from "../lib/paths.mjs";
import { SPEC_FILES, specDocuments, taskDocument } from "../lib/spec-store.mjs";

const ISSUE_FIELDS = "title,body,updatedAt,url";

export function run(args) {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  const feature = parseFeature(positionals[0]);
  const number = feature.slice(2);
  const issue = gh(["issue", "view", number, "--json", ISSUE_FIELDS]);
  const docs = specDocuments(issue.body ?? "", feature);
  const root = featureDir(feature);
  const dir = join(root, "spec");
  rmSync(dir, { recursive: true, force: true });
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
  console.log(`pulled ${feature} into ${dir}`);
  pullTasks(feature, number, root);
  return 0;
}

function pullTasks(feature, number, root) {
  const subIssues = gh(["api", `repos/{owner}/{repo}/issues/${number}/sub_issues`]);
  for (const { number: taskNumber } of subIssues) {
    const issue = gh(["issue", "view", String(taskNumber), "--json", ISSUE_FIELDS]);
    const task = taskDocument(issue.body ?? "", feature, taskNumber);
    if (!task) {
      console.log(`#${taskNumber} has no task@1 block; skipped`);
      continue;
    }
    const dir = join(root, "tasks", task.task);
    mkdirSync(dir, { recursive: true });
    rmSync(join(dir, "task.yml"), { force: true });
    writeReadOnly(join(dir, "task.yml"), stringify(task));
    console.log(`pulled ${task.task} into ${dir}`);
  }
}

function gh(args) {
  return JSON.parse(execFileSync(process.env.SDLC_GH ?? "gh", args, { encoding: "utf8" }));
}

function writeReadOnly(path, text) {
  writeFileSync(path, text);
  chmodSync(path, 0o444);
}
