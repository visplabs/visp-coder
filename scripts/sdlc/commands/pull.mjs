// sdlc pull F-12: caches feature issue #12 (the owner's words, the spec and each task
// sub-issue's contract) read-only under .sdlc/features/F-12/, so agents and hooks never need
// the network.

import { parseArgs } from "node:util";
import { parseFeature } from "../lib/paths.mjs";
import { pullFeature } from "../lib/pull-feature.mjs";

export function run(args) {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  for (const line of pullFeature(parseFeature(positionals[0]))) console.log(line);
  return 0;
}
