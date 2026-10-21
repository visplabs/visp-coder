/**
 * Every constant shared by more than one module. Module-private values stay in
 * their own module.
 */

export const PRODUCT_NAME = "visp";
export const PACKAGE_NAME = "@visporg/visp-coder";

/** Versioned shape returned by `visp guard` and required by generated hooks. */
export const GUARD_PROTOCOL_VERSION = 2;
/** Product persistence generation shared by runtime readers and generated hook fallbacks. */
export const PRODUCT_STATE_VERSION = 3;

/** Machine-owned state directory, relative to the project root. */
export const STATE_DIR = ".visp";
/** User-owned configuration file, relative to the project root. */
export const CONFIG_FILE = "visp.yml";

export const DIR = {
  cache: "cache",
  features: "features",
  evidence: "evidence",
  prompts: "prompts",
  reports: "reports",
  session: "session",
  state: "state",
  hooks: "hooks",
  graph: "graph",
} as const;

export const FILE = {
  project: "project.json",
  status: "status.json",
  policy: "policy.json",
  assetManifest: "asset-manifest.json",
  installState: "install.json",
  skills: "skills.json",
  overrides: "overrides.json",
  telemetry: "telemetry.json",
  session: "session.json",
  graphStore: "graph.db",
  intent: "intent.json",
  research: "research.json",
  spec: "spec.json",
  plan: "plan.json",
  tasks: "tasks.json",
  traceability: "traceability.json",
  verification: "verification.json",
  review: "review.json",
  productAcceptance: "acceptance.json",
  observations: "observations.json",
  pullRequest: "pr.json",
} as const;

/** Harnesses that `visp install` can configure. */
export const HARNESSES = [
  "claude-code",
  "opencode",
  "codex",
  "copilot",
  "cursor",
  "generic",
] as const;
export type Harness = (typeof HARNESSES)[number];
export const DEFAULT_HARNESS: Harness = "generic";

/**
 * How much always-resident text an install spends. `standard` is the full
 * surface; `minimal` is for small models and small context windows — a short
 * guide and a handful of MCP tools, with everything else reachable as CLI
 * commands. Tool overload measurably degrades weak models' tool selection.
 */
export const PROFILES = ["standard", "minimal"] as const;
export type Profile = (typeof PROFILES)[number];
export const DEFAULT_PROFILE: Profile = "minimal";

/** Project presets, ordered by detection specificity. */
export const PRESETS = [
  "react",
  "node-api",
  "typescript",
  "javascript",
  "python",
  "go",
  "rust",
  "generic",
] as const;
export type Preset = (typeof PRESETS)[number];
export const DEFAULT_PRESET: Preset = "generic";

/** How strictly gates refuse. Ordered from most permissive to most restrictive. */
export const STRICTNESS_MODES = ["relaxed", "standard", "strict", "locked"] as const;
export type StrictnessMode = (typeof STRICTNESS_MODES)[number];
export const DEFAULT_STRICTNESS: StrictnessMode = "standard";

/** Workflow stages in canonical order. */
export const STAGES = [
  "feature",
  "research",
  "spec",
  "plan",
  "tasks",
  "context",
  "implement",
  "verify",
  "review",
  "pr",
] as const;
export type Stage = (typeof STAGES)[number];

export const TASK_CLASSES = [
  "feature",
  "bugfix",
  "refactor",
  "test",
  "docs",
  "chore",
  "config",
] as const;
export type TaskClass = (typeof TASK_CLASSES)[number];

export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const TASK_STATUSES = ["pending", "in_progress", "done", "blocked"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Languages the graph extractor understands. */
export const LANGUAGES = ["typescript", "javascript", "python"] as const;
export type Language = (typeof LANGUAGES)[number];

/**
 * Parts of the state directory that are derived, machine-local, or per-worktree.
 * Everything else under `.visp/` is the evidence trail — spec, plan, tasks and
 * the records of what was checked — which belongs in review like any other
 * source of truth about the change.
 */
export const DERIVED_STATE_PATHS = [
  `${STATE_DIR}/features/*/captures/`,
  `${STATE_DIR}/features/*/candidates/`,
  `${STATE_DIR}/${DIR.hooks}/`,
  `${STATE_DIR}/${DIR.cache}/`,
  `${STATE_DIR}/${DIR.graph}/`,
  `${STATE_DIR}/${DIR.session}/`,
  `${STATE_DIR}/${DIR.state}/`,
  `${STATE_DIR}/${DIR.prompts}/`,
  `${STATE_DIR}/${DIR.reports}/`,
  `${STATE_DIR}/${FILE.status}`,
  `${STATE_DIR}/${FILE.telemetry}`,
  `${STATE_DIR}/${FILE.telemetry}.events/`,
] as const;

/** What `init` used to write: one line ignoring the whole trail. */
export const LEGACY_STATE_IGNORE = `${STATE_DIR}/`;

/** Paths never writable by a coding agent, regardless of task scope. */
export const DEFAULT_BLOCKED_PATHS = [
  ".env",
  ".env.*",
  "node_modules",
  "dist",
  "build",
  ".git",
] as const;

/** Directories the repository walker never descends into. */
export const HARD_IGNORED_DIRS = [
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  STATE_DIR,
  "dist",
  "build",
  "coverage",
  ".next",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
] as const;

export const LIMITS = {
  /** Repository walk ceilings. */
  maxFileBytes: 1_048_576,
  maxFiles: 25_000,
  maxWalkDepth: 32,
  /** Tree-sitter parse ceiling per file, in milliseconds. */
  parseTimeoutMs: 2_000,
  /** Context pack shaping. */
  maxSnippets: 4,
  maxSnippetLines: 40,
  maxRegionsPerFile: 8,
  /** Query budgets: default and hard maximum. */
  queryDepth: 3,
  maxQueryDepth: 8,
  queryResults: 50,
  maxQueryResults: 200,
  queryNodes: 2_000,
  maxQueryNodes: 20_000,
  queryEdges: 8_000,
  maxQueryEdges: 80_000,
  /** Default token budget for a context pack. */
  contextTokenBudget: 12_000,
  /** Subprocess ceilings. */
  commandTimeoutMs: 600_000,
} as const;

/** Delimited stdout blocks an agent can parse out of mixed output. */
export const BLOCK = {
  handoff: "VISP_HANDOFF",
  guard: "VISP_GUARD",
} as const;

export const EXIT = {
  ok: 0,
  /** A gate, guard, or evidence check refused. */
  refused: 1,
  /** The command was used incorrectly. */
  usage: 2,
  /** Required state is missing; run the named recovery command. */
  missingState: 3,
  /** Internal failure. */
  internal: 6,
} as const;
