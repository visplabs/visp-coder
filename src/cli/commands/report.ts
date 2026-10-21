import { Command } from "commander";
import { ok } from "../../core/result.js";
import { type CapabilityUtilization, capabilityUtilization } from "../../telemetry/capabilities.js";
import {
  type ReportedTokens,
  readTelemetry,
  summarize,
  type TelemetryReport,
} from "../../telemetry/store.js";
import { isJson, options, workspace } from "../context.js";
import { emit, emitError } from "../output.js";

export function reportCommand(): Command {
  return new Command("report")
    .description("Show what visp measured, and what agents claimed about cost")
    .action(async (_flags: unknown, command: Command) => {
      const opts = options(command);
      const state = await workspace(opts);
      if (!state.ok) {
        process.exitCode = emitError("report", state.error, { json: isJson(opts) });
        return;
      }

      const telemetry = await readTelemetry(state.value);
      if (!telemetry.ok) {
        process.exitCode = emitError("report", telemetry.error, { json: isJson(opts) });
        return;
      }

      const capabilities = await capabilityUtilization(state.value);
      if (!capabilities.ok) {
        process.exitCode = emitError("report", capabilities.error, { json: isJson(opts) });
        return;
      }

      const summary = { ...summarize(telemetry.value), capabilities: capabilities.value };
      process.exitCode = emit("report", ok(summary), {
        json: isJson(opts),
        text: render,
      });
    });
}

/**
 * Two sections, never one table. Attempt and pass rates are things visp watched
 * happen; token counts are things an agent told it afterwards. Printing them in
 * the same column would let the second borrow the credibility of the first.
 */
type ReportData = TelemetryReport & { readonly capabilities: CapabilityUtilization };

function render(data: ReportData): string {
  const cost = data.selfReportedCost;
  return [
    "Workflow checks measured by visp (legacy journal)",
    `  Verify:          ${stage(data.workflow.verify)}`,
    `  Review:          ${stage(data.workflow.review)}`,
    "",
    "Measured usage imported from hosts",
    ...measuredUsage(data),
    "",
    "Self-reported by the agent — Legacy self-reported claims, deprecated and never verified by visp",
    ...(data.attempts === 0
      ? ["  No attempts recorded yet."]
      : [
          `  Attempts:        ${data.attempts}`,
          `  Input tokens:    ${tokens(cost.inputTokens, data.attempts)}`,
          `  Output tokens:   ${tokens(cost.outputTokens, data.attempts)}`,
          `  Model:           ${claimedModels(cost.models)}`,
        ]),
    "",
    ...capabilityLines(data.capabilities),
    "",
    PROVENANCE,
  ].join("\n");
}

function capabilityLines(value: CapabilityUtilization): string[] {
  return [
    "Capability utilization",
    ...productLines(value.product),
    ...(value.unmigratedFeatures > 0
      ? [
          `  Unmigrated:      ${value.unmigratedFeatures} legacy feature(s) not summarized; preview with visp-migrate preview`,
        ]
      : []),
    `  Graph actions:   ${value.graph.indexBuilds} builds, ${value.graph.indexRefreshes} refreshes, ${value.graph.queries} queries`,
    `  Skill catalog:   ${names(value.skills.catalogAvailable)}`,
    `  Available unused: ${names(value.skills.availableButUnseeded)}`,
    `  Skills admitted: ${names(value.skills.admitted)}`,
    `  Skills inactive: ${names(value.skills.intentionallyInactive)}`,
  ];
}

function productLines(value: CapabilityUtilization["product"]): string[] {
  return [
    "Product feedback loop",
    `  Features:        ${value.features}; ${value.activeFeatures} active, ${value.recordedAcceptances} recorded acceptances, ${value.historicalFeatures} historical completions; ${value.incompleteBriefs} incomplete briefs`,
    `  Outcomes:        ${value.outcomes.functional} functional, ${value.outcomes.quality} quality, ${value.outcomes.experience} experience; ${value.examples} behavior examples`,
    `  Decisions:       ${value.decisions}; ${value.evidenceReferences} evidence references; ${value.unresolvedQuestions} unresolved questions`,
    `  Slices:          ${value.slices.pending} pending, ${value.slices.inProgress} in progress, ${value.slices.closed} closed, ${value.slices.historicalClosed} historically closed`,
    `  Executions:      ${value.executions.recorded} supervisor-executed; ${value.executions.passed} passed, ${value.executions.failed} failed, ${value.executions.environmentFailed} environment failures; ${value.executions.durationMs} ms recorded runtime`,
    `  Freshness:       ${value.executions.current} current execution records, ${value.executions.stale} stale; ${value.reviews.current} current review submissions, ${value.reviews.stale} stale`,
    `  Assessments:     agent-reported; ${value.assessments.satisfied} satisfied, ${value.assessments.failed} failed, ${value.assessments.unclear} unclear, ${value.assessments.unavailable} unavailable, ${value.assessments.unassessed} unassessed current outcomes`,
    `  Recorded runs:   ${value.captureRuns} capture journeys, ${value.controlRuns} controls; records alone do not establish intact images or product quality`,
    "  Acceptance and slice counts are recorded workflow state, not fresh verification. Review judgments remain agent-reported; passing execution does not establish goal fidelity.",
  ];
}

function names(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

/**
 * The flags are real, useful, and were never written down anywhere, which is
 * how a run with none of them came to print a confident zero. Saying where the
 * numbers come from every time is cheaper than expecting anyone to remember.
 */
const PROVENANCE = [
  "Use `visp usage import --source codex --file <rollout.jsonl>` for sourced counts.",
  "visp never observes token usage itself; imported host receipts carry the source.",
  "Self-reported attempts are historical journal entries; nothing confirms their values.",
].join("\n");

function stage(value: TelemetryReport["workflow"]["verify"]): string {
  if (value.tasks === 0) return `${value.checks} checks; no task-level first pass yet`;
  return (
    `${value.checks} ${plural(value.checks, "check", "checks")} across ` +
    `${value.tasks} ${plural(value.tasks, "task", "tasks")}; ` +
    `${percent(value.firstPassRate)} first pass; ${value.recoveredTasks} recovered`
  );
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function measuredUsage(data: TelemetryReport): string[] {
  const usage = data.measuredUsage;
  if (usage.receipts === 0) return ["  No sourced usage receipts imported."];
  return [
    `  Receipts:        ${usage.receipts}`,
    `  Input tokens:    ${usage.inputTokens}`,
    `  Cached input:    ${usage.cachedInputTokens}`,
    `  Output tokens:   ${usage.outputTokens}`,
    `  Reasoning:       ${usage.reasoningTokens}`,
    `  Models:          ${usage.models.join(", ") || "unknown"}`,
    `  Efforts:         ${usage.efforts.join(", ") || "unknown"}`,
  ];
}

/**
 * No total across the whole run, because attempts that reported nothing cannot
 * be summed with attempts that did. The reach of the figure is part of it.
 */
function tokens(reported: ReportedTokens, attempts: number): string {
  if (reported.total === undefined) return "unknown — no attempt reported a count";
  return `${reported.total} claimed across ${reported.fromAttempts} of ${attempts} attempts`;
}

function claimedModels(models: readonly string[]): string {
  return models.length === 0 ? "unknown — no attempt named one" : models.join(", ");
}

function percent(rate: number | undefined): string {
  return rate === undefined ? "unknown" : `${Math.round(rate * 100)}%`;
}
