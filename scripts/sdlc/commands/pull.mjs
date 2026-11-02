// sdlc pull F-12: copies the spec blocks of feature issue #12 into
// .sdlc/features/F-12/spec/, read-only, so agents and hooks never need the network.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { stringify } from "yaml";
import { featureDir, parseFeature } from "../lib/paths.mjs";
import { SPEC_FILES, specDocuments } from "../lib/spec-store.mjs";

export function run(args) {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  const feature = parseFeature(positionals[0]);
  const gh = process.env.SDLC_GH ?? "gh";
  const issue = JSON.parse(
    execFileSync(gh, ["issue", "view", feature.slice(2), "--json", "title,body,updatedAt,url"], {
      encoding: "utf8",
    }),
  );
  const docs = specDocuments(issue.body ?? "", feature);
  const dir = join(featureDir(feature), "spec");
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
  return 0;
}

function writeReadOnly(path, text) {
  writeFileSync(path, text);
  chmodSync(path, 0o444);
}
