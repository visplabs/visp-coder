// Moves a feature spec between its GitHub issue and the local read-only cache, and reads the
// stage reports filed for the feature. Everything read is validated against its schema.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { validateDocument } from "../schemas/index.mjs";
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
  return {
    intent: docs["intent@1"],
    acceptance: docs["acceptance@1"],
    testCases: docs["test-cases@1"],
    source: readYaml(join(dir, "source.yml")),
  };
}

// Stage reports under tasks/<task>/*.yml, oldest first. Invalid files are returned apart.
export function loadArtifacts(featurePath) {
  const tasks = join(featurePath, "tasks");
  if (!existsSync(tasks)) return { artifacts: [], invalid: [] };
  const artifacts = [];
  const invalid = [];
  for (const task of readdirSync(tasks)) {
    for (const file of readdirSync(join(tasks, task)).filter((name) => name.endsWith(".yml"))) {
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
