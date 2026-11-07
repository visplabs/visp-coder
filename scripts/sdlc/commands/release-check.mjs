// sdlc release-check <version>: run before publishing a release. Fails when Sentry holds an
// unresolved issue that first appeared in that release in bench, dogfood or QE runs, and lists
// them, so a regression is found before users meet it.

import { loadConfig } from "../lib/config.mjs";
import { newIssuesForRelease } from "../lib/sentry.mjs";

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export async function run(args) {
  const version = args[0] ?? "";
  if (!SEMVER.test(version)) throw new Error("usage: sdlc release-check <version, like 0.6.0>");
  let issues;
  try {
    issues = await newIssuesForRelease(loadConfig().sentry, version);
  } catch (error) {
    throw new Error(`cannot ask Sentry, so the release is not checked: ${error.message}`);
  }
  if (issues.length === 0) {
    console.log(`no new Sentry issues for visp-coder@${version}`);
    return 0;
  }
  console.log(`${issues.length} new Sentry issues for visp-coder@${version}:`);
  for (const issue of issues) console.log(`- ${issue.title} ${issue.link}`);
  return 1;
}
