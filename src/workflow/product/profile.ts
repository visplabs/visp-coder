import type { CriticConfig } from "../../config/critic.js";
import type { WorkspaceState } from "../state.js";
import type { ProductBrief, ProductState } from "./model.js";
import { requestRequirements } from "./requirements.js";

/**
 * The workflow profile of a feature. `lean` is the default for strong workers: with Claude
 * Haiku 5.5 the full loop cost 9–12× a bare run and raised no score (bare runs passed about
 * 100% of hidden checks), the reviewer was 60–90% of that cost, and slice planning and review
 * rounds 3+ changed nothing. `full` is the independent loop, kept as the escalation where a
 * weak worker or a hard task may still need it. The rules are explicit and deterministic: the
 * project chooses full, or the feature itself shows one of the signs below.
 */
export type ProfileName = "lean" | "full";
export interface FeatureProfile {
  readonly name: ProfileName;
  /** Why the feature runs the full profile. */
  readonly reason?: string;
}

/** The largest current benchmark request lists 16; longer lists get the full loop. */
const MANY_REQUIREMENTS = 20;
/** A failure that survived one repair attempt. */
const FAILED_VERSIONS = 2;
const LARGE_CHANGE_FILES = 15;
/** Top-level directories, the repository root counting as one. */
const SPREAD_CHANGE_AREAS = 4;
/** Claude Code's Haiku-class reviewer: the October critic ablation scored it level with Sonnet. */
const CLAUDE_LEAN_REVIEWER = "claude-haiku-5-5";
/**
 * At high effort the Haiku reviewer thought for about 32k tokens and took 150–176 s per review
 * in batch leandef1 (Sonnet high: 22–75 s), near the 180 s call timeout: 9 of 14 reviews timed
 * out or outlived the worker's wait, and lean runs spent 3–5 times develop's time in VISP commands.
 */
const LEAN_REVIEW_EFFORT = "low";

interface ProfileSubject {
  readonly brief: Pick<ProductBrief, "originalRequest">;
  readonly state?: Pick<ProductState, "executions" | "profileEscalation">;
}

export function featureProfile(workspace: WorkspaceState, record: ProfileSubject): FeatureProfile {
  const { workflow } = workspace.config;
  if (workflow.profile === "full") return full("workflow.profile is full");
  if (workflow.worker === "weak") return full("workflow.worker is weak");
  const listed = requestRequirements(record.brief.originalRequest).length;
  if (listed > MANY_REQUIREMENTS)
    return full(`the request lists ${listed} requirements, more than ${MANY_REQUIREMENTS}`);
  const failing = repeatedlyFailing(record.state);
  if (failing) return full(`check ${failing} failed on two versions of the product`);
  const escalation = record.state?.profileEscalation;
  return escalation ? full(escalation.reason) : { name: "lean" };
}

function full(reason: string): FeatureProfile {
  return { name: "full", reason };
}

function repeatedlyFailing(state: ProfileSubject["state"]): string | undefined {
  const versions = new Map<string, Set<string>>();
  for (const execution of state?.executions ?? []) {
    if (execution.status !== "failed") continue;
    const seen = versions.get(execution.check) ?? new Set<string>();
    seen.add(execution.subjectDigest);
    versions.set(execution.check, seen);
    if (seen.size >= FAILED_VERSIONS) return execution.check;
  }
  return undefined;
}

/** The lean switches as this feature runs them: a setting in visp.yml wins over the profile. */
export function profileSettings(workspace: WorkspaceState, record: ProfileSubject) {
  const lean = featureProfile(workspace, record).name === "lean";
  const { workflow } = workspace.config;
  return {
    draftFirst: workflow.draftFirst ?? (lean ? "visual" : "off"),
    reviewCadence: workflow.reviewCadence ?? (lean ? "feature" : "slice"),
    requestGaps: workflow.requestGaps ?? (lean ? "required" : "reviewer"),
  } as const;
}

/** Why a change is too large or spread out for the lean profile; undefined when it is not. */
export function largeChange(paths: readonly string[]): string | undefined {
  if (paths.length > LARGE_CHANGE_FILES)
    return `the change touches ${paths.length} files, more than ${LARGE_CHANGE_FILES}`;
  const areas = new Set(paths.map((path) => (path.includes("/") ? path.split("/")[0] : ".")));
  return areas.size > SPREAD_CHANGE_AREAS
    ? `the change spans ${areas.size} top-level areas, more than ${SPREAD_CHANGE_AREAS}`
    : undefined;
}

/**
 * The escalation `done` records when a lean feature's change is large or spread out. Earlier
 * signs (configuration, the request, failures) are read from the feature each time instead.
 */
export function changeEscalation(
  workspace: WorkspaceState,
  record: ProfileSubject,
  paths: readonly string[],
): ProductState["profileEscalation"] {
  if (featureProfile(workspace, record).name === "full") return undefined;
  const reason = largeChange(paths);
  return reason ? { reason, createdAt: new Date().toISOString() } : undefined;
}

/**
 * The reviewer a lean feature pins at `visp feature`. In the October critic ablation on picture
 * tasks a Haiku 5.5 reviewer scored 7.53 against Sonnet's 7.60 (pairwise within noise) at about
 * a third of the cost per run ($0.13 vs $0.37). The host's own review was not chosen: it spends
 * the worker's tokens, VISP cannot bound it, and weak workers skipped the handoff in September.
 */
export function leanCriticConfig(workspace: WorkspaceState, config: CriticConfig): CriticConfig {
  const critic = workspace.config.critic;
  const model =
    critic?.leanModel ?? (config.harness === "claude-code" ? CLAUDE_LEAN_REVIEWER : config.model);
  return {
    ...config,
    model,
    reasoningEffort: critic?.leanReasoningEffort ?? LEAN_REVIEW_EFFORT,
  };
}
