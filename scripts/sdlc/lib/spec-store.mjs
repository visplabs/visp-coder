// Reads a feature spec out of an issue body (the epic's in Jira, or a GitHub issue's for the CI
// check) and out of the local read-only cache, and reads the stage reports filed for the
// feature. Everything read is validated against its schema.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { validateDocument } from "../schemas/index.mjs";
import { applyLinks } from "./test-links.mjs";
import { yamlBlocks } from "./yaml-blocks.mjs";

export const SPEC_FILES = {
  "intent@1": "intent.yml",
  "acceptance@1": "acceptance.yml",
  "test-cases@1": "test-cases.yml",
};

export function specDocuments(body, feature) {
  const docs = {};
  for (const block of yamlBlocks(body)) {
    if (!(block.schema in SPEC_FILES)) continue;
    const result = validateDocument(block);
    if (!result.ok) throw new Error(`${block.schema} block: ${result.errors.join("; ")}`);
    if (result.value.feature !== feature) {
      throw new Error(`${block.schema} block belongs to ${result.value.feature}, not ${feature}`);
    }
    if (docs[block.schema]) throw new Error(`more than one ${block.schema} block`);
    docs[block.schema] = result.value;
  }
  const missing = Object.keys(SPEC_FILES).filter((schema) => !docs[schema]);
  if (missing.length > 0) throw new Error(`the issue has no ${missing.join(", ")} block`);
  return docs;
}

export function loadSpec(dir) {
  if (!existsSync(dir)) throw new Error(`no spec at ${dir}; run "sdlc pull" first`);
  const docs = {};
  for (const [schema, file] of Object.entries(SPEC_FILES)) {
    const result = validateDocument(readYaml(join(dir, file)));
    if (!result.ok) throw new Error(`${file}: ${result.errors.join("; ")}`);
    docs[schema] = result.value;
  }
  const links = taskLinks(join(dir, "..", "tasks"));
  const testCases = {
    ...docs["test-cases@1"],
    cases: applyLinks(docs["test-cases@1"].cases, links),
  };
  return {
    intent: docs["intent@1"],
    acceptance: docs["acceptance@1"],
    testCases,
    source: readYaml(join(dir, "source.yml")),
  };
}

// The test links each task's issue holds (tasks/<task>/links.yml), laid over the spec's own.
function taskLinks(tasks) {
  if (!existsSync(tasks)) return [];
  return readdirSync(tasks)
    .map((task) => join(tasks, task, "links.yml"))
    .filter((path) => existsSync(path))
    .flatMap((path) => {
      const result = validateDocument(readYaml(path));
      if (!result.ok) throw new Error(`${path}: ${result.errors.join("; ")}`);
      return result.value.links;
    });
}

// Stage reports under tasks/<task>/*.yml, oldest first; task.yml (the task's contract),
// ticket.yml (its Jira ticket) and links.yml (its test links) are not reports. Invalid files are returned apart.
const NOT_REPORTS = new Set(["task.yml", "ticket.yml", "links.yml"]);

export function loadArtifacts(featurePath) {
  const tasks = join(featurePath, "tasks");
  if (!existsSync(tasks)) return { artifacts: [], invalid: [] };
  const artifacts = [];
  const invalid = [];
  for (const task of readdirSync(tasks)) {
    const reports = readdirSync(join(tasks, task)).filter(
      (name) => name.endsWith(".yml") && !NOT_REPORTS.has(name),
    );
    for (const file of reports) {
      const path = join(tasks, task, file);
      const result = validateDocument(readYaml(path));
      if (result.ok) artifacts.push(result.value);
      else invalid.push({ path, errors: result.errors });
    }
  }
  artifacts.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return { artifacts, invalid };
}

function readYaml(path) {
  return parse(readFileSync(path, "utf8"));
}

// The task@1 block of a task issue, or undefined when it has none. Its `task` must be the
// issue's own key.
export function taskDocument(body, feature, key) {
  const block = yamlBlocks(body).find((doc) => doc.schema === "task@1");
  if (!block) return undefined;
  const result = validateDocument(block);
  if (!result.ok) throw new Error(`${key} task@1 block: ${result.errors.join("; ")}`);
  if (result.value.feature !== feature || result.value.task !== key) {
    throw new Error(`${key} task@1 block names ${result.value.feature}/${result.value.task}`);
  }
  return result.value;
}
