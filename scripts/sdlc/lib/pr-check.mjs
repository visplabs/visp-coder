// The CI gate for a task pull request. The PR names its task with a "Task: #<n>" line; the task
// sub-issue names its feature. The gate passes only when the owner's newest approval comment is
// unedited, newer than the last edit of the feature issue and carries the hash of the spec as it
// is now, and every test case of the task links a test that passed. A PR that names no task is
// skipped, so dependency bumps and outside contributions are not blocked.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gh, ghJson } from "./gh.mjs";
import { specHash } from "./hash.mjs";
import { ownerTextOf } from "./issue-body.mjs";
import { repoRoot } from "./paths.mjs";
import { specDocuments, taskDocument } from "./spec-store.mjs";
import { resultsIndex, traceTask } from "./trace.mjs";
import { yamlBlocks } from "./yaml-blocks.mjs";

const TASK_TRAILER = /^Task: #(\d+)\s*$/m;
const APPROVAL_MARK = "<!-- sdlc:approval -->";
const FEATURE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      body createdAt lastEditedAt
      comments(last: 100) { nodes { body createdAt lastEditedAt author { login } } }
    }
  }
}`;

export function checkPr(number, { resultsFile, ownerLogin, cwd = process.cwd() }) {
  const pr = ghJson(["pr", "view", String(number), "--json", "body,commits"]);
  const texts = [
    pr.body ?? "",
    ...(pr.commits ?? []).map((c) => `${c.messageHeadline ?? ""}\n${c.messageBody ?? ""}`),
  ];
  const taskNumber = texts.map((text) => text.match(TASK_TRAILER)?.[1]).find(Boolean);
  if (!taskNumber) {
    return { status: "skipped", lines: [`PR #${number} names no task ("Task: #<n>"); skipped`] };
  }
  if (!ownerLogin)
    throw new Error("set SDLC_OWNER_LOGIN (a repository variable in CI) to the owner's login");
  const task = readTask(taskNumber);
  const issue = readFeature(task.feature);
  const docs = specDocuments(issue.body ?? "", task.feature);
  const lines = [`PR #${number} delivers ${task.feature}/${task.task}`];
  const problems = specProblems(issue, docs, ownerLogin, task.feature);
  const spec = {
    intent: docs["intent@1"],
    acceptance: docs["acceptance@1"],
    testCases: docs["test-cases@1"],
  };
  const report = traceTask(spec, task, linkedResults(spec, task, resultsFile, cwd));
  problems.push(
    ...report.problems
      .filter((problem) => problem.severity === "error")
      .map((problem) => `${problem.kind}: ${problem.message}`),
  );
  for (const criterion of report.criteria) lines.push(`${criterion.id} ${criterion.status}`);
  if (problems.length === 0) return { status: "pass", lines: [...lines, "pass"] };
  return { status: "fail", lines: [...lines, ...problems.map((problem) => `error ${problem}`)] };
}

function readTask(number) {
  const issue = ghJson(["issue", "view", number, "--json", "title,body,updatedAt,url"]);
  const block = yamlBlocks(issue.body ?? "").find((doc) => doc.schema === "task@1");
  if (!block) throw new Error(`task issue #${number} has no task@1 block`);
  return taskDocument(issue.body, block.feature, Number(number));
}

function readFeature(feature) {
  const slug =
    process.env.GITHUB_REPOSITORY ??
    ghJson(["repo", "view", "--json", "nameWithOwner"]).nameWithOwner;
  const [owner, name] = slug.split("/");
  const result = JSON.parse(
    gh([
      "api",
      "graphql",
      "-f",
      `query=${FEATURE_QUERY}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-F",
      `number=${feature.slice(2)}`,
    ]),
  );
  const issue = result.data?.repository?.issue;
  if (!issue) throw new Error(`feature issue for ${feature} not found`);
  return issue;
}

function specProblems(issue, docs, ownerLogin, feature) {
  if (docs["intent@1"].owner_text.trim() !== (ownerTextOf(issue.body) ?? "").trim()) {
    return ["intent@1 owner_text differs from the owner's words in the feature issue"];
  }
  const approvals = issue.comments.nodes
    .filter(
      (c) => c.author?.login === ownerLogin && c.body.includes(APPROVAL_MARK) && !c.lastEditedAt,
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const latest = approvals.at(-1);
  if (!latest)
    return [`no approval by ${ownerLogin} on ${feature}: the owner runs /approve ${feature}`];
  const edited = issue.lastEditedAt ?? issue.createdAt;
  if (latest.createdAt < edited) {
    return [
      `the spec was edited after the last approval (${edited}); the owner runs /approve ${feature} again`,
    ];
  }
  const approved = latest.body.match(/Spec hash: `([0-9a-f]{64})`/)?.[1];
  const hash = specHash(docs["intent@1"], docs["acceptance@1"]);
  if (approved !== hash) {
    return [
      `the spec hash ${hash.slice(0, 12)} does not match the approved hash ${String(approved).slice(0, 12)}`,
    ];
  }
  return [];
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
