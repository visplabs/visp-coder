// sdlc pull VISP-12: caches epic VISP-12 from Jira (the owner's words, the spec, whether the
// owner approved it, and each task's contract and ticket) read-only under
// .sdlc/features/VISP-12/, so agents and hooks never need the network.

import { parseArgs } from "node:util";
import { parseFeature } from "../lib/paths.mjs";
import { pullFeature } from "../lib/pull-feature.mjs";

export async function run(args) {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  for (const line of await pullFeature(parseFeature(positionals[0]))) console.log(line);
  return 0;
}
