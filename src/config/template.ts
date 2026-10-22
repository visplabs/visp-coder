import type { Harness, Preset } from "../core/constants.js";
import { DEFAULT_BLOCKED_PATHS, LIMITS } from "../core/constants.js";
import { criticHarnessSchema } from "./critic.js";

/**
 * The commented starter `visp.yml` written by `visp init`. Values shown are the
 * defaults, so the file doubles as documentation of what can be changed.
 */
export function renderConfigTemplate(options: {
  preset: Preset;
  harness: Harness;
  validationCommands: readonly string[];
}): string {
  // An empty YAML list must be written as `[]`: a key followed only by comments
  // parses as null, which would make the file we just wrote fail to load.
  const commands =
    options.validationCommands.length > 0
      ? `\n${options.validationCommands.map((command) => `    - ${command}`).join("\n")}`
      : " []  # for example: - pnpm test";

  return `# visp configuration. Every key is optional; the values below are the defaults.
# Machine-owned state lives in .visp/ and should not be edited by hand.

# Project type detected at init. Init used it to suggest the commands below.
# Changing it later does not regenerate commands or select graph parsers.
preset: ${options.preset}

# The AI coding agent this project installs assets for. Re-run visp install
# after changing this value; editing visp.yml alone does not replace assets.
# One of: claude-code, opencode, codex, copilot, cursor, generic
harness: ${options.harness}

# Critic defaults to auto. mode: auto | manual | both | off controls future features.
# Manual feedback asks the user through the coding host; legacy enabled: false means off.
# Keep its reviewer host when changing installation mode to recover setup.
${criticHarnessSchema.safeParse(options.harness).success ? `critic:\n  harness: ${options.harness}${options.harness === "codex" ? "\n  # After checks pass, VISP launches a read-only codex exec reviewer and returns its\n  # findings from visp done. Use host to delegate through the Codex task instead.\n  launch: codex-exec\n  # Medium matched high on hidden tests in weak-worker runs and took less time.\n  reasoningEffort: medium\n  # The reviewer may search the web for public documentation; visp pr lists every query.\n  webSearch: true" : ""}\n  # enabled: false` : "# Choose a reviewer host before critic review; uncomment to configure.\n# critic:\n#   harness: codex\n#   enabled: false"}

# How much always-resident text the install spends. "minimal" gives a short
# guide and the core product-loop tools — for small models or small context windows; every
# other capability stays reachable as a CLI command. Use "standard" only when
# the model benefits from the full resident guide and MCP surface. Re-run
# visp install after changing this value to update installed assets.
profile: minimal

workflow:
  # Opt-in observed-state review; current remains default pending model evaluation.
  # reviewMode: observation-preview
  # Default until a policy is recorded. For an existing policy, use
  # visp policy set-strictness <mode>: relaxed | standard | strict | locked.
  # locked is strict with overrides refused — no recorded exception waives a rule.
  strictness: standard

  # Default changed-file ceiling; a recorded policy limit takes precedence.
  maxChangedFiles: 40

  # Never writable by an agent, whatever a task's scope says.
  blockedPaths:
${DEFAULT_BLOCKED_PATHS.map((path) => `    - "${path}"`).join("\n")}

  # Commands that prove a change works. Run as argv vectors, never via a shell,
  # so one entry is one command: write "pnpm test" and "pnpm lint" as two, not
  # as "pnpm test && pnpm lint". An entry may also be a list of arguments —
  # ["pnpm", "test", "--", "--reporter=dot"] — for arguments that only look
  # like shell syntax.
  validationCommands:${commands}

  # Display-only regression comparison: off | auto | on.
  # A passing check runs a second time on the old implementation (in a temporary tree, tests kept)
  # to show whether it fails without the change. That run repeats the check's external side effects
  # (databases, services, files outside the project); set off to stop it.
  # auto checks changes to existing implementation; on also checks added files.
  flipCheck: auto

  # lean: one slice, one review at the end by a cheaper reviewer, no tester on a new
  # project. full: the independent loop. A lean feature moves to full when a check fails
  # on two versions, the change is large, or the request lists many requirements.
  profile: lean
  # weak runs every feature with the full profile.
  worker: strong

graph:
  # Languages the repository index extracts from.
  languages:
    - typescript
    - javascript
    - python

  # Extra globs to keep out of the index.
  exclude: []

  # Query bounds are set per request with --depth and --results.

context:
  # Token ceiling for a compiled context pack.
  tokenBudget: ${LIMITS.contextTokenBudget}

  # Maximum source excerpts included in product context.
  maxSnippets: ${LIMITS.maxSnippets}

memory:
  # Earlier-request recall for new features; false turns every memory path off.
  enabled: true

telemetry:
  # Local-only attempt and token records. Never leaves the machine.
  enabled: true
`;
}

/**
 * Validation candidates for init. Only existing npm scripts are candidates;
 * availableValidationCommands additionally checks their local toolchains.
 */
export function suggestedValidationCommands(
  preset: Preset,
  scripts: Readonly<Record<string, string>> = {},
): string[] {
  switch (preset) {
    case "typescript":
    case "react":
    case "node-api":
    case "javascript":
      return ["test", "typecheck", "lint"]
        .filter((script) => script in scripts)
        .map((script) => `npm run ${script}`);
    case "python":
      return ["pytest"];
    case "go":
      return ["go test ./..."];
    case "rust":
      return ["cargo test"];
    default:
      return [];
  }
}
