// sdlc jira <action> ...: the clerk's Jira commands, as the agent service account. Reads (show)
// are open to every agent; the safety hook lets only the clerk run the others.
//   show VISP-13                                   title, status and body
//   create-task VISP-12 --title T --task-file F    a task under the epic; F is its task@1 yaml
//                                                  without `task`, which becomes the new key
//   move VISP-13 ready|in-progress|in-review|done  change the status
//   comment VISP-13 --body-file F                  add a comment

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parse, stringify } from "yaml";
import { jiraClient } from "../lib/jira.mjs";
import { parseFeature } from "../lib/paths.mjs";
import { validateDocument } from "../schemas/index.mjs";

const STATUS_NAMES = {
  ready: "ready",
  "in-progress": "inProgress",
  "in-review": "inReview",
  done: "done",
};

const ACTIONS = { show, "create-task": createTask, move, comment };

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
