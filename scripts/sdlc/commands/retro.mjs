// sdlc retro VISP-12: prints the epic's retro report (lib/retro.mjs) from the local records:
// .sdlc/mistakes.jsonl, the agents' state files, the stage reports and owner packets under
// .sdlc/features/VISP-12/, the worklog and the loop and budget counters. Read-only; the /retro
// owner command turns it into proposed pipeline fixes.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { loadConfig } from "../lib/config.mjs";
import { featureDir, parseFeature, sdlcRoot } from "../lib/paths.mjs";
import { renderRetro } from "../lib/retro.mjs";
import { loadArtifacts } from "../lib/spec-store.mjs";

const STATUS_NAMES = {
  todo: "To Do",
  ready: "Ready",
  inProgress: "In Progress",
  inReview: "In Review",
  done: "Done",
};

export function run(args) {
  const feature = parseFeature(args[0]);
  const root = sdlcRoot();
  const dir = featureDir(feature);
  if (!existsSync(dir))
    throw new Error(`${feature} is not pulled; run "pnpm sdlc pull ${feature}"`);
  const report = renderRetro({
    feature,
    rows: readRows(join(root, "mistakes.jsonl")),
    states: readStates(join(root, "run", "agents")),
    taskFeature: taskFeatures(join(root, "features")),
    tasks: readTasks(root, dir, feature, loadConfig().jira.statuses),
    artifacts: loadArtifacts(dir).artifacts,
    worklog: readWorklog(join(root, "worklog"), feature),
    budget: readJson(join(root, "run", "budget", `${feature}.json`)),
    notes: latestNotes(dir),
  });
  console.log(report);
  return 0;
}

function readRows(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function readStates(dir) {
  const states = {};
  for (const name of list(dir).filter((n) => n.endsWith(".json"))) {
    states[name.replace(/\.json$/, "")] = readJson(join(dir, name));
  }
  return states;
}

function taskFeatures(featuresDir) {
  const map = {};
  for (const feature of list(featuresDir)) {
    for (const task of list(join(featuresDir, feature, "tasks"))) map[task] = feature;
  }
  return map;
}

function readTasks(root, dir, feature, statuses) {
  const tasksDir = join(dir, "tasks");
  return list(tasksDir)
    .filter((task) => existsSync(join(tasksDir, task, "ticket.yml")))
    .sort()
    .map((task) => {
      const ticket = parse(readFileSync(join(tasksDir, task, "ticket.yml"), "utf8"));
      const name = Object.keys(statuses).find((key) => statuses[key] === ticket.status);
      const turns = readJson(join(root, "run", "loops", feature, `${task}.json`));
      return {
        task,
        status: STATUS_NAMES[name] ?? ticket.status,
        coderTurns: turns.coderTurns ?? 0,
      };
    });
}

function readWorklog(dir, feature) {
  return list(dir).flatMap((day) =>
    list(join(dir, day))
      .filter((name) => name.endsWith(".yml"))
      .map((name) => parse(readFileSync(join(dir, day, name), "utf8")))
      .filter((entry) => entry?.feature === feature),
  );
}

// The "Retro notes" section of the newest owner packet, or undefined when it has none.
function latestNotes(dir) {
  const packets = list(dir)
    .filter((name) => /^owner-packet-.*\.md$/.test(name))
    .sort();
  if (packets.length === 0) return undefined;
  const text = readFileSync(join(dir, packets.at(-1)), "utf8");
  const start = text.indexOf("## Retro notes\n");
  if (start < 0) return undefined;
  const rest = text.slice(start + "## Retro notes\n".length);
  const end = rest.indexOf("\n## ");
  return (end < 0 ? rest : rest.slice(0, end)).trim() || undefined;
}

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

function list(dir) {
  return existsSync(dir) ? readdirSync(dir) : [];
}
