// sdlc sentry-events --task VISP-13 --since <ISO time>: how many qe events Sentry holds for a task
// since a time, for qe-verify's sentry_events count. The token stays in this process: agents may
// run the command but never read the keyring.

import { parseArgs } from "node:util";
import { loadConfig } from "../lib/config.mjs";
import { sentryEventCount } from "../lib/sentry.mjs";
import { workKey } from "../schemas/spec.mjs";

export async function run(args) {
  const { values } = parseArgs({
    args,
    options: { task: { type: "string" }, since: { type: "string" } },
  });
  const since = new Date(values.since ?? "");
  if (!workKey.test(values.task ?? "") || Number.isNaN(since.getTime())) {
    throw new Error("usage: sdlc sentry-events --task VISP-13 --since <ISO time>");
  }
  const count = await sentryEventCount(loadConfig().sentry, { task: values.task, since });
  console.log(`sentry_events: ${count}`);
  return 0;
}
