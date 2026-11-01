import { projectMemoryText } from "../memory/project-memory.js";
import { projectRulesText } from "./product/project-rules.js";

/** Where the reader runs: MCP tool text, or CLI text output read by a model through a shell. */
export type ReplyChannel = "mcp" | "cli";

const WORDING = {
  mcp: {
    full: "Read structuredContent.data for complete context.",
    detail: "Full data is already in structuredContent.data.",
    readBrief: (feature: string) => `visp_brief {feature:"${feature}"}`,
    template: (feature: string) =>
      `visp_work {feature:"${feature}", check:"<command that runs your tests>"} works the whole request as one slice. Only for several independently usable parts, plan slices: visp_brief {feature:"${feature}", template:true}`,
    next: (feature: string) => `visp_next {feature:"${feature}"}`,
  },
  cli: {
    full: "Full result: add --json.",
    detail: "Full result: add --json.",
    readBrief: (feature: string) => `visp brief --feature ${feature}`,
    template: (feature: string) =>
      `visp work --feature ${feature} --check "<command that runs your tests>" works the whole request as one slice. Only for several independently usable parts, plan slices: visp brief --template --feature ${feature}`,
    next: (feature: string) => `visp next --feature ${feature}`,
  },
} as const;

const COMPACT: Record<string, (name: string, value: unknown, channel: ReplyChannel) => string> = {
  work: compactProductText,
  review: compactProductText,
  capture: compactProductText,
  control: compactProductText,
  verify: compactVerificationText,
  done: compactVerificationText,
  accept: compactVerificationText,
  feature: compactBriefText,
  brief: compactBriefText,
  next: compactNextText,
};

/** The compact text for an operation (`done` or `visp_done`), or undefined when it has none. */
export function compactProductReply(
  operation: string,
  value: unknown,
  channel: ReplyChannel,
): string | undefined {
  const render = COMPACT[operation.replace(/^visp_/, "")];
  return render ? render(operation, value, channel) : undefined;
}

const SCALAR_FIELDS = [
  "notice",
  "information",
  "expectation",
  "retirement",
  "originalStatus",
  "canonicalRunId",
  "feature",
  "task",
  "taskClass",
  "objective",
  "mayEdit",
  "status",
  "detected",
  "failure",
  "recorded",
  "session",
  "packetPath",
  "responsePath",
  "runId",
  "replayCommand",
  "command",
  "instructions",
  "approach",
  "contextId",
] as const;
const LIST_FIELDS = [
  "outcomes",
  "examples",
  "decisions",
  "unresolved",
  "findings",
  "evidenceGaps",
  "journeyFailures",
  "imageGaps",
  "runs",
] as const;
const PLAN_FIELDS = ["capability", "firstSlice", "nextCheck", "findings", "gaps"] as const;
const FEEDBACK_FIELDS = [
  "independentTests",
  "criticUnderstanding",
  "criticAdvice",
  "userFeedback",
  "journeyFeedback",
  "next",
] as const;

/** Essential decisions remain readable through hosts which forward only text blocks. */
export function compactProductText(
  name: string,
  value: unknown,
  channel: ReplyChannel = "mcp",
): string {
  const data = object(value);
  const summary: Record<string, unknown> = {};
  for (const key of SCALAR_FIELDS) if (data[key] !== undefined) summary[key] = data[key];
  // Scope is a permission boundary: never silently truncate its forbidden paths.
  if (data.scope !== undefined) summary.scope = data.scope;
  for (const key of LIST_FIELDS)
    if (Array.isArray(data[key]) && data[key].length) summary[key] = boundedRows(data[key]);
  if (Array.isArray(data.checks) && data.checks.length) summary.checks = checkRows(data.checks);
  const notes = workerNotes(data.notes);
  if (notes.length) summary.notes = boundedRows(notes);
  addPlanSummary(data, summary);
  for (const key of FEEDBACK_FIELDS) if (data[key] !== undefined) summary[key] = bounded(data[key]);
  addObservationSummary(data, summary);
  return `${name}: ${JSON.stringify(summary)}${ambiguityText(data.independentTests)}${rulesText(data.projectRules)}${memoryText(data.projectMemory, data.projectMemoryLaterChanges)}${deliveryText(data.delivery, channel)}${detailCommand(name, data, channel)}\n${WORDING[channel].full} Tool success does not imply product acceptance.`;
}

function ambiguityText(tests: unknown): string {
  const ambiguities = object(tests).ambiguities;
  if (!Array.isArray(ambiguities)) return "";
  const short = (text: unknown) =>
    String(text ?? "")
      .replace(/\s+/g, " ")
      .slice(0, 240);
  return ambiguities
    .map((entry) => {
      const ambiguity = object(entry);
      return `\nAmbiguous: "${short(ambiguity.quote)}" — default reading (advice, not a requirement): ${short(ambiguity.conventionalReading)}. Use it unless the request, a pinned test or an explicit user decision says otherwise; report such a conflict instead of overriding it. Record your choice; alternatives are in the full result.`;
    })
    .join("");
}

function memoryText(memories: unknown, laterChanges?: unknown): string {
  const text = Array.isArray(memories)
    ? projectMemoryText(
        memories.map(String),
        Array.isArray(laterChanges) ? laterChanges.map(String) : [],
      )
    : "";
  return text ? `\n${text}` : "";
}

/** Standing project rules are requirements, shown whole as plain lines on every reply that carries them. */
function rulesText(rules: unknown): string {
  if (!Array.isArray(rules)) return "";
  const text = projectRulesText(
    rules.map(object).map((rule) => ({ id: String(rule.id), text: String(rule.text) })),
  );
  return text ? `\n${text}` : "";
}

/** Graph extraction uncertainty is diagnostic detail, not guidance for the worker. */
function workerNotes(notes: unknown): unknown[] {
  return Array.isArray(notes)
    ? notes.filter((note) => typeof note !== "string" || !note.startsWith("Graph uncertainty:"))
    : [];
}

function addPlanSummary(data: Record<string, unknown>, summary: Record<string, unknown>) {
  const plan = object(data.feedbackPlan ?? data.feedback);
  for (const key of PLAN_FIELDS) if (plan[key] !== undefined) summary[key] = bounded(plan[key]);
  if (plan.observationPlan !== undefined && usesBrowser(data))
    summary.observationPlan = bounded(plan.observationPlan);
}

/** A check's command is what the worker runs; bounding its argv would hide part of it. */
function checkRows(checks: unknown[]) {
  return {
    entries: checks.slice(0, 5).map((check) => {
      const entry = object(check);
      return { ...object(bounded(entry)), command: entry.command };
    }),
    remaining: Math.max(0, checks.length - 5),
  };
}

/** Browser observation guidance only helps work that drives a browser. */
function usesBrowser(data: Record<string, unknown>): boolean {
  const checks = Array.isArray(data.checks) ? data.checks : [];
  return (
    Array.isArray(data.captures) ||
    Array.isArray(data.images) ||
    checks.some((check) => object(object(check).command).kind === "browser-journey")
  );
}

function addObservationSummary(data: Record<string, unknown>, summary: Record<string, unknown>) {
  if (Array.isArray(data.captures))
    summary.captures = data.captures
      .map((capture) => {
        const { id, path } = object(capture);
        return { id, path };
      })
      .slice(0, 6);
  if (data.observationPlan && usesBrowser(data)) summary.observationPlan = data.observationPlan;
  if (data.reviewer) summary.reviewer = data.reviewer;
  if (data.images) summary.images = Array.isArray(data.images) ? data.images.length : undefined;
}

/** How a reply names a reference section it left out. */
const SECTION_NAMES: Readonly<Record<string, string>> = {
  files: "source excerpts",
  examples: "examples",
  decisions: "decisions",
  acceptanceBaseline: "the acceptance baseline",
  projectMemory: "earlier project decisions",
};

/** Sections left out because the worker named an earlier reply it still has in view. */
function deliveryText(delivery: unknown, channel: ReplyChannel): string {
  const { known, unchanged } = object(delivery);
  if (typeof known !== "string" || !Array.isArray(unchanged)) return "";
  const names = unchanged.flatMap((entry) =>
    typeof entry === "string" && SECTION_NAMES[entry] ? [SECTION_NAMES[entry]] : [],
  );
  if (names.length === 0) return "";
  const listed =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const tool = channel === "mcp" ? "visp_work" : "visp work";
  const without = channel === "mcp" ? "without known" : "without --known";
  return `\n${(listed ?? "").charAt(0).toUpperCase()}${(listed ?? "").slice(1)} from your earlier ${tool} reply (context ${known}) are not repeated. If you don't have them in view, call ${tool} again ${without}.`;
}

function detailCommand(name: string, data: Record<string, unknown>, channel: ReplyChannel): string {
  if (!name.endsWith("work") || typeof data.feature !== "string") return "";
  if (channel === "mcp")
    return `\nRead-only details: visp_work ${JSON.stringify({ feature: data.feature, ...(typeof data.task === "string" ? { task: data.task } : {}), inspect: true })}`;
  return `\nRead-only details: visp work --inspect --feature ${data.feature}${typeof data.task === "string" ? ` --task ${data.task}` : ""}`;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function boundedRows(rows: unknown[]) {
  return { entries: rows.slice(0, 5).map(bounded), remaining: Math.max(0, rows.length - 5) };
}

function bounded(value: unknown): unknown {
  if (typeof value === "string") return value.length > 800 ? `${value.slice(0, 800)}…` : value;
  if (Array.isArray(value)) return value.length > 5 ? boundedRows(value) : value.map(bounded);
  if (!value || typeof value !== "object") return value;
  const result = Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !["data", "output", "steps", "sha256", "subjectDigest", "contractDigest"].includes(key),
      )
      .map(([key, entry]) => [key, bounded(entry)]),
  );
  if (typeof result.content === "string" && result.content !== object(value).content)
    result.truncated = true;
  return result;
}

/**
 * Slice checks and closure. A text-only model needs the verdict, each failing check's
 * output tail, what blocks closure and the next step; digests and repeated
 * outcome statements stay in structured data.
 */
function compactVerificationText(
  name: string,
  value: unknown,
  channel: ReplyChannel = "mcp",
): string {
  const data = object(value);
  const plan = object(data.feedbackPlan);
  const next = object(data.next);
  const unresolved = rows(data.outcomes)
    .filter((outcome) => outcome.satisfied !== true)
    .map((outcome) => `${outcome.id}: behavior ${outcome.behavior}; review ${outcome.review}`);
  // The hint is an instruction, not data: JSON escapes its quotes and bounding cuts it.
  const { hint, ...pinned } = object(data.pinnedTests) as { hint?: unknown };
  const findings = shownFindings(plan.findings, object(data.critic).findings);
  const summary = {
    feature: data.feature,
    task: data.task,
    passed: data.passed,
    closed: data.closed,
    delivery: data.delivery,
    recovery: data.recovery,
    recommendation: data.recommendation,
    warnings:
      Array.isArray(data.warnings) && data.warnings.length ? boundedRows(data.warnings) : undefined,
    committedChanges:
      Array.isArray(data.committedChanges) && data.committedChanges.length
        ? boundedRows(data.committedChanges)
        : undefined,
    checks: rows(data.executions).map(executionSummary),
    regressionGate: data.regressionGate,
    profile: data.profile,
    requirements: data.requirements,
    flipExtraMs: data.flipDurationMs,
    unresolved,
    gaps: closureGaps(data.gaps, unresolved, findings.ids),
    findings: findings.own.length ? bounded(findings.own) : undefined,
    acceptanceTests: data.acceptanceTests ? bounded(data.acceptanceTests) : undefined,
    pinnedTests: Object.keys(pinned).length ? bounded(pinned) : undefined,
    critic: data.critic ? bounded(data.critic) : undefined,
    nextProbe: plan.nextProbe ? bounded(object(plan.nextProbe).question) : undefined,
    next: data.next ? nextSummary(next, findings.lines) : undefined,
  };
  const hintLine = typeof hint === "string" && hint ? `\n${hint}` : "";
  return `${name}: ${JSON.stringify(summary)}${hintLine}\n${WORDING[channel].detail} Tool success does not imply product acceptance.`;
}

/**
 * The next step. A handoff is the end of the worker's loop, so it carries what is still open:
 * the worker reports it from this reply instead of running `visp next` and `visp pr` for it.
 */
function nextSummary(next: Record<string, unknown>, shown: ReadonlySet<string>) {
  const step = { action: next.action, objective: next.objective, command: next.command };
  if (next.completion !== "handoff") return step;
  const evidence = Array.isArray(next.evidence)
    ? [...new Set(next.evidence)].filter((entry) => !shown.has(String(entry)))
    : [];
  return {
    ...step,
    completion: next.completion,
    ...(evidence.length ? { open: boundedRows(evidence) } : {}),
  };
}

/**
 * Each finding once. A `done` reply printed every finding three times: as a closure gap, as an
 * open finding with its recheck, and as the reviewer's finding (four with a handoff). The
 * reviewer's `{problem, nextCheck, required}` stays; an open finding the review did not return
 * (an earlier review's) stays whole; gaps and handoff lines that repeat a shown finding go.
 */
function shownFindings(open: unknown, reviewed: unknown) {
  const reviewedProblems = new Set(rows(reviewed).map((finding) => finding.problem));
  const findings = rows(open);
  const own = findings.filter((finding) => !reviewedProblems.has(finding.problem));
  const shown = [
    ...findings.filter((finding) => reviewedProblems.has(finding.problem)),
    ...own.slice(0, 5),
  ];
  return {
    own,
    ids: new Set(shown.map((finding) => String(finding.id))),
    lines: new Set(
      [...shown, ...rows(reviewed)].map(
        (finding) => `${finding.problem}. Next check: ${finding.nextCheck}`,
      ),
    ),
  };
}

/** Gaps repeat outcome statuses first; the actionable environment or scope reason comes last. */
function closureGaps(
  gaps: unknown,
  unresolved: readonly string[],
  findingIds: ReadonlySet<string> = new Set(),
): unknown {
  if (!Array.isArray(gaps)) return undefined;
  const shown = new Set(unresolved);
  const distinct = [...new Set(gaps)].filter(
    (gap) => !shown.has(gap as string) && !findingIds.has(String(gap).split(":")[0] ?? ""),
  );
  if (!distinct.length) return undefined;
  return {
    entries: distinct.slice(0, 12).map(bounded),
    remaining: Math.max(0, distinct.length - 12),
  };
}

function executionSummary(execution: Record<string, unknown>): unknown {
  if (execution.status === "passed") {
    const flip = object(execution.flip);
    if (Object.keys(flip).length)
      return {
        check: execution.check,
        status: "passed",
        failsWithoutChange: flip.failsWithoutChange,
        flipExtraMs: execution.flipDurationMs,
        ...(flip.failsWithoutChange === false
          ? {
              advice: `${execution.check} also passes with your source change reverted, so it does not show the requested change. Add a test that fails on the old code and passes now (keep it), then rerun visp done.`,
            }
          : {}),
        ...(flip.reason ? { flipReason: flip.reason } : {}),
      };
    return `${execution.check}: passed`;
  }
  const output = typeof execution.output === "string" ? execution.output : "";
  return {
    check: execution.check,
    status: execution.status,
    exitCode: execution.exitCode,
    output: output.length > 1_500 ? `…${output.slice(-1_500)}` : output,
  };
}

/** Feature creation and brief updates: the author already holds the content it wrote. */
function compactBriefText(name: string, value: unknown, channel: ReplyChannel = "mcp"): string {
  const data = object(value);
  const brief = data.brief === undefined ? data : object(data.brief);
  const summary = {
    feature: brief.feature,
    incomplete: brief.incomplete,
    outcomes: rows(brief.outcomes).map((entry) => `${entry.id} (${entry.kind})`),
    examples: rows(brief.examples).map((entry) => entry.id),
    checks: rows(brief.checks).map((entry) => entry.id),
    slices: rows(brief.slices).map((entry) => ({
      id: entry.id,
      goal: entry.goal,
      scope: object(entry.scope).allowed,
      checks: entry.checks,
    })),
    normalized: data.normalized,
    authorizationRevoked: data.authorizationRevoked,
    mayEdit: data.mayEdit,
    resetSlices: data.resetSlices,
    branchCreated: data.branchCreated,
    branchWarning: data.branchWarning,
    redactionNotice: data.redactionNotice,
    profile: data.profile,
  };
  const warning = [data.hostHooksWarning, data.inheritedChangesNote]
    .filter((text): text is string => typeof text === "string")
    .map((text) => `\nWarning: ${text}`)
    .join("");
  const notes = [
    data.duplicateNote,
    data.testsNote,
    data.requirementsNote,
    data.draftNote,
    data.workNote,
  ]
    .filter((text): text is string => typeof text === "string")
    .map((text) => `\nNote: ${text}`)
    .join("");
  // `visp feature --check` also started the slice: the work reply carries the next step.
  if (data.work !== undefined)
    return `${name}: ${JSON.stringify({ feature: brief.feature, profile: data.profile, redactionNotice: data.redactionNotice })}${warning}${notes}${requirementsText(data.requirements)}${rulesText(data.projectRules)}${memoryText(data.projectMemory, data.projectMemoryLaterChanges)}\n${compactProductText("work", data.work, channel)}`;
  // The adapter does not choose the next slice; visp_next owns that decision.
  const wording = WORDING[channel];
  const feature = String(brief.feature);
  const next =
    typeof data.nextCommand === "string"
      ? data.nextCommand
      : typeof data.draftCommand === "string"
        ? data.draftCommand
        : name.endsWith("feature")
          ? wording.template(feature)
          : wording.next(feature);
  return `${name}: ${JSON.stringify(summary)}${warning}${notes}${requirementsText(data.requirements)}${rulesText(data.projectRules)}${memoryText(data.projectMemory, data.projectMemoryLaterChanges)}\nNext: ${next}\nRead the full brief with ${wording.readBrief(feature)}.`;
}

/** Every listed requirement, one per line: the worker accounts for each by its ID. */
function requirementsText(requirements: unknown): string {
  if (!Array.isArray(requirements) || !requirements.length) return "";
  const lines = requirements.map((entry) => {
    const text = String(entry);
    return `\n- ${text.length > 240 ? `${text.slice(0, 239)}…` : text}`;
  });
  return `\nRequirements:${lines.join("")}`;
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(object) : [];
}

/**
 * The next step. Critic findings arrive both as evidence lines and as criticAdvice
 * findings; the worker needs each once, with the action and command.
 */
function compactNextText(name: string, value: unknown, channel: ReplyChannel = "mcp"): string {
  const data = object(value);
  const advice = object(data.criticAdvice);
  const evidence = Array.isArray(data.evidence) ? [...new Set(data.evidence)] : [];
  const summary = {
    feature: data.feature,
    task: data.task,
    action: data.action,
    objective: data.objective,
    command: data.command,
    mayEdit: data.mayEdit,
    completion: data.completion,
    recovery: data.recovery,
    evidence: evidence.length
      ? { entries: evidence.slice(0, 8).map(bounded), remaining: Math.max(0, evidence.length - 8) }
      : undefined,
    critic: data.criticAdvice
      ? { status: advice.status, command: advice.command, guidance: bounded(advice.guidance) }
      : undefined,
    userFeedback: data.userFeedback ? bounded(data.userFeedback) : undefined,
  };
  return `${name}: ${JSON.stringify(summary)}\n${WORDING[channel].detail}`;
}
