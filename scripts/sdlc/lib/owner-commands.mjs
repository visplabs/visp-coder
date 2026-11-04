// What /feature and /approve do. Both run only from a command the owner types (the commands
// have disable-model-invocation, and the hook fires on UserPromptExpansion), so they act under
// the owner's own GitHub login.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gh, ghJson, ghWithBody } from "./gh.mjs";
import { specHash } from "./hash.mjs";
import { newFeatureBody, ownerTextOf } from "./issue-body.mjs";
import { featureDir, parseFeature } from "./paths.mjs";
import { pullFeature } from "./pull-feature.mjs";
import { specDocuments } from "./spec-store.mjs";

const OWNER = { as: "owner" };

// Opens the feature issue with the owner's words and returns the context for the session.
export function featureCommand(args, cwd) {
  const words = args.trim();
  if (!words) throw new Error("usage: /feature <your request>; its first line becomes the title");
  const title = words.split("\n")[0].trim().slice(0, 80);
  gh(["label", "create", "sdlc:feature", "--force", "--color", "0E8A16"], OWNER);
  const url = ghWithBody(
    ["issue", "create", "--title", title, "--label", "sdlc:feature"],
    newFeatureBody(words),
    OWNER,
  ).trim();
  const number = url.match(/\/issues\/(\d+)$/)?.[1];
  if (!number) throw new Error(`gh did not return an issue URL: ${url}`);
  const feature = `F-${number}`;
  const dir = featureDir(feature, cwd);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "owner-text.md");
  rmSync(path, { force: true });
  writeFileSync(path, words);
  return (
    `Feature issue #${number} (${feature}) holds the owner's words verbatim: ${url}. ` +
    `Next, start the qe-spec agent with a prompt containing the line "SDLC-Feature: ${feature}".`
  );
}

// "/approve F-12" shows what would be approved and its hash; "/approve F-12 <hash prefix>"
// approves exactly that. Returns the message for the owner.
export function approveCommand(args, cwd) {
  const [featureArg, prefix] = args.trim().split(/\s+/);
  const feature = parseFeature(featureArg);
  const number = feature.slice(2);
  const issue = readIssue(number);
  const { docs, hash } = checkedSpec(issue, feature);
  if (!prefix) return summary(feature, issue, docs, hash);
  if (!/^[0-9a-f]{12,64}$/.test(prefix) || !hash.startsWith(prefix)) {
    throw new Error(
      `the spec changed since it was shown (hash now ${hash.slice(0, 12)}); run /approve ${feature} again`,
    );
  }
  if (readIssue(number).updatedAt !== issue.updatedAt) {
    throw new Error(`issue #${number} changed while approving; run /approve ${feature} again`);
  }
  const comment = [
    "<!-- sdlc:approval -->",
    "Approved by the owner with `/approve`.",
    "",
    `Spec hash: \`${hash}\``,
    `Issue updated at: ${issue.updatedAt}`,
  ].join("\n");
  const url = ghWithBody(["issue", "comment", number], comment, OWNER).trim();
  gh(["label", "create", "intent-approved", "--force", "--color", "1D76DB"], OWNER);
  gh(["issue", "edit", number, "--add-label", "intent-approved"], OWNER);
  tryLock(number);
  pullFeature(feature, cwd);
  return `Approved ${feature} with spec hash ${hash}. ${url}`;
}

function readIssue(number) {
  return ghJson(["issue", "view", number, "--json", "title,body,updatedAt,url"]);
}

function checkedSpec(issue, feature) {
  const ownerText = ownerTextOf(issue.body);
  if (ownerText === undefined) {
    throw new Error(
      `issue for ${feature} has no owner's words section; was it opened with /feature?`,
    );
  }
  const docs = specDocuments(issue.body ?? "", feature);
  if (docs["intent@1"].owner_text.trim() !== ownerText.trim()) {
    throw new Error(
      "intent@1 owner_text differs from the words /feature recorded; fix the spec first",
    );
  }
  return { docs, hash: specHash(docs["intent@1"], docs["acceptance@1"]) };
}

function summary(feature, issue, docs, hash) {
  return [
    `${feature}: ${issue.title}`,
    "",
    "Clauses:",
    ...docs["intent@1"].clauses.map((c) => `- ${c.id} (${c.kind}) ${c.text}`),
    "",
    "Criteria:",
    ...docs["acceptance@1"].criteria.map((c) => `- ${c.id} [${c.clauses.join(", ")}] ${c.expect}`),
    "",
    `Test cases: ${docs["test-cases@1"].cases.length}. Full spec: ${issue.url}`,
    `Spec hash: ${hash}`,
    "",
    `To approve exactly this, run: /approve ${feature} ${hash.slice(0, 12)}`,
  ].join("\n");
}

// Locked issues take comments only from collaborators; an already locked issue is fine.
function tryLock(number) {
  try {
    gh(["issue", "lock", number], OWNER);
  } catch {
    // already locked
  }
}
