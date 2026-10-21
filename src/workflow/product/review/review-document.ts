import { workingTreeChanges } from "../../../core/git.js";
import type { WorkspaceState } from "../../state.js";
import type { ProductOutcomeStatus } from "../assessment.js";
import { pinnedAcceptanceChecks } from "../check/acceptance-checks.js";
import { REVIEWER_ACTIVITY_FILE } from "../critic/critic-exec.js";
import { outstandingFeedback } from "../findings.js";
import { unchangedInheritedPaths } from "../inherited-changes.js";
import { checksFor, latestExecutionsByOwner, type ProductExecution } from "../model.js";
import type { ProductNext } from "../status.js";
import type { ProductRecord } from "../store.js";
import type { IndependentTestsRecord } from "../tester/independent-tests-model.js";
import { readTestsRecord } from "../tester/independent-tests-record.js";
import { TESTER_ACTIVITY_FILE, testerNetworkCommands } from "../tester/tester-activity.js";
import { unobservedGoalRounds } from "../unobserved-goals.js";

/**
 * One document a human reviewer can act on: the request, what was promised, what changed,
 * what actually ran, what independent review found and what is still open. It is built
 * from recorded state; nothing in it is the actor's own summary.
 */
export async function productReviewDocument(
  workspace: WorkspaceState,
  record: ProductRecord,
  outcomes: readonly ProductOutcomeStatus[],
  next: ProductNext,
): Promise<string> {
  const { brief, state } = record;
  const tests = await readTestsRecord(workspace, brief.feature);
  const activity = await reviewerActivity(workspace, brief.feature);
  const testerCommands = await testerNetworkCommands(workspace, brief.feature);
  return [
    `# ${title(brief.goal)}`,
    "",
    `Status: ${state.status}. ${verdict(outcomes)}`,
    "",
    "## Request",
    "",
    ...brief.originalRequest.split("\n").map((line) => `> ${line}`),
    "",
    ...outcomeSection(outcomes, record),
    ...decisionSection(record),
    ...(await changeSection(workspace, record)),
    ...checkSection(record),
    ...unverifiedSection(record),
    ...acceptanceSection(tests.ok ? tests.value : undefined),
    ...intentSection(record),
    ...reviewSection(record),
    ...internetSection(activity),
    ...testerSection(testerCommands, brief.feature),
    "## Next",
    "",
    next.objective,
    ...(next.command ? ["", `\`${next.command}\``] : []),
    "",
    "Check results come from commands VISP executed. Review judgments are attributed to their reviewer; the actor's own claims are not evidence.",
    "",
  ].join("\n");
}

/** A goal copied from a long request would otherwise become a multi-paragraph heading. */
function title(goal: string): string {
  const first = goal.split("\n").find((line) => line.trim()) ?? goal;
  return first.length > 100 ? `${first.slice(0, 99).trimEnd()}…` : first.trim();
}

function verdict(outcomes: readonly ProductOutcomeStatus[]): string {
  const open = outcomes.filter((outcome) => outcome.priority === "must" && !outcome.satisfied);
  return open.length
    ? `${open.length} required outcome${open.length === 1 ? "" : "s"} still open: ${open.map((outcome) => outcome.id).join(", ")}.`
    : "Every required outcome is satisfied.";
}

function outcomeSection(outcomes: readonly ProductOutcomeStatus[], record: ProductRecord) {
  return [
    "## Outcomes",
    "",
    "| Outcome | Priority | Statement | Checks | Behavior | Review |",
    "| --- | --- | --- | --- | --- | --- |",
    ...outcomes.map((outcome) => {
      const checks = record.brief.checks
        .filter((check) => check.outcomes.includes(outcome.id))
        .map((check) => check.id);
      return `| ${outcome.id} | ${outcome.priority} | ${cell(outcome.statement)} | ${checks.join(", ") || "none"} | ${outcome.behavior} | ${outcome.review} |`;
    }),
    "",
  ];
}

function decisionSection(record: ProductRecord) {
  if (!record.brief.decisions.length) return [];
  return [
    "## Decisions",
    "",
    ...record.brief.decisions.map(
      (decision) =>
        `- **${decision.id}** ${decision.statement}${decision.rationale ? ` — ${decision.rationale}` : ""}`,
    ),
    "",
  ];
}

/** Uncommitted work is what an agent run usually leaves for review. */
async function changeSection(workspace: WorkspaceState, record: ProductRecord) {
  const changes = await workingTreeChanges(workspace.paths.root);
  const inherited = await unchangedInheritedPaths(workspace, record.brief.feature);
  const all = changes.ok
    ? changes.value.files.filter((file) => !file.path.startsWith(".visp/"))
    : [];
  const files = all.filter((file) => !inherited.has(file.path));
  const earlier = all.filter((file) => inherited.has(file.path));
  const scope = record.brief.slices.map(
    (slice) =>
      `- **${slice.id}** ${slice.goal} (${record.state.slices[slice.id]?.status ?? "pending"}; may edit ${slice.scope.allowed.join(", ")})`,
  );
  return [
    "## Changes",
    "",
    ...scope,
    "",
    ...(changes.ok
      ? files.length
        ? ["Uncommitted changes:", "", ...files.map((file) => `- ${file.status}: ${file.path}`)]
        : ["No uncommitted changes; review the commits for this feature."]
      : ["Changed files are unavailable: git status failed."]),
    ...(earlier.length
      ? [
          "",
          "Uncommitted before this feature started, unchanged since:",
          "",
          ...earlier.map((file) => `- ${file.status}: ${file.path}`),
        ]
      : []),
    "",
  ];
}

function checkSection(record: ProductRecord) {
  const checks = [...checksFor(record.brief), ...pinnedAcceptanceChecks(record.brief)];
  if (!checks.length) return ["## Checks", "", "No checks are declared.", ""];
  const latest = new Map<string, ProductExecution>();
  for (const execution of latestExecutionsByOwner(record.state.executions))
    latest.set(execution.check, execution);
  return [
    "## Checks",
    "",
    "| Check | Command | Latest result |",
    "| --- | --- | --- |",
    ...checks.map((check) => {
      const execution = latest.get(check.id);
      const result = execution
        ? `${execution.status} (exit ${execution.exitCode}, ${execution.createdAt})`
        : "not run";
      return `| ${check.id} | \`${cell(commandText(check.command))}\` | ${result} |`;
    }),
    "",
  ];
}

/** Goals the tester never observed stay unverified; one repair round is all VISP asks for. */
function unverifiedSection(record: ProductRecord) {
  const latest = record.state.executions
    .filter((execution) => execution.check.startsWith("PINNED_"))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  if (!latest) return [];
  const { goals, spent } = unobservedGoalRounds(record, latest.subjectDigest);
  if (!goals.length) return [];
  return [
    "## Unverified goals",
    "",
    "The independent tester's bounded search never observed these on the latest pinned run.",
    "",
    ...goals.map(
      (goal) =>
        `- ${cell(goal)}: NOT OBSERVED${spent.includes(goal) ? " after its one repair round" : ""}`,
    ),
    "",
  ];
}

/** Tests an independent tester wrote from the request, and what each one relies on. */
function acceptanceSection(record: IndependentTestsRecord | undefined) {
  if (!record) return [];
  const head =
    record.status === "pinned"
      ? `Written from the request by ${record.model ?? "an independent tester"}, failed before implementation (exit ${record.baseline?.exitCode}), and pinned as \`${record.file}\`.`
      : `The independent tester's tests were not pinned (${record.status}): ${cell(record.reason ?? "no reason recorded")}.`;
  return [
    "## Acceptance tests",
    "",
    head,
    ...(record.tests?.length
      ? [
          "",
          "| Test | Request text it relies on |",
          "| --- | --- |",
          ...record.tests.map((test) => `| ${cell(test.name)} | ${cell(test.quote)} |`),
        ]
      : []),
    ...(record.notes?.trim() ? ["", `Tester notes: ${cell(record.notes)}`] : []),
    ...disputeLines(record),
    "",
  ];
}

function disputeStatus(entry: NonNullable<IndependentTestsRecord["disputes"]>[number]) {
  if (entry.status === "upheld") return "upheld, waived";
  return entry.status === "open" && entry.reviews >= 2
    ? "unresolved: the reviewer did not rule twice, so it needs the human reviewer"
    : entry.status;
}

/** Waived tests are the human reviewer's business: who said what, and who ruled. */
function disputeLines(record: IndependentTestsRecord) {
  if (!record.disputes?.length) return [];
  return [
    "",
    "Disputed tests (the implementer's reason, then the independent reviewer's ruling):",
    "",
    ...record.disputes.map(
      (entry) =>
        `- ${cell(entry.test)}: ${disputeStatus(entry)}. Reason: ${cell(entry.reason)}${entry.ruling ? ` Ruling${entry.ruling.model ? ` (${entry.ruling.model})` : ""}: ${cell(entry.ruling.reasoning)}` : ""}`,
    ),
  ];
}

/** Changes to protected intent are the reviewer's first question after the request. */
function intentSection(record: ProductRecord) {
  const changes = record.state.revisions.filter(
    (revision) => revision.kind === "intent" || revision.provenance !== "agent-proposed",
  );
  if (!changes.length) return [];
  return [
    "## Intent changes",
    "",
    ...changes.map(
      (revision) =>
        `- ${revision.createdAt} (${revision.provenance}, ${revision.kind}): ${cell(revision.reason)}`,
    ),
    "",
  ];
}

function reviewSection(record: ProductRecord) {
  const reviewers = record.state.reviews.filter((review) => review.reviewer?.model);
  const open = outstandingFeedback(record);
  return [
    "## Independent review",
    "",
    ...(reviewers.length
      ? reviewers.map(
          (review) =>
            `- ${review.createdAt}: ${review.reviewer?.model} (${review.reviewer?.context} context), ${review.assessments.filter((assessment) => assessment.status === "satisfied").length}/${review.assessments.length} outcomes satisfied`,
        )
      : [
          "No independent review is recorded. Treat outcomes without executed checks as unverified.",
        ]),
    "",
    ...(open.length
      ? [
          "Open findings:",
          "",
          ...open.map(
            (finding) =>
              `- ${finding.required ? "**required** " : ""}${finding.dimension}: ${cell(finding.problem)}${finding.nextCheck ? ` Next check: ${cell(finding.nextCheck)}` : ""}`,
          ),
          "",
        ]
      : []),
  ];
}

async function reviewerActivity(workspace: WorkspaceState, feature: string) {
  const text = await workspace.files.readTextIfExists(
    workspace.paths.featureFile(feature, REVIEWER_ACTIVITY_FILE),
  );
  if (!text.ok || !text.value) return [];
  return text.value.split("\n").flatMap((line) => {
    try {
      const entry = JSON.parse(line) as { at?: string; webSearches?: string[] };
      return entry.webSearches?.length ? [{ at: entry.at ?? "", queries: entry.webSearches }] : [];
    } catch {
      return [];
    }
  });
}

/** Reviewer internet use is monitored: every web search query, per review call. */
function internetSection(activity: readonly { at: string; queries: readonly string[] }[]) {
  if (!activity.length) return [];
  return [
    "## Reviewer internet use",
    "",
    ...activity.flatMap((entry) => entry.queries.map((query) => `- ${entry.at}: ${cell(query)}`)),
    "",
  ];
}

const TESTER_COMMANDS_SHOWN = 40;

/** The execution-mode tester runs commands with network; each one is listed or counted. */
function testerSection(
  sessions: readonly { at: string; commands: readonly string[] }[],
  feature: string,
) {
  const commands = sessions.flatMap((session) =>
    session.commands.map((command) => `- ${session.at}: \`${cell(command).replaceAll("`", "'")}\``),
  );
  if (!commands.length) return [];
  const hidden = commands.length - TESTER_COMMANDS_SHOWN;
  return [
    "## Tester commands with network access",
    "",
    "The independent tester ran these in a disposable copy of the repository without secret or blocked files.",
    "",
    ...commands.slice(0, TESTER_COMMANDS_SHOWN),
    ...(hidden > 0
      ? [`- ${hidden} more in \`.visp/features/${feature}/${TESTER_ACTIVITY_FILE}\``]
      : []),
    "",
  ];
}

function commandText(command: unknown): string {
  if (typeof command === "string") return command;
  if (Array.isArray(command)) return command.join(" ");
  const journey = (command as { journey?: { url?: string } }).journey;
  return journey?.url ? `browser journey ${journey.url}` : "browser journey";
}

function cell(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}
