// Turns a stage agent's yaml report into a filed artifact: reads the report, adds the envelope
// from the hook input and transcript, validates it, writes it and the worklog entry. Files are
// append-only: a name that exists gets a numeric suffix instead of being overwritten.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { validateDocument } from "../schemas/index.mjs";
import { featureDir, sdlcRoot, stamp } from "./paths.mjs";

const FENCE = /```ya?ml[^\n]*\n([\s\S]*?)```/g;

// The report is the last fenced yaml block. A handback that is nothing but the report, unfenced,
// counts too when it parses to a mapping with `status` or `review_file`.
export function lastYamlBlock(text) {
  const blocks = [...(text ?? "").replace(/\r\n/g, "\n").matchAll(FENCE)];
  if (blocks.length === 0) return bareReport(text) ?? { error: "the report has no ```yaml block" };
  try {
    return { doc: parse(blocks.at(-1)[1]) };
  } catch (error) {
    return { error: `the report's yaml block does not parse: ${error.message}` };
  }
}

function bareReport(text) {
  try {
    const doc = parse(text ?? "");
    const isReport = doc && typeof doc === "object" && ("status" in doc || "review_file" in doc);
    return isReport ? { doc } : undefined;
  } catch {
    return undefined;
  }
}

export function buildArtifact(type, envelope, doc, now) {
  const artifact = {
    schema: `${type}@1`,
    id: `${envelope.task}-${type}-${stamp(now)}`,
    ...envelope,
    created_at: now.toISOString(),
    status: doc?.status,
    body: doc?.body,
  };
  const result = validateDocument(artifact);
  if (result.ok) return { artifact: result.value };
  return { reason: `the report does not match ${type}@1: ${result.errors.join("; ")}` };
}

export function fileArtifact(cwd, artifact, now) {
  const dir = join(featureDir(artifact.feature, cwd), "tasks", artifact.task);
  return writeUnique(dir, `${artifact.schema.split("@")[0]}-${stamp(now)}`, artifact);
}

export function writeWorklog(cwd, envelope, { status, summary, now }) {
  const entry = {
    schema: "worklog@1",
    id: `${envelope.task ?? envelope.feature}-worklog-${stamp(now)}`,
    ...envelope,
    created_at: now.toISOString(),
    status,
    body: { event: "subagent-stop", summary },
  };
  const result = validateDocument(entry);
  if (!result.ok) throw new Error(`worklog entry is invalid: ${result.errors.join("; ")}`);
  const dir = join(sdlcRoot(cwd), "worklog", now.toISOString().slice(0, 10));
  const work = envelope.task ?? envelope.feature;
  return writeUnique(dir, `${stamp(now)}_${envelope.agent}_${work}`, result.value);
}

// Files changed since the branch left `base`, committed or not, plus untracked files.
export function changedFiles(root, base) {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const mergeBase = git("merge-base", base, "HEAD").trim();
  const listed = `${git("diff", "--name-only", mergeBase)}\n${git("ls-files", "--others", "--exclude-standard")}`;
  return [...new Set(listed.split("\n").filter(Boolean))];
}

function writeUnique(dir, name, doc) {
  mkdirSync(dir, { recursive: true });
  let path = join(dir, `${name}.yml`);
  for (let n = 2; existsSync(path); n++) path = join(dir, `${name}-${n}.yml`);
  writeFileSync(path, stringify(doc));
  return path;
}
