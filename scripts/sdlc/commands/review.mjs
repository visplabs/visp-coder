// sdlc review --task VISP-12/VISP-13 --worktree <coder worktree>: one inner-loop review round
// on Codex (sdlc.config.json `reviewer`). Codex gets the blind packet: the owner's words, the
// clauses, criteria and test cases, the commits to review and the earlier rounds' findings, but
// not the coder's report. It runs read-only in the coder's worktree, in the pipeline's own Codex
// home, and must answer in the review schema. The report is written under .sdlc/run/reviews/
// and its path and sha256 printed; the reviewer agent hands those back and the stop hook files
// the report from the file. Exit 3 means Codex failed: the manager runs reviewer-fallback.
// SDLC_CODEX replaces the codex binary in tests.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { stringify } from "yaml";
import { loadTask } from "../lib/agent-task.mjs";
import { TASK_LINE } from "../lib/agents.mjs";
import { loadConfig } from "../lib/config.mjs";
import { renderContract } from "../lib/contract.mjs";
import { featureDir, sdlcRoot, stamp } from "../lib/paths.mjs";
import { REVIEW_OUTPUT_SCHEMA, reviewBody } from "../lib/review-output.mjs";
import { loadArtifacts, loadSpec } from "../lib/spec-store.mjs";

const MAX_CODEX_FAILURES = 2;

export async function run(args) {
  const { values } = parseArgs({
    args,
    options: { task: { type: "string" }, worktree: { type: "string" } },
  });
  const marker = `SDLC-Task: ${values.task ?? ""}`.match(TASK_LINE);
  if (!marker || !values.worktree) {
    throw new Error("usage: sdlc review --task VISP-12/VISP-13 --worktree <coder worktree>");
  }
  const [, feature, task] = marker;
  const worktree = resolve(values.worktree);
  const config = loadConfig(worktree);
  const failures = failureCount(worktree, feature);
  if (failures >= MAX_CODEX_FAILURES) {
    throw new Error(
      `Codex failed ${failures} times in ${feature}; stop the epic and ask the owner`,
    );
  }
  const head = git(worktree, "rev-parse", "HEAD");
  const prompt = packet(worktree, config, { feature, task, head });
  const dir = mkdtempSync(join(tmpdir(), "sdlc-review-"));
  try {
    const answer = runCodex(config.reviewer, worktree, prompt, dir);
    const report = { status: answer.status, commit: head, body: reviewBody(answer.body) };
    const out = join(sdlcRoot(worktree), "run", "reviews", `${task}-${stamp()}.yml`);
    mkdirSync(join(out, ".."), { recursive: true });
    const text = stringify(report);
    writeFileSync(out, text);
    console.log(`review_file: ${out}`);
    console.log(`sha256: ${createHash("sha256").update(text).digest("hex")}`);
    return 0;
  } catch (error) {
    recordFailure(worktree, feature, failures + 1);
    console.error(`sdlc review: Codex failed (${error.message}); run reviewer-fallback`);
    return 3;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The blind packet: what the task must do, which commits to read, what earlier rounds found.
function packet(cwd, config, { feature, task, head }) {
  const spec = loadSpec(join(featureDir(feature, cwd), "spec"));
  const contract = loadTask(cwd, { feature, task });
  const earlier = loadArtifacts(featureDir(feature, cwd)).artifacts.filter(
    (a) => a.task === task && a.schema === "review@1",
  );
  const since =
    earlier.at(-1)?.commit ?? git(cwd, "merge-base", `origin/${config.baseBranch}`, "HEAD");
  const findings = earlier.flatMap((review) => review.body.findings);
  return [
    "You review one task's change, read-only, in this git worktree. Judge it against the",
    "owner's words. You have not seen the coder's reasoning and must not ask for it.",
    `Review the commits ${since}..${head} (\`git diff ${since} ${head}\`), and the whole`,
    "change against its base where you need context. Run tests you need; change nothing.",
    "A finding is blocking only when it cites a clause, a criterion, a rule id or a defect class",
    "and gives a command that shows the problem. Everything else is advisory.",
    "For each earlier finding below, say in a finding of this round whether it is fixed.",
    "",
    renderContract("reviewer", spec, contract),
    "",
    "### Earlier findings",
    "",
    earlierFindings(earlier.length, findings),
  ].join("\n");
}

function earlierFindings(rounds, findings) {
  if (rounds === 0) return "None: this is the first round.";
  return findings.length ? stringify(findings) : `None: ${rounds} earlier round(s) found nothing.`;
}

function runCodex(reviewer, worktree, prompt, dir) {
  const schema = join(dir, "schema.json");
  const out = join(dir, "answer.json");
  writeFileSync(schema, JSON.stringify(REVIEW_OUTPUT_SCHEMA));
  const args = [
    "exec",
    "--strict-config",
    "--ephemeral",
    "--ignore-rules",
    "-m",
    reviewer.model,
    "-c",
    `model_reasoning_effort=${reviewer.effort}`,
    "-s",
    "read-only",
    "--cd",
    worktree,
    "--output-schema",
    schema,
    "-o",
    out,
    prompt,
  ];
  execFileSync(process.env.SDLC_CODEX ?? "codex", args, {
    env: { ...process.env, CODEX_HOME: reviewer.codexHome.replace(/^~(?=\/)/, homedir()) },
    stdio: ["ignore", "ignore", "pipe"],
    timeout: reviewer.timeoutMinutes * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!existsSync(out)) throw new Error("Codex wrote no answer");
  return JSON.parse(readFileSync(out, "utf8"));
}

function failurePath(cwd, feature) {
  return join(sdlcRoot(cwd), "run", "codex-failures", `${feature}.json`);
}

function failureCount(cwd, feature) {
  const path = failurePath(cwd, feature);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).failures : 0;
}

function recordFailure(cwd, feature, failures) {
  mkdirSync(join(failurePath(cwd, feature), ".."), { recursive: true });
  writeFileSync(failurePath(cwd, feature), JSON.stringify({ failures }));
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
