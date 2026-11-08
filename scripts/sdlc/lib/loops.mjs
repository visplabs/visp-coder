// Loop bounds and the run budget (sdlc.config.json `loops`, `budget`). A coder turn is a start
// or a SendMessage resume; reviews and QE runs are counted from the reports filed for the task.
// Hooks refuse a turn past a ceiling, and refuse to ship a task (open its PR, write its packet)
// before the minimum rounds are done, the last review approved, and that review saw the head.
// Counters live in .sdlc/run/, which agents cannot write (scope hook).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CODERS } from "./agents.mjs";
import { featureDir, sdlcRoot } from "./paths.mjs";
import { loadArtifacts } from "./spec-store.mjs";

const VERIFY_LEVELS = new Set(["journey", "performance"]);

export function turnRefusal(cwd, config, { feature, task, agentType }) {
  const budget = readJson(budgetPath(cwd, feature));
  const coder = isCoder(agentType);
  if ((budget.agentRuns ?? 0) >= config.budget.agentRunsPerEpic) {
    return `${feature} used its budget of ${config.budget.agentRunsPerEpic} agent runs; ask the owner`;
  }
  if (coder && (budget.coderRuns ?? 0) >= config.budget.coderRunsPerEpic) {
    return `${feature} used its budget of ${config.budget.coderRunsPerEpic} coder runs; ask the owner`;
  }
  const { inner, verify, ci } = config.loops;
  const { reviews, verifies, handoffs } = reports(cwd, feature, task);
  const turns = readJson(turnsPath(cwd, feature, task)).coderTurns ?? 0;
  const ceiling = inner.max + verify.max + ci.max;
  if (coder && turns >= ceiling) {
    return `${task} reached its ceiling of ${ceiling} coder turns; hand it to the owner`;
  }
  // The stop hook files a handoff only after its own test run passed, so a review or QE run
  // started earlier would judge a head with no passing run behind it.
  if (!coder && handoffs.length < turns) {
    return (
      `${task}'s coder has not handed off turn ${turns}: its stop hook is still checking the ` +
      `report or refused it. Start ${agentType} after the coder's "finished" notice; if the ` +
      `coder failed, stop and report to the owner`
    );
  }
  if (agentType === "reviewer" && reviews.length >= inner.max) {
    return `${task} had ${inner.max} review rounds, the inner loop's maximum; hand it to the owner`;
  }
  if (agentType === "qe-verify" && verifies.length >= verify.max) {
    return `${task} had ${verify.max} QE rounds, the verify loop's maximum; hand it to the owner`;
  }
  return undefined;
}

export function recordTurn(cwd, { feature, task, agentType }) {
  const budget = readJson(budgetPath(cwd, feature));
  budget.agentRuns = (budget.agentRuns ?? 0) + 1;
  if (isCoder(agentType)) {
    budget.coderRuns = (budget.coderRuns ?? 0) + 1;
    const turns = readJson(turnsPath(cwd, feature, task));
    writeJson(turnsPath(cwd, feature, task), { coderTurns: (turns.coderTurns ?? 0) + 1 });
  }
  writeJson(budgetPath(cwd, feature), budget);
}

// Why the task may not ship at `head` yet, or undefined.
export function shipRefusal(cwd, config, { feature, task, head, criteriaLevels }) {
  const { inner, verify } = config.loops;
  const { reviews, verifies } = reports(cwd, feature, task);
  if (reviews.length < inner.min) {
    return `${task} had ${reviews.length} review rounds; the inner loop needs at least ${inner.min}`;
  }
  const last = reviews.at(-1);
  if (last.body.verdict !== "approve") return `the last review of ${task} requested changes`;
  if (last.commit !== head) {
    return `the last review of ${task} saw ${last.commit ?? "no commit"}, not the head ${head}; review the fixes`;
  }
  if (!criteriaLevels.some((level) => VERIFY_LEVELS.has(level))) return undefined;
  if (verifies.length < verify.min) {
    return `${task} had ${verifies.length} QE rounds; the verify loop needs at least ${verify.min}`;
  }
  return verifies.at(-1).body.verdict === "pass" ? undefined : `the last QE run of ${task} failed`;
}

function reports(cwd, feature, task) {
  const { artifacts } = loadArtifacts(featureDir(feature, cwd));
  const mine = artifacts.filter((a) => a.task === task && a.status === "done");
  return {
    reviews: mine.filter((a) => a.schema === "review@1"),
    verifies: mine.filter((a) => a.schema === "qe-report@1"),
    handoffs: mine.filter((a) => a.schema === "handoff@1"),
  };
}

function isCoder(agentType) {
  return CODERS.has(agentType);
}

function budgetPath(cwd, feature) {
  return join(sdlcRoot(cwd), "run", "budget", `${feature}.json`);
}

function turnsPath(cwd, feature, task) {
  return join(sdlcRoot(cwd), "run", "loops", feature, `${task}.json`);
}

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
