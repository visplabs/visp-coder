// The retro report for one epic, from the records the pipeline already keeps: the mistake log,
// the agents' state files, the stage reports, the worklog, the loop and budget counters and the
// owner packet's retro notes. It writes nothing and calls no model; the /retro owner command
// reads it and proposes pipeline fixes. Rows logged before mistakes carried their epic are tied
// to it through the agent's state file, a task key in the reason, or a session another of the
// epic's rows came from; rows from tests and the owner's own sessions belong to no epic.

const KEY = /\b[A-Z][A-Z0-9]*-\d+\b/;
// A later round's text that closes a finding: "Fixed.", "Resolved.", "Remains fixed",
// "Both earlier R-1 findings are fixed."
const CLOSED = /^(fixed|resolved|remains fixed|both earlier .* (are )?fixed)/i;

export function renderRetro(inputs) {
  const { feature } = inputs;
  const mine = epicRows(inputs);
  const unowned = unownedCount(inputs);
  const reviews = inputs.artifacts.filter((a) => a.schema === "review@1");
  return [
    `# Retro: ${feature}`,
    "",
    "## Run",
    "",
    ...runLines(inputs, reviews),
    "",
    "## Mistakes by signature",
    "",
    ...orNone(mistakeTable(mine, inputs)),
    "",
    `${unowned} rows belong to no epic (tests, the owner's own sessions); not counted.`,
    "",
    "## Findings carried over rounds",
    "",
    ...orNone(carriedFindings(reviews)),
    "",
    "## Left to the owner",
    "",
    ...orNone(mine.filter((row) => row.hook === "safety").map((row) => leftLine(row, inputs))),
    "",
    "## CI failures",
    "",
    ...orNone(mine.filter((row) => row.hook === "ci").map(ciLine)),
    "",
    "## Retro notes",
    "",
    inputs.notes ?? "No retro notes in the latest owner packet.",
    "",
  ].join("\n");
}

// The rows of this epic: direct, then any row from a session one of them came from.
function epicRows(inputs) {
  const direct = inputs.rows.filter((row) => epicOf(row, inputs) === inputs.feature);
  const sessions = new Set(direct.map((row) => row.session_id).filter(Boolean));
  return inputs.rows.filter(
    (row) =>
      epicOf(row, inputs) === inputs.feature ||
      (!epicOf(row, inputs) && row.session_id && sessions.has(row.session_id)),
  );
}

// Rows tied to no epic, directly or through a session: tests and the owner's own sessions.
function unownedCount(inputs) {
  const sessions = new Set(
    inputs.rows.filter((row) => epicOf(row, inputs)).map((row) => row.session_id),
  );
  return inputs.rows.filter(
    (row) => !epicOf(row, inputs) && !(row.session_id && sessions.has(row.session_id)),
  ).length;
}

function epicOf(row, { states, taskFeature, feature }) {
  if (row.feature) return row.feature;
  const state = row.agent_id ? states[row.agent_id] : undefined;
  if (state?.feature) return state.feature;
  const key = row.task ?? row.reason.match(KEY)?.[0];
  if (key && taskFeature[key]) return taskFeature[key];
  return key === feature ? feature : undefined;
}

function taskOf(row, inputs) {
  const state = row.agent_id ? inputs.states[row.agent_id] : undefined;
  return row.task ?? state?.task ?? row.reason.match(KEY)?.[0] ?? "-";
}

function runLines({ budget, worklog, tasks }, reviews) {
  const failed = worklog.filter((entry) => entry.status === "failed").length;
  const times = worklog.map((entry) => entry.created_at).sort();
  const span = times.length > 0 ? `${times[0]} to ${times.at(-1)}` : "no worklog";
  return [
    `${budget.agentRuns ?? 0} agent runs (${budget.coderRuns ?? 0} coder), ${failed} failed; ${span}.`,
    "",
    ...tasks.map((task) => {
      const rounds = reviews.filter((review) => review.task === task.task).length;
      return `- ${task.task}: ${task.status}, ${task.coderTurns} coder turns, ${rounds} review rounds`;
    }),
  ];
}

function mistakeTable(rows, inputs) {
  const groups = new Map();
  for (const row of rows) {
    const group = groups.get(row.signature) ?? { rows: [], agents: new Set(), tasks: new Set() };
    group.rows.push(row);
    group.agents.add(row.agent_type ?? "owner");
    groups.set(row.signature, group);
  }
  if (groups.size === 0) return [];
  const sorted = [...groups.values()].sort((a, b) => b.rows.length - a.rows.length);
  return [
    "| Count | Hook | Agents | Tasks | Example |",
    "| --- | --- | --- | --- | --- |",
    ...sorted.map((group) => {
      const first = group.rows[0];
      const tasks = [...new Set(group.rows.map((row) => taskOf(row, inputs)))].filter(
        (t) => t !== "-",
      );
      return `| ${group.rows.length} | ${first.hook} | ${[...group.agents].join(", ")} | ${tasks.join(", ") || "-"} | ${cell(first.reason)} |`;
    }),
  ];
}

// A review finding id seen unresolved in two or more rounds of one task, in round order.
function carriedFindings(reviews) {
  const lines = [];
  const byTask = Map.groupBy(reviews, (review) => review.task);
  for (const [task, rounds] of byTask) {
    rounds.sort((a, b) => a.created_at.localeCompare(b.created_at));
    const ids = new Set(rounds.flatMap((round) => round.body.findings.map((f) => f.id)));
    for (const id of ids) {
      const seen = rounds.map((round) => round.body.findings.find((f) => f.id === id));
      const open = seen.filter((finding) => finding && !CLOSED.test(finding.text));
      if (open.length < 2) continue;
      const closedAt = seen.findIndex((finding) => finding && CLOSED.test(finding.text));
      const state = closedAt < 0 ? "still open" : `resolved in round ${closedAt + 1}`;
      lines.push(
        `- ${task} ${id}: unresolved in ${open.length} rounds, ${state}: ${oneLine(open[0].text)}`,
      );
    }
  }
  return lines;
}

function leftLine(row, inputs) {
  return `- ${taskOf(row, inputs)} ${row.agent_type ?? "owner"}: ${row.reason}`;
}

function ciLine(row) {
  const where = [row.commit, row.link].filter(Boolean).join(" ");
  return `- ${row.reason}${where ? ` (${where})` : ""}`;
}

function oneLine(text) {
  const flat = text.split(/\s+/).join(" ");
  const sentence = flat.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? flat;
  return sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence;
}

function cell(text) {
  return oneLine(text).replaceAll("|", "\\|");
}

function orNone(lines) {
  return lines.length > 0 ? lines : ["None."];
}
