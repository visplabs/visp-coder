import { parse } from "yaml";
import { vispError } from "../core/errors.js";
import { hashValue } from "../core/hash.js";
import { err, ok } from "../core/result.js";
import { criticStatus } from "../workflow/product/critic/critic-status.js";
import type { WorkspaceState } from "../workflow/state.js";
import { resolveCriticPolicyDetails } from "./critic-defaults.js";
import { parseConfig } from "./load.js";

/** Inspect loaded values and their provenance; never resolve policy a second way. */
export async function explainSettings(state: WorkspaceState) {
  const read = await state.files.readTextIfExists(state.paths.config);
  if (!read.ok) return read;
  const loaded = parseConfig(read.value ?? "", state.paths.config);
  if (!loaded.ok) return loaded;
  if (hashValue(loaded.value) !== hashValue(state.config))
    return err(
      vispError("CONFIG_INVALID", "Configuration changed during inspection; retry doctor"),
    );
  const authored = parse(read.value ?? "") ?? {};
  const settings = leaves(state.config).map(([path, value]) => ({
    path,
    value,
    source: supplied(authored, path) ? ("project" as const) : ("default" as const),
    ...effect(path),
  }));
  const defaults = await resolveCriticPolicyDetails(state.config.harness, state.config.critic);
  const feature = state.status?.activeFeature;
  const activeCritic = feature ? await criticStatus(state, { feature }) : undefined;
  return ok({
    settings,
    policy: {
      strictness: state.policy.strictness,
      maxChangedFiles: state.policy.maxChangedFiles ?? state.config.workflow.maxChangedFiles,
      rules: state.policy.rules,
      overrides: state.overrides,
      note: "Recorded policy and overrides control enforcement; workflow.strictness supplies the default only when no policy is recorded.",
    },
    newFeatureCritic: defaults.ok
      ? ok({ ...defaults.value.policy, sources: defaults.value.sources })
      : defaults,
    activeFeatureCritic: activeCritic ?? { status: "unavailable", reason: "No active feature" },
    notes: [
      "Project/default labels describe visp.yml provenance, not installed asset state or observed host capability.",
      "Critic defaults use the existing project/personal/host resolver and apply to new features. Active feature policy and spending are reported separately.",
      "Configured model and image limits are requests and bounds, not proof of dispatch, image delivery or reviewer isolation.",
      "Inactive settings remain compatibility candidates; legacy-only settings do not control current product acceptance.",
    ],
  });
}

export async function requestedSettings(state: WorkspaceState, requested?: boolean) {
  return requested ? { settings: await explainSettings(state) } : {};
}

export function renderSettings(report?: Awaited<ReturnType<typeof explainSettings>>): string[] {
  if (!report) return [];
  if (!report.ok) return [`Settings unavailable: ${report.error.message}`];
  return [
    "Settings:",
    ...report.value.settings.map(
      (entry) =>
        `  ${entry.path} = ${JSON.stringify(entry.value)} (${entry.source}; ${entry.effect}): ${entry.note}`,
    ),
    `  Effective policy strictness: ${report.value.policy.strictness}; changed-file limit: ${report.value.policy.maxChangedFiles}`,
    report.value.policy.note,
    `  New-feature critic: ${JSON.stringify(report.value.newFeatureCritic)}`,
    `  Active-feature critic: ${JSON.stringify(report.value.activeFeatureCritic)}`,
    ...report.value.notes,
  ];
}

const operationNotes: Readonly<Record<string, string>> = {
  "workflow.reviewMode": "Selects current review or experimental observation-preview guidance.",
  "workflow.maxChangedFiles":
    "Default scope ceiling; recorded policy.maxChangedFiles takes precedence (shown below).",
  "workflow.blockedPaths": "Blocks matching paths in product scope and source access.",
  "workflow.validationCommands":
    "Runs configured project checks during product verification; results are evidence, not review judgments.",
  "workflow.profile":
    "lean runs one review at the end by critic.leanModel and no tester on a new project; full runs the independent loop. A lean feature moves to full when a check fails on two versions, the change is large or the request lists many requirements.",
  "workflow.worker": "weak runs every feature with the full profile.",
  "workflow.draftFirst":
    "visual authorizes a picture request as one slice at visp work, before any check, so the whole picture is drafted first. Unset follows the feature's profile.",
  "workflow.reviewCadence":
    "feature reviews only the slice that completes the feature, at most twice, the second time only while a required finding is open. Unset follows the feature's profile.",
  "workflow.requestGaps":
    "required makes reviewer findings tagged as gaps against the request required and shows other findings as notes. Unset follows the feature's profile.",
  "workflow.regressionGate":
    "At done and accept, advise runs the existing tests the change reaches and earlier work's checks, comparing failures with the old code; gate also blocks on a test that passed before and fails now.",
  "graph.languages":
    "Selects languages for indexing; a configured language does not prove an index is current.",
  "graph.exclude": "Excludes matching repository paths from graph indexing.",
  "graph.maxFileBytes": "Bounds source files read by graph indexing.",
  "context.tokenBudget":
    "Bounds delivered product context approximately; essential intent may overflow with an explicit diagnostic.",
  "context.maxSnippets": "Limits source excerpts in product context; does not limit all evidence.",
  "memory.enabled": "Enables earlier-request recall; false turns every memory path off.",
  "memory.recall":
    "With a reviewer VISP launches (codex-exec or claude-exec), its model selects relevant earlier requests for each new feature; a reviewer the host runs recalls nothing.",
  "telemetry.enabled":
    "Enables local usage import; activity recording remains enabled independently.",
};

function effect(path: string) {
  if (path === "workflow.flipCheck")
    return {
      effect: "conditional",
      note: "Runs a display-only regression comparison for passing slice checks: auto reverts changes to existing implementation, on includes added implementation, off skips. Never changes evidence credit or acceptance.",
    };
  if (path.startsWith("critic."))
    return {
      effect: "conditional",
      note: "Input to new-feature critic defaults; see resolved and active-feature policy below.",
    };
  if (["preset", "harness", "profile"].includes(path))
    return {
      effect: "conditional",
      note: "Setup/installation preference; inspect doctor asset checks for the actual installed configuration.",
    };
  if (path === "workflow.strictness")
    return {
      effect: "conditional",
      note: "Default for policy; recorded policy and explicit rule overrides take precedence.",
    };
  if (path === "workflow.acceptanceChecks")
    return {
      effect: "conditional",
      note: "Pinned when a feature is created; editing this value does not rewrite existing feature checks.",
    };
  const note = operationNotes[path];
  return note
    ? { effect: "conditional", note }
    : {
        effect: "unavailable",
        note: "No consumer explanation has been qualified for this setting.",
      };
}

/** Arrays are authored settings, not hundreds of independent pseudo-settings. */
function leaves(value: object, prefix = ""): Array<[string, unknown]> {
  return Object.entries(value).flatMap(([key, entry]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? leaves(entry, path)
      : [[path, entry]];
  });
}

function supplied(value: unknown, path: string): boolean {
  let cursor = value;
  for (const key of path.split(".")) {
    if (!cursor || typeof cursor !== "object" || !Object.hasOwn(cursor, key)) return false;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return true;
}
