// sdlc jira <action> ...: the clerk's Jira commands, as the agent bot user. Reads (show)
// are open to every agent; the safety hook lets only the clerk run the others.
//   show VISP-13                                   title, status and body
//   create-task VISP-12 --title T --task-file F    a task under the epic; F is its task@1 yaml
//                                                  without `task`, which becomes the new key
//   move VISP-13 ready|in-progress|in-review|done  change the status
//   comment VISP-13 --body-file F                  add a comment
//   edit-task VISP-13 --task-file F --why-file W   re-plan a task (replan.mjs): replace its
//                                                  task@1 block, record the change, comment

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parse, stringify } from "yaml";
import { jiraClient } from "../lib/jira.mjs";
import { parseFeature } from "../lib/paths.mjs";
import { replanRefusal, scopeChange } from "../lib/replan.mjs";
import { taskDocument } from "../lib/spec-store.mjs";
import { replaceBlock, yamlBlocks } from "../lib/yaml-blocks.mjs";
import { validateDocument } from "../schemas/index.mjs";

const STATUS_NAMES = {
  ready: "ready",
  "in-progress": "inProgress",
  "in-review": "inReview",
  done: "done",
};

const ACTIONS = { show, "create-task": createTask, move, comment, "edit-task": editTask };

export async function run(args) {
  const [action, ...rest] = args;
  const handler = ACTIONS[action];
  if (!handler)
    throw new Error(
      `unknown jira action "${action ?? ""}"; use ${Object.keys(ACTIONS).join(", ")}`,
    );
  const { positionals, values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      title: { type: "string" },
      "task-file": { type: "string" },
      "body-file": { type: "string" },
      "why-file": { type: "string" },
    },
  });
  for (const line of await handler(
    jiraClient(),
    parseFeature(positionals[0]),
    positionals,
    values,
  )) {
    console.log(line);
  }
  return 0;
}

async function show(jira, key) {
  const issue = await jira.readIssue(key);
  return [`${issue.key} ${issue.title}`, `status ${issue.status}  ${issue.url}`, "", issue.body];
}

async function createTask(jira, epic, _positionals, values) {
  if (!values.title || !values["task-file"]) {
    throw new Error("create-task needs --title and --task-file");
  }
  const draft = parse(readFileSync(values["task-file"], "utf8"));
  const contract = (task) => validateDocument({ ...draft, schema: "task@1", feature: epic, task });
  const checked = contract(`${jira.config.jira.project.key}-1`);
  if (!checked.ok) throw new Error(`the task@1 draft is invalid: ${checked.errors.join("; ")}`);
  const { key, url } = await jira.createIssue({
    type: jira.config.jira.issueTypes.task,
    summary: values.title,
    body: "Task contract follows.",
    parent: epic,
  });
  const yaml = stringify(contract(key).value);
  await jira.writeBody(key, `## Task contract\n\n\`\`\`yaml\n${yaml}\`\`\`\n`);
  return [`created ${key} under ${epic}: ${url}`];
}

async function move(jira, key, positionals) {
  const name = STATUS_NAMES[positionals[1]];
  if (!name) throw new Error(`move needs one of: ${Object.keys(STATUS_NAMES).join(", ")}`);
  await jira.moveTo(key, jira.config.jira.statuses[name]);
  return [`moved ${key} to ${positionals[1]}`];
}

async function comment(jira, key, _positionals, values) {
  if (!values["body-file"]) throw new Error("comment needs --body-file");
  await jira.addComment(key, readFileSync(values["body-file"], "utf8"));
  return [`commented on ${key}`];
}

async function editTask(jira, key, _positionals, values) {
  if (!values["task-file"] || !values["why-file"]) {
    throw new Error("edit-task needs --task-file and --why-file");
  }
  const why = readFileSync(values["why-file"], "utf8").trim();
  if (!why) throw new Error("edit-task needs a reason in --why-file: why the plan changes");
  const { jira: settings } = jira.config;
  const issue = await jira.readIssue(key);
  if (issue.type === settings.issueTypes.epic) {
    throw new Error(`${key} is an epic; its owner's words and spec stay with the owner`);
  }
  const block = yamlBlocks(issue.body ?? "").find((doc) => doc.schema === "task@1");
  if (!block) throw new Error(`${key} has no task@1 block to re-plan`);
  const old = taskDocument(issue.body, block.feature, key);
  const { changes: _ignored, ...draft } = parse(readFileSync(values["task-file"], "utf8"));
  const next = { ...old, ...draft, schema: "task@1" };
  const status = Object.keys(settings.statuses).find(
    (name) => settings.statuses[name] === issue.status,
  );
  const refused = replanRefusal(old, next, status);
  if (refused) throw new Error(refused);
  const { added, removed } = scopeChange(old, next);
  const change = { at: new Date().toISOString(), added, removed, why };
  const checked = validateDocument({ ...next, changes: [...(old.changes ?? []), change] });
  if (!checked.ok) throw new Error(`the task@1 draft is invalid: ${checked.errors.join("; ")}`);
  await jira.writeBody(key, replaceBlock(issue.body, "task@1", stringify(ordered(checked.value))));
  const summary = [
    added.length > 0 ? `added ${added.join(", ")}` : "",
    removed.length > 0 ? `removed ${removed.join(", ")}` : "",
  ].filter(Boolean);
  const what = summary.join("; ") || "changed criteria, track or size";
  await jira.addComment(key, `Re-planned by the manager: ${what}.\n\nWhy: ${why}`);
  return [`re-planned ${key}: ${what}`];
}

function ordered({ schema, feature, task, criteria, scope, track, size, changes }) {
  return { schema, feature, task, criteria, scope, track, size, changes };
}
