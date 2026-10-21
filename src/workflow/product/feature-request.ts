import type { RiskLevel } from "../../core/constants.js";
import { redactRequest } from "../../core/redaction.js";
import { ok, type Result } from "../../core/result.js";
import {
  MEMORY_HEADING,
  MEMORY_HEADING_WITH_LATER_CHANGES,
  projectMemoryText,
} from "../../memory/project-memory.js";
import type { Intent } from "../artifacts/feature.js";
import type { WorkspaceState } from "../state.js";
import { type FeatureMemory, featureMemory } from "./feature-memory.js";
import type { ProductFeatureOptions, ProductFeatureOutcome } from "./feature-model.js";
import type { HostRequest } from "./host-prompts.js";
import type { ProductState } from "./model.js";
import {
  mergeProjectRules,
  type RuleExtractor,
  readProjectRules,
  statedRules,
} from "./project-rules.js";
import { reviewerModel } from "./reviewer-model.js";
import { reviewerRuleExtractor } from "./rule-extraction.js";
import { readProductRecord } from "./store.js";

/** With a reviewer VISP launches, its model reads the rules; otherwise phrase matching does. */
async function ruleReader(workspace: WorkspaceState): Promise<RuleExtractor | undefined> {
  const reviewer = await reviewerModel(workspace);
  return reviewer ? reviewerRuleExtractor(reviewer) : undefined;
}

export interface FeatureRequest {
  /** The redacted request text a duplicate is recognized by. */
  readonly request: string;
  readonly redacted: boolean;
  readonly host: HostRequest | undefined;
  readonly stated: readonly string[];
  readonly memory: FeatureMemory;
  readonly originalRequest: string;
}

/** The user's recorded request, with the earlier decisions selected for it; rules are captured on the way. */
export async function featureRequest(
  workspace: WorkspaceState,
  host: HostRequest | undefined,
  raw: string,
  request: string,
): Promise<Result<FeatureRequest>> {
  const recorded = await readProjectRules(workspace);
  if (!recorded.ok) return recorded;
  const stated = await statedRules(host?.prompts ?? [], await ruleReader(workspace));
  const rules = mergeProjectRules(
    recorded.value.rules,
    stated,
    "pending",
    new Date().toISOString(),
  );
  const memory = await featureMemory(
    workspace,
    request,
    rules.rules.map((rule) => rule.text),
  );
  if (!memory.ok) return memory;
  // Earlier rules are not copied into the fixed request: work replies, the reviewer and the
  // tester read the current rules, so a removed rule stops applying at once.
  return ok({
    request,
    redacted: raw !== request,
    host,
    stated,
    memory: memory.value,
    originalRequest: [request, projectMemoryText(memory.value.memories, memory.value.laterChanges)]
      .filter(Boolean)
      .join("\n\n"),
  });
}

/** A request repeated within this window, before any work on it, is the same feature. */
const DUPLICATE_WINDOW_MS = 10 * 60_000;

const DUPLICATE_MIN_REQUEST = 20;

/**
 * A worker that runs `visp feature` twice for one request (a host that returned early, a
 * retry) got two feature directories. The earlier one is returned when it records this
 * request, is under ten minutes old and has neither an execution nor a started slice; a
 * worked or accepted feature is never merged into. The tester is not started here.
 */
export async function recentDuplicate(
  workspace: WorkspaceState,
  request: string,
  terms: DuplicateTerms | undefined,
  known?: readonly string[],
): Promise<Result<ProductFeatureOutcome | undefined>> {
  const wanted = whitespaceNormalized(request);
  if (!terms || wanted.length < DUPLICATE_MIN_REQUEST) return ok(undefined);
  const listed = known ? ok(known) : await workspace.store.listFeatures();
  if (!listed.ok) return listed;
  for (const id of listed.value) {
    const intent = await workspace.store.readIntent(id);
    if (!intent.ok) continue;
    const age = Date.now() - Date.parse(intent.value.createdAt);
    // Newest first: everything after this is older too.
    if (!(age <= DUPLICATE_WINDOW_MS)) break;
    if (!recordsRequest(intent.value, wanted, terms)) continue;
    const record = await readProductRecord(workspace, { feature: id });
    if (!record.ok || !untouchedFeature(record.value.state)) continue;
    return ok({
      brief: record.value.brief,
      intent: intent.value,
      duplicateOf: id,
      duplicateNote: `Feature ${id} already records this request (${Math.max(0, Math.round(age / 1000))} s ago); no second feature was started. Continue: visp work --feature ${id} --check "<test command>"`,
    });
  }
  return ok(undefined);
}

/** What else a repeat must match: a different goal or risk, or a branch, is a new feature. */
export interface DuplicateTerms {
  readonly goal: string;
  readonly riskLevel: RiskLevel;
}

export function duplicateTerms(
  workspace: WorkspaceState,
  options: ProductFeatureOptions,
): DuplicateTerms | undefined {
  return options.branch
    ? undefined
    : {
        goal: redactRequest(options.goal, workspace.paths.root),
        riskLevel: options.riskLevel ?? "low",
      };
}

/**
 * The request is the stored one, whole: what follows it may only be the memory block VISP
 * appended. A request that is a mere prefix of a longer one (a mid-word cut, a narrower
 * ask) is a different request.
 */
function recordsRequest(intent: Intent, wanted: string, terms: DuplicateTerms): boolean {
  if (intent.goal !== terms.goal || intent.riskLevel !== terms.riskLevel) return false;
  const stored = whitespaceNormalized(intent.sourceBrief ?? "");
  if (!stored.startsWith(wanted)) return false;
  const rest = stored.slice(wanted.length).trim();
  return (
    rest === "" ||
    (stored[wanted.length] === " " &&
      [MEMORY_HEADING, MEMORY_HEADING_WITH_LATER_CHANGES].some((heading) =>
        rest.startsWith(whitespaceNormalized(heading)),
      ))
  );
}

function untouchedFeature(state: ProductState): boolean {
  return (
    state.status === "active" &&
    state.executions.length === 0 &&
    Object.values(state.slices).every((slice) => slice.status === "pending")
  );
}

function whitespaceNormalized(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
