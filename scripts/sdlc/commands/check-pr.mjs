// sdlc check-pr <number> [--results vitest.json]: the CI gate for a task pull request. Exits 1
// when the spec is not approved as it stands or the task's linked tests do not all pass.

import { parseArgs } from "node:util";
import { checkPr } from "../lib/pr-check.mjs";

export function run(args) {
  const { values, positionals } = parseArgs({
    args,
    options: { results: { type: "string" } },
    allowPositionals: true,
  });
  const number = positionals[0];
  if (!/^\d+$/.test(number ?? "")) throw new Error("usage: sdlc check-pr <pull request number>");
  const { status, lines } = checkPr(number, {
    resultsFile: values.results,
    ownerLogin: process.env.SDLC_OWNER_LOGIN,
  });
  for (const line of lines) console.log(line);
  return status === "fail" ? 1 : 0;
}
