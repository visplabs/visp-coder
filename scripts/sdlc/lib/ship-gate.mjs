// Whether an agent may open the pull request `gh pr create <args>` describes: its body must name
// the task with a "Task: VISP-13" line, and the task must have had its minimum review rounds,
// an approving last review of the head being shipped, and its QE rounds when it has journey or
// performance criteria (loops.mjs).

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { loadConfig } from "./config.mjs";
import { shipRefusal } from "./loops.mjs";
import { sdlcRoot } from "./paths.mjs";

const TASK_LINE = /^Task: ([A-Z][A-Z0-9]*-\d+)\s*$/m;

export function shipGateRefusal(args, cwd) {
  const task = bodyOf(args, cwd).match(TASK_LINE)?.[1];
  if (!task) return 'opens a PR without a "Task: VISP-13" line naming its task';
  const features = join(sdlcRoot(cwd), "features");
  const feature = existsSync(features)
    ? readdirSync(features).find((f) => existsSync(join(features, f, "tasks", task, "task.yml")))
    : undefined;
  if (!feature) return `opens a PR for ${task}, which is not pulled; run "pnpm sdlc pull" first`;
  const read = (path) => parse(readFileSync(join(features, feature, path), "utf8"));
  const contract = read(`tasks/${task}/task.yml`);
  const criteriaLevels = read("spec/acceptance.yml")
    .criteria.filter((criterion) => contract.criteria.includes(criterion.id))
    .map((criterion) => criterion.level);
  const head = revParse(cwd, flag(args, ["--head", "-H"]) ?? "HEAD");
  const reason = shipRefusal(cwd, loadConfig(cwd), { feature, task, head, criteriaLevels });
  return reason ? `opens a PR too early: ${reason}` : undefined;
}

function bodyOf(args, cwd) {
  const file = flag(args, ["--body-file", "-F"]);
  if (file) return file === "-" ? "" : readFileSync(resolve(cwd, file), "utf8");
  return flag(args, ["--body", "-b"]) ?? "";
}

function flag(args, names) {
  for (let i = 0; i < args.length; i++) {
    if (names.includes(args[i])) return args[i + 1];
    const joined = names.find((name) => args[i].startsWith(`${name}=`));
    if (joined) return args[i].slice(joined.length + 1);
  }
  return undefined;
}

function revParse(cwd, ref) {
  try {
    return execFileSync("git", ["rev-parse", ref], { cwd, encoding: "utf8" }).trim();
  } catch {
    return ref;
  }
}
