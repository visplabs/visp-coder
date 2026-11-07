// The Sentry zero-events check (D8). QE journey runs report crashes to the `qe` environment,
// tagged with the task (VISP_SENTRY_TAGS); a run passes only when Sentry holds no such event.
// The count comes from Sentry itself, read-only, never from the agent's report. The token is
// SENTRY_READ_TOKEN (CI) or the keyring entry visp-sdlc/sentry-read (`event:read`,
// `project:read`). SDLC_SENTRY_URL replaces the API host in tests. Any failure to ask Sentry
// throws: the callers fail closed.

import { execFileSync } from "node:child_process";

// Whether any of the task's criteria is a journey, the only runs that report to Sentry.
export function hasJourneyCriteria(acceptance, task) {
  return acceptance.criteria.some((c) => task.criteria.includes(c.id) && c.level === "journey");
}

export async function sentryEventCount(sentry, { task, since, until = new Date() }) {
  const base = process.env.SDLC_SENTRY_URL ?? sentry.url;
  const params = new URLSearchParams({
    field: "count()",
    dataset: "errors",
    query: `project:${sentry.project} environment:${sentry.environment} task:${task}`,
    start: since.toISOString(),
    end: until.toISOString(),
  });
  const response = await fetch(`${base}/api/0/organizations/${sentry.org}/events/?${params}`, {
    headers: { Authorization: `Bearer ${token(sentry)}`, Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Sentry answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const count = (await response.json()).data?.[0]?.["count()"];
  if (!Number.isInteger(count)) throw new Error("Sentry's answer has no event count");
  return count;
}

// Why a qe-verify report may not be filed, or undefined. For a task with journey criteria the
// report must count the Sentry events, the count must match what Sentry holds for the task since
// the run began, and any event makes the verdict a fail. A first count of zero is asked again
// after SDLC_SENTRY_SETTLE_MS (default 30 s), to wait out ingestion.
export async function qeSentryRefusal({ sentry, acceptance, task, body, since }) {
  if (!hasJourneyCriteria(acceptance, task)) return undefined;
  if (!Number.isInteger(body.sentry_events)) {
    return `a task with journey criteria needs sentry_events in the report, counted from runs with VISP_SENTRY_TAGS=task=${task.task}`;
  }
  let count;
  try {
    count = await sentryEventCount(sentry, { task: task.task, since });
    if (count === 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, Number(process.env.SDLC_SENTRY_SETTLE_MS ?? 30_000)),
      );
      count = await sentryEventCount(sentry, { task: task.task, since });
    }
  } catch (error) {
    return `cannot ask Sentry, so the run cannot pass (${error.message}); report this to the manager`;
  }
  if (count === body.sentry_events && (count === 0 || body.verdict === "fail")) return undefined;
  return `Sentry holds ${count} qe events tagged task:${task.task} since this run began; report sentry_events: ${count}${count > 0 ? " and verdict: fail" : ""}`;
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
