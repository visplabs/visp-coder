// sdlc packet F-12 [--results vitest.json]: writes the owner packet to
// .sdlc/features/F-12/owner-packet-<time>.md and prints its path.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { specHash } from "../lib/hash.mjs";
import { renderPacket } from "../lib/packet.mjs";
import { featureDir, stamp } from "../lib/paths.mjs";
import { loadArtifacts } from "../lib/spec-store.mjs";
import { traceFeature } from "./trace.mjs";

export function run(args) {
  const { feature, spec, report } = traceFeature(args);
  const dir = featureDir(feature);
  const { artifacts, invalid } = loadArtifacts(dir);
  const hash = specHash(spec.intent, spec.acceptance);
  const text = renderPacket({ feature, spec, hash, report, artifacts, invalid });
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `owner-packet-${stamp()}.md`);
  writeFileSync(path, text);
  console.log(path);
  return 0;
}
