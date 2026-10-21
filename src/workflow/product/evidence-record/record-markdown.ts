import type {
  CheckEvidence,
  EvidenceChanges,
  EvidenceCost,
  EvidenceFile,
  EvidenceGap,
  EvidenceRecord,
  EvidenceRegressions,
  RequirementEvidence,
} from "./record-types.js";

const GAPS_SHOWN = 15;
const FILES_SHOWN = 12;
const REQUEST_LINES_SHOWN = 12;

/**
 * The record as one page a reviewer can paste into a pull request: what is not verified
 * first, then the request, the evidence per requirement, the change, regressions and cost.
 */
export function renderEvidenceRecord(record: EvidenceRecord, title?: string): string {
  return [
    `# Evidence record${title ? `: ${title}` : ""}`,
    "",
    headline(record),
    "",
    ...notVerifiedSection(record),
    ...askedSection(record),
    ...doneSection(record),
    ...changedSection(record.changed),
    ...regressionsSection(record.regressions),
    ...costSection(record.cost),
    ...outsideAccessSection(record),
    "## Next",
    "",
    record.next.objective,
    ...(record.next.command ? ["", `\`${record.next.command}\``] : []),
    "",
    `Detail: \`visp pr --full --feature ${record.feature}\` adds the full handoff document; \`--json\` gives this record as data; \`visp ui\` shows it under Evidence; raw records are in \`.visp/features/${record.feature}/\`.`,
    "",
  ].join("\n");
}

function headline(record: EvidenceRecord): string {
  const { summary } = record;
  const parts = [
    `\`${record.feature}\` (${record.lifecycle})`,
    `${summary.verified} of ${summary.requirements} requirement${summary.requirements === 1 ? "" : "s"} shown by checks VISP ran on this version`,
    ...(summary.judged ? [`${summary.judged} by a reviewer's judgment only`] : []),
    `${summary.gaps} item${summary.gaps === 1 ? "" : "s"} not verified`,
  ];
  return `${parts.join(" · ")}.`;
}

function notVerifiedSection(record: EvidenceRecord): string[] {
  const gaps = record.notVerified;
  if (!gaps.length)
    return ["## Not verified", "", "Nothing: every requirement has current executed evidence.", ""];
  const hidden = gaps.length - GAPS_SHOWN;
  return [
    `## Not verified (${gaps.length})`,
    "",
    ...gaps
      .slice(0, GAPS_SHOWN)
      .map((gap) => `- ${gap.severity === "blocking" ? "**Blocking:** " : ""}${gapText(gap)}`),
    ...(hidden > 0 ? [`- ${hidden} more in \`visp pr --json\``] : []),
    "",
  ];
}

/** A requirement's id leads its line in bold; a finding's id trails it for reference. */
function gapText(gap: EvidenceGap): string {
  const text = cell(gap.text);
  if (gap.kind === "finding" && gap.ref) return `${text} (\`${gap.ref}\`)`;
  if (gap.ref && text.startsWith(`${gap.ref} `))
    return `**${gap.ref}**${text.slice(gap.ref.length)}`;
  return text;
}

function askedSection(record: EvidenceRecord): string[] {
  const { asked } = record;
  return [
    "## Asked",
    "",
    ...requestLines(asked.request),
    "",
    ...asked.requirements.map(
      (requirement) =>
        `- **${requirement.id}** (${requirement.priority}) ${cell(requirement.statement)}${requirement.provenance === "user-stated" ? "" : ` _(${requirement.provenance})_`}`,
    ),
    ...(asked.intentChanges.length
      ? [
          "",
          `Intent changed after the request ${asked.intentChanges.length} time${asked.intentChanges.length === 1 ? "" : "s"}:`,
          ...asked.intentChanges.map(
            (change) => `- ${change.at} (${change.provenance}): ${cell(change.reason)}`,
          ),
        ]
      : []),
    "",
  ];
}

/** A long request is folded so the page stays about one screen; it is still verbatim. */
function requestLines(request: string): string[] {
  const quoted = request.split("\n").map((line) => `> ${line}`.trimEnd());
  if (quoted.length <= REQUEST_LINES_SHOWN) return quoted;
  return [
    `<details><summary>The request (${quoted.length} lines)</summary>`,
    "",
    ...quoted,
    "",
    "</details>",
  ];
}

function doneSection(record: EvidenceRecord): string[] {
  const rows = [
    ...record.done.flatMap(requirementRows),
    ...record.suites.map((check) =>
      checkRow(check.author === "independent-tester" ? "whole request" : "no requirement", check),
    ),
  ];
  return [
    "## Done",
    "",
    "| Requirement | Evidence | Result | Rerun |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    "Results are commands VISP ran. `stale` runs were on an earlier version and show nothing about this one. Reviewer verdicts are a model's judgment, not a run.",
    "",
  ];
}

function requirementRows(entry: RequirementEvidence): string[] {
  const review = reviewPhrase(entry);
  if (!entry.checks.length)
    return [`| ${entry.requirement} | no executed check | ${review ?? "not verified"} | — |`];
  return [
    ...entry.checks.map((check) => checkRow(entry.requirement, check)),
    ...(review ? [`| ${entry.requirement} | review | ${review} | — |`] : []),
  ];
}

function reviewPhrase(entry: RequirementEvidence): string | undefined {
  if (entry.review.status === "unassessed") return undefined;
  return `judged ${entry.review.status} by ${entry.review.reviewer ?? "an unattributed review"} (model)`;
}

function checkRow(requirement: string, check: CheckEvidence): string {
  const author = check.author === "independent-tester" ? "independent tests" : "worker's check";
  return `| ${requirement} | ${check.check} (${author}) | ${resultCell(check)} | \`${cell(check.command).replaceAll("`", "'")}\` |`;
}

function resultCell(check: CheckEvidence): string {
  const notes = [
    ...(check.exercisesBehavior ? [] : ["inspects source only"]),
    ...(check.failsWithoutChange === false ? ["also passes without the change"] : []),
  ];
  const result =
    check.result === "stale"
      ? `stale: last ran ${check.ranAt} on an earlier version`
      : check.result === "not-run"
        ? "not run"
        : `${check.result === "passed" ? "passed" : `**${check.result}**`} (exit ${check.exitCode}, ${check.ranAt})`;
  return notes.length ? `${result}; ${notes.join("; ")}` : result;
}

function changedSection(changed: EvidenceChanges): string[] {
  if (!changed.available)
    return ["## Changed", "", `The diff is unavailable: ${cell(changed.note ?? "git failed")}`, ""];
  const range = `from \`${changed.base?.ref}\` (${baseWords(changed.base?.how)}) to ${changed.end === "working-tree" ? "the working tree" : "the feature's last commit"}`;
  const hidden = changed.files.length - FILES_SHOWN + changed.omittedFiles;
  const { scope } = changed;
  return [
    "## Changed",
    "",
    changed.totals.files
      ? `${changed.totals.files} file${changed.totals.files === 1 ? "" : "s"}, +${changed.totals.added} −${changed.totals.removed}, ${range}.`
      : `No source files changed ${range}.`,
    ...(changed.files.length ? [""] : []),
    ...changed.files
      .slice(0, FILES_SHOWN)
      .map(
        (file) =>
          `- ${file.status} \`${file.path}\` ${file.binary ? "(binary)" : `+${file.added} −${file.removed}`}${fileNote(file)}`,
      ),
    ...(hidden > 0 ? [`- ${hidden} more in \`visp ui\` (Map) or \`visp pr --json\``] : []),
    ...(changed.hiddenFiles
      ? [`- ${changed.hiddenFiles} secret, blocked or instruction files not listed`]
      : []),
    "",
    `Scope declared: ${scope.declared.map((slice) => `${slice.slice} may edit ${slice.allowed.map((path) => `\`${path}\``).join(", ") || "nothing"}`).join("; ") || "none"}. Touched outside it: ${scope.outside.length ? scope.outside.map((path) => `\`${path}\``).join(", ") : "nothing"}.${scope.overrides.length ? ` Rule overrides: ${scope.overrides.map((entry) => `${entry.rule} (${cell(entry.reason)})`).join("; ")}.` : ""} Edits the hooks refused are not recorded.`,
    "",
  ];
}

function fileNote(file: EvidenceFile): string {
  if (file.origin === "independent-tests") return " — VISP's independent tests";
  if (file.origin === "earlier-work") return " — earlier work, unchanged by this feature";
  return file.slices.length ? ` (${file.slices.join(", ")})` : " — **outside every slice's scope**";
}

function baseWords(how: string | undefined): string {
  if (how === "feature-start") return "before the feature's first commit";
  if (how === "explicit") return "the requested base";
  if (how === "empty-tree") return "an empty tree";
  return "the current commit";
}

function regressionsSection(gate: EvidenceRegressions): string[] {
  return ["## Regressions", "", ...regressionLines(gate), ""];
}

function regressionLines(gate: EvidenceRegressions): string[] {
  if (gate.status === "not-run")
    return [
      gate.mode === "off"
        ? "Not run: `workflow.regressionGate` is off."
        : "Not run yet on this feature.",
    ];
  if (gate.status === "stale")
    return ["Ran on an earlier version of the product only; it shows nothing about this one."];
  const verdict = { clear: "Clear", regression: "**Regression**", unchecked: "Unchecked" }[
    gate.status
  ];
  const selection = gate.selection
    ? ` (${gate.selection.linked} linked to the change, ${gate.selection.earlierWork} from earlier features, ${gate.selection.unlinked} unlinked)`
    : "";
  return [
    `${verdict} (${gate.mode} mode): ${plural(gate.commands ?? 0, "command")}${selection}.`,
    ...gate.regressions.map((line) => `- Regression: ${cell(line)}`),
    ...gate.unchecked.map((line) => `- Unchecked: ${cell(line)}`),
    ...(gate.preExisting ? [`- ${plural(gate.preExisting, "failure")} also on the old code`] : []),
    ...(gate.leftOut ? [`- ${gate.leftOut} candidate commands left out`] : []),
  ];
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function costSection(cost: EvidenceCost): string[] {
  const calls = cost.modelCalls;
  return [
    "## Cost",
    "",
    `- Time: ${duration(cost.elapsedMs)} from \`visp feature\` to the last record; checks ran ${duration(cost.checkTimeMs)} over ${cost.checkRuns} run${cost.checkRuns === 1 ? "" : "s"}${cost.regressionGateMs === undefined ? "" : `; regression gate ${duration(cost.regressionGateMs)}`}.`,
    `- Model calls: ${calls.reviewsRecorded} independent review${calls.reviewsRecorded === 1 ? "" : "s"} recorded, ${calls.reviewerLaunched} reviewer call${calls.reviewerLaunched === 1 ? "" : "s"} launched by VISP, ${calls.testerSessions} tester session${calls.testerSessions === 1 ? "" : "s"}; worker calls not measured.${cost.models.length ? ` Models: ${cost.models.join(", ")}.` : ""}`,
    "",
  ];
}

/** Reviewer web searches are monitored, so each one is listed; tester commands are counted. */
function outsideAccessSection(record: EvidenceRecord): string[] {
  const { webSearches, testerNetworkCommands } = record.outsideAccess;
  if (!webSearches.length && !testerNetworkCommands) return [];
  return [
    "## Outside access",
    "",
    ...webSearches.map((entry) => `- Reviewer web search, ${entry.at}: ${cell(entry.query)}`),
    ...(testerNetworkCommands
      ? [
          `- The independent tester ran ${testerNetworkCommands} command${testerNetworkCommands === 1 ? "" : "s"} with network access in a disposable copy; \`visp pr --full\` lists them.`,
        ]
      : []),
    "",
  ];
}

function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${Math.round(seconds % 60)} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function cell(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}
