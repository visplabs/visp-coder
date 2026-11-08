// sdlc packet F-12 [--results vitest.json] [--notes notes.md]: writes the owner packet to
// .sdlc/features/F-12/owner-packet-<time>.md and prints its path. The notes are the manager's
// retro notes: the pipeline problems it hit, which the retro reads.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { specHash } from "../lib/hash.mjs";
import { renderPacket } from "../lib/packet.mjs";
import { featureDir, stamp } from "../lib/paths.mjs";
import { loadArtifacts } from "../lib/spec-store.mjs";
import { traceFeature } from "./trace.mjs";

export function run(args) {
  const { feature, spec, report, notes: notesFile } = traceFeature(args);
  const notes = notesFile ? readFileSync(notesFile, "utf8").trim() : undefined;
  const dir = featureDir(feature);
  const { artifacts, invalid } = loadArtifacts(dir);
  const hash = specHash(spec.intent, spec.acceptance);
  const text = renderPacket({ feature, spec, hash, report, artifacts, invalid, notes });
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `owner-packet-${stamp()}.md`);
  writeFileSync(path, text);
  console.log(path);
  return 0;
}
