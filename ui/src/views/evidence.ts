import type { EvidenceRecord, UiEvidence, UiFeature } from "../../../src/ui/contract.js";
import { h, icon } from "../dom.js";
import { duration, plural, relativeTime, type Tone } from "../format.js";
import type { Actions, AppState } from "../state.js";
import { cardHead, command, empty, pill, resource } from "./parts.js";

type EvidenceGap = EvidenceRecord["notVerified"][number];
type RequirementEvidence = EvidenceRecord["done"][number];
type CheckEvidence = EvidenceRecord["suites"][number];

/**
 * The record `visp pr` prints, laid out for reading: what is not verified first. The page
 * only formats it; every status comes from the server's record.
 */
export function evidencePanel(feature: UiFeature, state: AppState, actions: Actions): Node {
  return resource(state.evidence[feature.id], "Reading the evidence", actions, (evidence) =>
    evidenceContent(feature, evidence, actions),
  );
}

function evidenceContent(feature: UiFeature, evidence: UiEvidence, actions: Actions): HTMLElement {
  const { record } = evidence;
  return h(
    "div",
    { class: "evidence" },
    summaryCard(record, evidence.markdown, actions),
    gapsCard(record),
    askedCard(record),
    doneCard(record, actions),
    h(
      "div",
      { class: "columns" },
      h("div", { class: "column-list" }, changedCard(feature, record)),
      h("aside", { class: "column-side" }, sideCard(record)),
    ),
  );
}

function summaryCard(record: EvidenceRecord, markdown: string, actions: Actions): HTMLElement {
  const copy = h("button", { class: "button", type: "button" }, icon("copy"), "Copy Markdown");
  copy.addEventListener("click", () => actions.copy(markdown, copy));
  const { summary } = record;
  const blocking = record.notVerified.filter((gap) => gap.severity === "blocking").length;
  return h(
    "section",
    { class: "card", "aria-labelledby": "evidence-title" },
    cardHead(
      "evidence-title",
      "Evidence record",
      "What visp pr prints for the pull request. Passed means VISP ran it on this version; a reviewer's verdict is a model's judgment.",
      copy,
    ),
    h(
      "div",
      { class: "card-body evidence-summary" },
      pill(
        summary.verified === summary.requirements ? "good" : "neutral",
        `${summary.verified} of ${plural(summary.requirements, "requirement")} shown by a run`,
      ),
      summary.judged ? pill("warn", `${summary.judged} judged only`) : null,
      pill(
        blocking ? "bad" : summary.gaps ? "warn" : "good",
        summary.gaps ? `${summary.gaps} not verified` : "Nothing unverified",
      ),
    ),
  );
}

function gapsCard(record: EvidenceRecord): HTMLElement {
  const gaps = record.notVerified;
  return h(
    "section",
    { class: "card", "aria-labelledby": "evidence-gaps" },
    cardHead(
      "evidence-gaps",
      "Not verified",
      "Nothing here is proven. Blocking items first.",
      h("span", { class: "card-count" }, h("strong", null, String(gaps.length))),
    ),
    h(
      "div",
      { class: "card-body" },
      gaps.length
        ? h("ul", { class: "gap-list" }, gaps.map(gapItem))
        : empty("Nothing left unverified", "Every requirement has current executed evidence."),
    ),
  );
}

function gapItem(gap: EvidenceGap): HTMLElement {
  return h(
    "li",
    { class: `gap gap-${gap.severity}` },
    pill(
      gap.severity === "blocking" ? "bad" : "warn",
      gap.severity === "blocking" ? "Blocking" : "Attention",
    ),
    h("span", null, gap.text),
  );
}

function askedCard(record: EvidenceRecord): HTMLElement {
  const { asked } = record;
  return h(
    "section",
    { class: "card", "aria-labelledby": "evidence-asked" },
    cardHead("evidence-asked", "Asked", "The request as the user wrote it, and its requirements."),
    h(
      "div",
      { class: "card-body evidence-asked" },
      h("blockquote", { class: "original-request" }, asked.request),
      h(
        "ul",
        { class: "plain-list" },
        asked.requirements.map((requirement) =>
          h(
            "li",
            null,
            h("span", { class: "mono strong" }, requirement.id),
            " ",
            h("span", { class: "chip" }, requirement.priority),
            " ",
            requirement.statement,
          ),
        ),
      ),
      asked.intentChanges.length
        ? h(
            "div",
            null,
            h("p", { class: "muted" }, "Intent changed after the request:"),
            h(
              "ul",
              { class: "plain-list" },
              asked.intentChanges.map((change) =>
                h(
                  "li",
                  null,
                  `${relativeTime(change.at)} (${change.provenance}): ${change.reason}`,
                ),
              ),
            ),
          )
        : null,
    ),
  );
}

function doneCard(record: EvidenceRecord, actions: Actions): HTMLElement {
  const rows = [
    ...record.done.flatMap((entry) => requirementRows(entry, actions)),
    ...record.suites.map((check) =>
      checkRow(
        check.author === "independent-tester" ? "Whole request" : "No requirement",
        check,
        actions,
      ),
    ),
  ];
  return h(
    "section",
    { class: "card", "aria-labelledby": "evidence-done" },
    cardHead(
      "evidence-done",
      "Done",
      "Each requirement, the check that shows it and its latest run. Stale runs were on an earlier version.",
    ),
    h(
      "div",
      { class: "table-scroll" },
      h(
        "table",
        { class: "matrix evidence-table" },
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            h("th", { scope: "col" }, "Requirement"),
            h("th", { scope: "col" }, "Evidence"),
            h("th", { scope: "col" }, "Result"),
            h("th", { scope: "col" }, "Rerun"),
          ),
        ),
        h("tbody", null, rows),
      ),
    ),
  );
}

function requirementRows(entry: RequirementEvidence, actions: Actions): HTMLElement[] {
  const review =
    entry.review.status === "unassessed"
      ? undefined
      : `Judged ${entry.review.status} by ${entry.review.reviewer ?? "an unattributed review"} (model)`;
  const reviewTone: Tone =
    entry.review.status === "satisfied"
      ? "good"
      : entry.review.status === "failed"
        ? "bad"
        : "warn";
  if (!entry.checks.length)
    return [
      h(
        "tr",
        null,
        h("th", { scope: "row", class: "mono" }, entry.requirement),
        h("td", null, "No executed check"),
        h("td", null, review ? pill(reviewTone, review) : pill("bad", "Not verified")),
        h("td", null, "—"),
      ),
    ];
  return [
    ...entry.checks.map((check) => checkRow(entry.requirement, check, actions)),
    ...(review
      ? [
          h(
            "tr",
            null,
            h("th", { scope: "row", class: "mono" }, entry.requirement),
            h("td", null, "Reviewer"),
            h("td", null, pill(reviewTone, review)),
            h("td", null, "—"),
          ),
        ]
      : []),
  ];
}

const RESULT: Record<CheckEvidence["result"], { word: string; tone: Tone }> = {
  passed: { word: "Passed", tone: "good" },
  failed: { word: "Failed", tone: "bad" },
  "timed-out": { word: "Timed out", tone: "bad" },
  "environment-failed": { word: "Could not run", tone: "warn" },
  stale: { word: "Stale", tone: "neutral" },
  "not-run": { word: "Not run", tone: "neutral" },
};

function checkRow(requirement: string, check: CheckEvidence, actions: Actions): HTMLElement {
  const result = RESULT[check.result];
  const notes = [
    check.result === "stale" ? `last ran ${relativeTime(check.ranAt)} on an earlier version` : "",
    check.ranAt && check.result !== "stale" && check.result !== "not-run"
      ? `exit ${check.exitCode}, ${relativeTime(check.ranAt)}`
      : "",
    check.exercisesBehavior ? "" : "inspects source only",
    check.failsWithoutChange === false ? "also passes without the change" : "",
  ].filter(Boolean);
  return h(
    "tr",
    null,
    h("th", { scope: "row", class: "mono" }, requirement),
    h(
      "td",
      null,
      h("span", { class: "mono strong" }, check.check),
      h(
        "span",
        { class: "muted" },
        check.author === "independent-tester" ? " independent tests" : " worker's check",
      ),
    ),
    h(
      "td",
      null,
      pill(result.tone, result.word),
      notes.length ? h("p", { class: "muted evidence-note" }, notes.join("; ")) : null,
    ),
    h("td", null, command(check.command, actions)),
  );
}

function changedCard(feature: UiFeature, record: EvidenceRecord): HTMLElement {
  const { changed } = record;
  const map = `#/f/${encodeURIComponent(feature.id)}/map`;
  return h(
    "section",
    { class: "card", "aria-labelledby": "evidence-changed" },
    cardHead(
      "evidence-changed",
      "Changed",
      changed.available
        ? `${plural(changed.totals.files, "file")}, +${changed.totals.added} −${changed.totals.removed}, from ${changed.base?.ref ?? "the start"} to ${changed.end === "working-tree" ? "the working tree" : "the feature's last commit"}.`
        : `The diff is unavailable: ${changed.note ?? "git failed"}`,
      h("a", { class: "text-link", href: map }, "Open in Map"),
    ),
    h(
      "div",
      { class: "card-body evidence-changed" },
      changed.files.length
        ? h(
            "ul",
            { class: "file-list" },
            changed.files.map((file) =>
              h(
                "li",
                null,
                h("span", { class: "path" }, file.path),
                h(
                  "span",
                  { class: "muted mono" },
                  file.binary ? " binary" : ` +${file.added} −${file.removed}`,
                ),
                " ",
                file.origin === "independent-tests"
                  ? pill("neutral", "VISP's independent tests")
                  : file.origin === "earlier-work"
                    ? pill("neutral", "earlier work")
                    : file.slices.length
                      ? h("span", { class: "chip" }, file.slices.join(", "))
                      : pill("bad", "outside every slice's scope"),
              ),
            ),
          )
        : changed.available
          ? empty("No source files changed", "The diff is empty.")
          : null,
      h(
        "dl",
        { class: "facts" },
        changed.scope.declared.map((slice) =>
          h(
            "div",
            null,
            h("dt", { class: "mono" }, slice.slice),
            h("dd", null, `may edit ${slice.allowed.join(", ") || "nothing"}`),
          ),
        ),
        h(
          "div",
          null,
          h("dt", null, "Refused"),
          h("dd", null, "Edits the hooks refused are not recorded yet."),
        ),
      ),
    ),
  );
}

function sideCard(record: EvidenceRecord): HTMLElement {
  const { regressions, cost, outsideAccess } = record;
  const calls = cost.modelCalls;
  return h(
    "section",
    { class: "card side-card", "aria-labelledby": "evidence-side" },
    h("h2", { class: "side-title", id: "evidence-side" }, "Regressions and cost"),
    h(
      "dl",
      { class: "facts" },
      fact("Regressions", regressionWords(record)),
      ...regressions.regressions.map((line) => fact("Regressed", line)),
      ...regressions.unchecked.map((line) => fact("Unchecked", line)),
      fact("Time", `${duration(cost.elapsedMs)} from visp feature to the last record`),
      fact("Checks", `${plural(cost.checkRuns, "run")}, ${duration(cost.checkTimeMs)}`),
      fact(
        "Models",
        `${plural(calls.reviewsRecorded, "review")} recorded, ${plural(calls.reviewerLaunched, "reviewer call")} launched by VISP, ${plural(calls.testerSessions, "tester session")}; worker calls not measured${cost.models.length ? ` (${cost.models.join(", ")})` : ""}`,
      ),
      ...outsideAccess.webSearches.map((entry) => fact("Web search", entry.query)),
      outsideAccess.testerNetworkCommands
        ? fact(
            "Network",
            `${plural(outsideAccess.testerNetworkCommands, "tester command")} with network access`,
          )
        : null,
    ),
  );
}

function regressionWords(record: EvidenceRecord): string {
  const gate = record.regressions;
  if (gate.status === "not-run")
    return gate.mode === "off" ? "Not run: the regression gate is off" : "Not run yet";
  if (gate.status === "stale") return "Ran only on an earlier version";
  return `${gate.status === "clear" ? "Clear" : gate.status === "regression" ? "Regression" : "Unchecked"} (${gate.mode}), ${plural(gate.commands ?? 0, "command")}`;
}

function fact(term: string, value: string): HTMLElement {
  return h("div", null, h("dt", null, term), h("dd", null, value));
}
