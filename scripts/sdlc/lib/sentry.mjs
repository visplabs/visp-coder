// Sentry as the release check: VISP's bench runs, the owner's own sessions (dogfood) and QE runs
// report crashes to Sentry, each in its own environment and tagged with the release. Before a
// release is published, no unresolved issue may have first appeared in it. Read-only: the token
// is SENTRY_READ_TOKEN or the keyring entry sdlc.config.json names (`event:read`,
// `project:read`). SDLC_SENTRY_URL replaces the API host in tests. Any failure to ask throws.

import { execFileSync } from "node:child_process";

export async function newIssuesForRelease(sentry, version) {
  const base = process.env.SDLC_SENTRY_URL ?? sentry.url;
  const params = new URLSearchParams({
    query: `is:unresolved firstRelease:visp-coder@${version}`,
    statsPeriod: "90d",
    limit: "100",
  });
  for (const environment of sentry.environments) params.append("environment", environment);
  const path = `/api/0/projects/${sentry.org}/${sentry.project}/issues/?${params}`;
  const response = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token(sentry)}`, Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Sentry answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const issues = await response.json();
  if (!Array.isArray(issues)) throw new Error("Sentry's answer is not a list of issues");
  return issues.map((issue) => ({ title: issue.title, link: issue.permalink }));
}

function token({ secret }) {
  if (process.env.SENTRY_READ_TOKEN) return process.env.SENTRY_READ_TOKEN;
  try {
    const value = execFileSync(
      "secret-tool",
      ["lookup", "service", secret.service, "account", secret.account],
      { encoding: "utf8" },
    ).trim();
    if (value) return value;
  } catch {
    // Reported below.
  }
  throw new Error(
    `no Sentry token: set SENTRY_READ_TOKEN or store one in the keyring as ${secret.service}/${secret.account}`,
  );
}
