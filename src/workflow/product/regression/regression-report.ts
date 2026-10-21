import { z } from "zod";
import type { FileMutation } from "../../../core/file-transaction.js";
import type { WorkspaceState } from "../../state.js";
import type { RegressionStatus, RegressionTestVerdict } from "./regression-failures.js";

export interface RegressionGateResult {
  readonly label: string;
  readonly command: string;
  readonly status: RegressionStatus;
  readonly tests: readonly RegressionTestVerdict[];
  readonly reason?: string;
}

/** What the gate ran on the new and the old code, and what it concluded. */
export interface RegressionGateReport {
  readonly version: 1;
  readonly feature: string;
  readonly subjectDigest: string;
  readonly key: string;
  readonly status: "clear" | "regression" | "unchecked";
  readonly results: readonly RegressionGateResult[];
  readonly leftOut: readonly string[];
  /** What the selected commands are: tests linked to the changed code, earlier work's checks, filler. */
  readonly selection?: RegressionSelection;
  readonly durationMs: number;
}

export interface RegressionSelection {
  readonly linked: number;
  readonly earlierWork: number;
  readonly unlinked: number;
}

/** The gate in a `done` or `accept` reply. */
export interface RegressionGateSummary {
  readonly mode: "off" | "advise" | "gate";
  readonly status: RegressionGateReport["status"];
  readonly ran: readonly string[];
  readonly selected?: RegressionSelection;
  readonly regressions?: readonly string[];
  readonly preExisting?: readonly string[];
  readonly unchecked?: readonly string[];
  readonly leftOut?: readonly string[];
}

const verdictSchema = z
  .object({
    name: z.string(),
    status: z.enum(["regression", "pre-existing", "unchecked"]),
    message: z.string(),
    before: z.string().optional(),
    reason: z.string().optional(),
  })
  .strict();

const reportSchema = z
  .object({
    version: z.literal(1),
    feature: z.string(),
    subjectDigest: z.string(),
    key: z.string(),
    status: z.enum(["clear", "regression", "unchecked"]),
    results: z.array(
      z
        .object({
          label: z.string(),
          command: z.string(),
          status: z.enum(["passed", "regression", "pre-existing", "unchecked"]),
          tests: z.array(verdictSchema),
          reason: z.string().optional(),
        })
        .strict(),
    ),
    leftOut: z.array(z.string()),
    selection: z
      .object({ linked: z.number(), earlierWork: z.number(), unlinked: z.number() })
      .strict()
      .optional(),
    durationMs: z.number().nonnegative(),
  })
  .strict();

const reportPath = (workspace: WorkspaceState, feature: string) =>
  workspace.paths.stateFile(`state/regression-gates/${feature}.json`);

export async function readRegressionGate(
  workspace: WorkspaceState,
  feature: string,
): Promise<RegressionGateReport | undefined> {
  const text = await workspace.files.readTextIfExists(reportPath(workspace, feature));
  if (!text.ok || !text.value) return undefined;
  try {
    const parsed = reportSchema.safeParse(JSON.parse(text.value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The saved report, when the gate is on and the report describes this version of the product. */
export async function currentRegressionGate(
  workspace: WorkspaceState,
  feature: string,
  subjectDigest: string,
): Promise<RegressionGateReport | undefined> {
  if (workspace.config.workflow.regressionGate === "off") return undefined;
  const report = await readRegressionGate(workspace, feature);
  return report?.subjectDigest === subjectDigest ? report : undefined;
}

function regressionGateMutation(
  workspace: WorkspaceState,
  report: RegressionGateReport,
): FileMutation {
  return {
    kind: "write",
    path: reportPath(workspace, report.feature),
    content: `${JSON.stringify(report, null, 2)}\n`,
  };
}

/** Whether the gate stops `done` or `accept`: only a regression, and only in `gate` mode. */
function regressionGateBlocks(
  workspace: WorkspaceState,
  report?: RegressionGateReport,
): report is RegressionGateReport {
  return workspace.config.workflow.regressionGate === "gate" && report?.status === "regression";
}

const SHOWN = 5;
/** Pre-existing failures are context, not work: a middle slice's pinned suite has many. */
const SHOWN_PRE_EXISTING = 2;
const MESSAGE = 160;

function testLine(result: RegressionGateResult, test: RegressionGateResult["tests"][number]) {
  const name =
    test.name && test.name !== result.label ? `${result.label} › ${test.name}` : result.label;
  const detail = test.reason ?? test.message;
  return detail ? `${name}: ${detail.slice(0, MESSAGE)}` : name;
}

function linesWith(report: RegressionGateReport, status: RegressionStatus) {
  return report.results.flatMap((result) => {
    const tests = result.tests.filter((test) => test.status === status);
    if (tests.length) return tests.map((test) => testLine(result, test));
    return result.status === status && result.reason
      ? [`${result.label}: ${result.reason.slice(0, MESSAGE)}`]
      : [];
  });
}

const bounded = (lines: readonly string[], shown = SHOWN) =>
  lines.length > shown ? [...lines.slice(0, shown), `+${lines.length - shown} more`] : [...lines];

/** What ran and what it found, bounded. */
function regressionGateSummary(
  workspace: WorkspaceState,
  report: RegressionGateReport,
): RegressionGateSummary {
  const regressions = linesWith(report, "regression");
  const preExisting = linesWith(report, "pre-existing");
  const unchecked = linesWith(report, "unchecked");
  return {
    mode: workspace.config.workflow.regressionGate,
    status: report.status,
    ran: report.results.map((result) => result.label),
    ...(report.selection ? { selected: report.selection } : {}),
    ...(regressions.length ? { regressions: bounded(regressions) } : {}),
    ...(preExisting.length ? { preExisting: bounded(preExisting, SHOWN_PRE_EXISTING) } : {}),
    ...(unchecked.length ? { unchecked: bounded(unchecked) } : {}),
    ...(report.leftOut.length ? { leftOut: bounded(report.leftOut) } : {}),
  };
}

/** One line per regressed test: closure gaps in `gate` mode, and `next` evidence. */
export function regressionGateGaps(report: RegressionGateReport): string[] {
  return linesWith(report, "regression").map(
    (line) =>
      `Regression: ${line}. It passed before this change and fails now. Fix the code; if the request changes this behavior, update the test to the request.`,
  );
}

/** One line for the reviewer: the executed results, so judgment starts from them. */
export function regressionGateLimitation(report: RegressionGateReport): string {
  const parts = [
    ["regressions", linesWith(report, "regression")],
    ["failing before this change too", linesWith(report, "pre-existing")],
    ["unchecked", linesWith(report, "unchecked")],
    ["left out", report.leftOut],
  ] as const;
  const found = parts
    .filter(([, lines]) => lines.length)
    .map(([label, lines]) => `${label}: ${lines.slice(0, SHOWN).join("; ")}`);
  const ran = report.results.length
    ? `ran ${report.results.map((result) => result.label).join(", ")} on the new code, and each failure again on the old code`
    : "ran nothing";
  return `Regression gate (${report.status}): VISP ${ran}.${found.length ? ` ${found.join(". ")}.` : ""} A regression is a test that passed before this change and fails now; judge whether the request asked for that change in behavior.`;
}

/** What a report adds to a closeout: blocking gaps, its saved file and the reply entry. */
export function regressionGateCloseout(workspace: WorkspaceState, report?: RegressionGateReport) {
  if (!report) return { gaps: [], mutations: [], reply: {} };
  return {
    gaps: regressionGateBlocks(workspace, report) ? regressionGateGaps(report) : [],
    mutations: [regressionGateMutation(workspace, report)],
    reply: { regressionGate: regressionGateSummary(workspace, report) },
  };
}
