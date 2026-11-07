// The CI gate for a task pull request. The PR names its Jira task with a "Task: VISP-<n>" line;
// the task's task@1 block names its epic, and its test-links@1 block the tests the stop hook
// checked for its test cases. The gate passes only when the owner approved the epic's
// spec as it stands (approval.mjs: the owner's own unedited comment, newer than the last
// description change, carrying the current hash) and every test case of the task links a test
// that passed. The owner's account id comes from the environment (a repository variable in CI),
// never from the PR's sdlc.config.json. A PR from an agent branch (sdlc/...) must name a task;
// any other PR that names none is skipped, so dependency bumps and outside contributions pass.
// For a task with journey criteria the gate also asks Sentry for qe events (D8).

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkApproval } from "./approval.mjs";
import { loadConfig } from "./config.mjs";
import { ghJson } from "./gh.mjs";
import { specHash } from "./hash.mjs";
import { ownerTextOf } from "./issue-body.mjs";
import { jiraClient } from "./jira.mjs";
import { repoRoot } from "./paths.mjs";
import { hasJourneyCriteria, sentryEventCount } from "./sentry.mjs";
import { specDocuments, taskDocument } from "./spec-store.mjs";
import { applyLinks, linksOf } from "./test-links.mjs";
import { resultsIndex, traceTask } from "./trace.mjs";
import { yamlBlocks } from "./yaml-blocks.mjs";

const TASK_TRAILER = /^Task: ([A-Z][A-Z0-9]*-\d+)\s*$/m;
const AGENT_BRANCH = "sdlc/";
const SENTRY_OVERRIDE = "sdlc-sentry-override";

export async function checkPr(number, { resultsFile, ownerId, cwd = process.cwd() }) {
  const pr = ghJson(["pr", "view", String(number), "--json", "body,commits,headRefName,labels"]);
  const texts = [
    pr.body ?? "",
    ...(pr.commits ?? []).map((c) => `${c.messageHeadline ?? ""}\n${c.messageBody ?? ""}`),
  ];
  const key = texts.map((text) => text.match(TASK_TRAILER)?.[1]).find(Boolean);
  if (!key) return untracked(number, pr.headRefName ?? "");
  if (!ownerId) {
    throw new Error("set SDLC_OWNER_ACCOUNT_ID (a repository variable in CI) to the owner's id");
  }
  const jira = jiraClient(cwd);
  const { task, links } = await readTask(jira, key);
  const epic = await jira.readIssue(task.feature);
  const docs = specDocuments(epic.body ?? "", task.feature);
  const lines = [`PR #${number} delivers ${task.feature}/${task.task}`];
  const problems = await specProblems(jira, epic, docs, ownerId, task.feature);
  const spec = {
    intent: docs["intent@1"],
    acceptance: docs["acceptance@1"],
    testCases: { ...docs["test-cases@1"], cases: applyLinks(docs["test-cases@1"].cases, links) },
  };
  const report = traceTask(spec, task, linkedResults(spec, task, resultsFile, cwd));
  problems.push(
    ...report.problems
      .filter((problem) => problem.severity === "error")
      .map((problem) => `${problem.kind}: ${problem.message}`),
  );
  for (const criterion of report.criteria) lines.push(`${criterion.id} ${criterion.status}`);
  const sentry = await sentryProblem(pr, spec.acceptance, task, cwd);
  if (sentry?.overridden) lines.push(sentry.overridden);
  else if (sentry) problems.push(sentry);
  if (problems.length === 0) return { status: "pass", lines: [...lines, "pass"] };
  return { status: "fail", lines: [...lines, ...problems.map((problem) => `error ${problem}`)] };
}

function untracked(number, branch) {
  if (branch.startsWith(AGENT_BRANCH)) {
    const why = `${branch} is an agent branch; its PR must name its task ("Task: VISP-<n>")`;
    return { status: "fail", lines: [`PR #${number}: ${why}`] };
  }
  return { status: "skipped", lines: [`PR #${number} names no task ("Task: VISP-<n>"); skipped`] };
}

// D8 in CI: for a task with journey criteria, Sentry must hold no qe event tagged with the task
// since the head commit, so a wrong qe-verify count cannot pass. If Sentry cannot be asked the
// gate fails, unless the PR carries the override label.
async function sentryProblem(pr, acceptance, task, cwd) {
  if (!hasJourneyCriteria(acceptance, task)) return undefined;
  const since = new Date(pr.commits?.at(-1)?.committedDate ?? 0);
  try {
    const count = await sentryEventCount(loadConfig(cwd).sentry, { task: task.task, since });
    if (count === 0) return undefined;
    return `Sentry holds ${count} qe event(s) tagged task:${task.task} since the head commit`;
  } catch (error) {
    const problem = `cannot ask Sentry (${error.message})`;
    if (!(pr.labels ?? []).some((label) => label.name === SENTRY_OVERRIDE)) return problem;
    return { overridden: `${problem}; overridden by the ${SENTRY_OVERRIDE} label` };
  }
}

async function readTask(jira, key) {
  const issue = await jira.readIssue(key);
  const block = yamlBlocks(issue.body ?? "").find((doc) => doc.schema === "task@1");
  if (!block) throw new Error(`task ${key} has no task@1 block`);
  const task = taskDocument(issue.body, block.feature, key);
  return { task, links: linksOf(issue.body, task.feature, key).links };
}

async function specProblems(jira, epic, docs, ownerId, feature) {
  if (docs["intent@1"].owner_text.trim() !== (ownerTextOf(epic.body) ?? "").trim()) {
    return ["intent@1 owner_text differs from the owner's words in the epic"];
  }
  const approval = checkApproval({
    feature,
    hash: specHash(docs["intent@1"], docs["acceptance@1"]),
    ownerId,
    comments: await jira.comments(feature),
    bodyChangedAt: await jira.bodyChangedAt(feature),
  });
  if (approval.approved) return [];
  return [`${approval.reason}; the owner runs /approve ${feature} and posts the line it prints`];
}

// Results from --results, or from running the task's linked test files with vitest.
function linkedResults(spec, task, resultsFile, cwd) {
  const root = repoRoot(cwd);
  if (resultsFile) return resultsIndex(JSON.parse(readFileSync(resultsFile, "utf8")), root);
  const files = [
    ...new Set(
      spec.testCases.cases
        .filter((tc) => tc.test && tc.criteria.some((id) => task.criteria.includes(id)))
        .map((tc) => tc.test.split(" > ")[0]),
    ),
  ];
  if (files.length === 0) return new Map();
  const dir = mkdtempSync(join(tmpdir(), "sdlc-results-"));
  try {
    const output = join(dir, "results.json");
    spawnSync(
      "pnpm",
      ["exec", "vitest", "run", ...files, "--reporter=json", `--outputFile=${output}`],
      {
        cwd: root,
        stdio: ["ignore", 2, 2],
      },
    );
    return resultsIndex(JSON.parse(readFileSync(output, "utf8")), root);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
