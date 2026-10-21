import type { Stage, StrictnessMode } from "../../core/constants.js";

/**
 * The rule catalogue. Rules are named for what they protect, not numbered, so a
 * refusal reads as an explanation.
 */
export interface Rule {
  readonly id: RuleId;
  readonly title: string;
  /** Why this rule exists, shown by `visp policy show`. */
  readonly reason: string;
  /** The gate that evaluates it. */
  readonly stage: Stage;
  /** Strictness modes where the rule is on unless the project turns it off. */
  readonly enabledIn: readonly StrictnessMode[];
  /**
   * Rules protecting the trust boundary itself cannot be overridden — an
   * override that could disable them would defeat the purpose of having them.
   */
  readonly overridable: boolean;
}

export const RULE_IDS = [
  "stage.order",
  "spec.validated",
  "spec.criteria",
  "plan.validated",
  "tasks.scoped",
  "tasks.traceable",
  "context.compiled",
  "contract.executable-evidence",
  "context.fresh",
  "harness.installed",
  "harness.enforced",
  "workflow.baseline",
  "scope.forbidden-paths",
  "scope.allowed-files",
  "scope.max-changed-files",
  "quality.source-file-size",
  "deps.declared",
  "evidence.commands-executed",
  "evidence.verify-passed",
  "evidence.review-passed",
  "evidence.product-accepted",
  "evidence.test-signal",
  "evidence.criteria-checked",
  "gate.stop-on-failure",
  "prompt.cannot-widen-scope",
] as const;

export type RuleId = (typeof RULE_IDS)[number];

/** Rules whose policy state is consulted by current workflow decisions. */
export const EVALUATED_RULE_IDS: readonly RuleId[] = [
  "scope.forbidden-paths",
  "scope.allowed-files",
  "scope.max-changed-files",
];

const ALL: readonly StrictnessMode[] = ["relaxed", "standard", "strict", "locked"];
const STANDARD_UP: readonly StrictnessMode[] = ["standard", "strict", "locked"];
const STRICT_UP: readonly StrictnessMode[] = ["strict", "locked"];

export const RULES: readonly Rule[] = [
  {
    id: "stage.order",
    title: "Stages run in order",
    reason: "A later stage reading an artifact an earlier stage never wrote is not grounded.",
    stage: "feature",
    enabledIn: STANDARD_UP,
    overridable: true,
  },
  {
    id: "spec.validated",
    title: "Spec is validated before planning",
    reason: "Planning against a placeholder spec produces a plan for nothing.",
    stage: "plan",
    enabledIn: STANDARD_UP,
    overridable: true,
  },
  {
    id: "spec.criteria",
    title: "Every requirement has an acceptance criterion",
    reason: "A requirement nobody can check cannot be shown to be met.",
    stage: "spec",
    enabledIn: STRICT_UP,
    overridable: true,
  },
  {
    id: "plan.validated",
    title: "Plan is validated before tasks",
    reason: "Tasks derived from a placeholder plan inherit its emptiness.",
    stage: "tasks",
    enabledIn: STANDARD_UP,
    overridable: true,
  },
  {
    id: "tasks.scoped",
    title: "Every task declares the files it may write",
    reason: "Scope declared after the edit is a description, not a bound.",
    stage: "tasks",
    enabledIn: STANDARD_UP,
    overridable: true,
  },
  {
    id: "tasks.traceable",
    title: "Every requirement is covered by a task",
    reason: "An uncovered requirement silently ships unimplemented.",
    stage: "tasks",
    enabledIn: STRICT_UP,
    overridable: true,
  },
  {
    id: "context.compiled",
    title: "A context pack exists before implementation",
    reason: "Editing without a compiled read set is editing from memory.",
    stage: "implement",
    enabledIn: STRICT_UP,
    overridable: true,
  },
  {
    id: "contract.executable-evidence",
    title: "Mandatory behavior and runtime performance have executable evidence",
    reason:
      "Inspection can reveal a problem but cannot make a weak model execute, measure, doubt, or falsify the behavior and quality target it is about to implement.",
    stage: "implement",
    enabledIn: ALL,
    overridable: false,
  },
  {
    id: "context.fresh",
    title: "The context pack still matches its sources and the files it packed",
    reason:
      "Work grounded in a spec that has since changed — or on a stale copy of a file that moved on — proves something about a version nobody is shipping.",
    stage: "verify",
    enabledIn: STANDARD_UP,
    overridable: true,
  },
  {
    id: "harness.installed",
    title: "Harness assets are installed before implementation",
    reason:
      "Without the installed guide, hooks, and tool registration, the model is not actually running under Visp.",
    stage: "implement",
    enabledIn: STANDARD_UP,
    overridable: false,
  },
  {
    id: "harness.enforced",
    title: "At least one installed hook enforces scope",
    reason:
      "Instructions and artifacts can describe a workflow, but only an active hook can stop work that bypasses it.",
    stage: "implement",
    enabledIn: ALL,
    overridable: false,
  },
  {
    id: "workflow.baseline",
    title: "A Git baseline exists before implementation",
    reason:
      "Scope, review, and flip evidence need a before-tree; an uncommitted greenfield project has none.",
    stage: "implement",
    enabledIn: ALL,
    overridable: false,
  },
  {
    id: "scope.forbidden-paths",
    title: "Blocked and forbidden paths are never written",
    reason: "Secrets, build output, and vendored code are never a task's business.",
    stage: "implement",
    enabledIn: ALL,
    overridable: false,
  },
  {
    id: "scope.allowed-files",
    title: "Changes stay inside the task's allowed files",
    reason: "A change outside declared scope was not the change that was authorized.",
    stage: "implement",
    enabledIn: STANDARD_UP,
    overridable: true,
  },
  {
    id: "scope.max-changed-files",
    title: "A change stays under the changed-file limit",
    reason: "A diff too large to review is not reviewed, whatever the report says.",
    stage: "review",
    enabledIn: STANDARD_UP,
    overridable: true,
  },
  {
    id: "quality.source-file-size",
    title: "Changed source files receive size and density review",
    reason:
      "Size and density are advisory in standard mode and enforced only in strict or locked mode; neither proves cohesion or modularity.",
    stage: "review",
    enabledIn: STANDARD_UP,
    overridable: true,
  },
  {
    id: "deps.declared",
    title: "New dependencies were declared in the plan",
    reason: "An undeclared dependency is a supply-chain decision nobody made.",
    stage: "verify",
    enabledIn: STRICT_UP,
    overridable: true,
  },
  {
    id: "evidence.commands-executed",
    title: "Validation commands actually ran",
    reason: "A check that could not run is not a check that passed.",
    stage: "verify",
    enabledIn: STANDARD_UP,
    overridable: false,
  },
  {
    id: "evidence.verify-passed",
    title: "Verification passed before review",
    reason: "Reviewing a change that does not build wastes the review.",
    stage: "review",
    enabledIn: STANDARD_UP,
    overridable: true,
  },
  {
    id: "evidence.review-passed",
    title: "Review passed before a pull request",
    reason: "The PR artifact claims the change was reviewed; it must have been.",
    stage: "pr",
    enabledIn: STANDARD_UP,
    overridable: true,
  },
  {
    id: "evidence.product-accepted",
    title: "Mandatory product acceptance is current before handoff",
    reason:
      "Closed tasks do not prove that the assembled product meets its mandatory expectations.",
    stage: "pr",
    enabledIn: ALL,
    overridable: false,
  },
  {
    id: "evidence.test-signal",
    title: "The change carries a test signal",
    reason: "Behaviour changed with no test touched is behaviour nobody pinned down.",
    stage: "review",
    enabledIn: STRICT_UP,
    overridable: true,
  },
  {
    id: "evidence.criteria-checked",
    title: "At least one acceptance criterion was actually checked",
    reason:
      "A review whose every criterion went unchecked verified a file listing, not the change.",
    stage: "review",
    enabledIn: STANDARD_UP,
    // An observation may explain an unchecked criterion, but it is not proof.
    // Allowing this rule to be waived let an entirely advisory review masquerade
    // as verified evidence, so this is part of the trust boundary.
    overridable: false,
  },
  {
    id: "gate.stop-on-failure",
    title: "Work stops at a failed gate",
    reason: "Continuing past a refusal turns the whole gate sequence into decoration.",
    stage: "implement",
    enabledIn: ALL,
    overridable: false,
  },
  {
    id: "prompt.cannot-widen-scope",
    title: "A prompt cannot widen scope or skip a gate",
    reason: "Scope comes from the task graph; text in a prompt is intent, not authorization.",
    stage: "implement",
    enabledIn: ALL,
    overridable: false,
  },
];

const BY_ID = new Map(RULES.map((rule) => [rule.id, rule]));

export function findRule(id: string): Rule | undefined {
  return BY_ID.get(id as RuleId);
}

/** Rules on by default in a given strictness mode. */
export function defaultRuleState(mode: StrictnessMode): Record<RuleId, boolean> {
  const state = {} as Record<RuleId, boolean>;
  for (const rule of RULES) state[rule.id] = rule.enabledIn.includes(mode);
  return state;
}
