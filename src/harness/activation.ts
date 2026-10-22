import type { Harness } from "../core/constants.js";
import { vispError } from "../core/errors.js";
import { sha256 } from "../core/hash.js";
import { err, ok, type Result } from "../core/result.js";
import { lineEndingsNormalized } from "./asset-inspection.js";
import { commandMap } from "./command-guide.js";
import { TOOL_ACCESS_GUIDANCE } from "./instructions.js";

const AGENT_ACTIVATION_FILE = "AGENTS.md";
const ACTIVATION_START = "<!-- visp:instructions:start -->";
export const ACTIVATION_END = "<!-- visp:instructions:end -->";

const LEGACY_ACTIVATION_BODY = `${ACTIVATION_START}
Follow the VISP project instructions in [AGENTS.visp.md](AGENTS.visp.md). Run \`visp next\` before editing and follow the command it prints.
${ACTIVATION_END}`;
// Exact generated command-map v1; frozen bytes are covered by the activation upgrade test.
const PREVIOUS_COMMAND_MAP_HASH =
  "1cb3135422cd7fa12e7925cdac49a2e9f6b9f74bd0ff8ecfba9d416c022b3fac";
/** The tool-access line of the blocks generated before `feature` started a new request. */
const PREVIOUS_TOOL_ACCESS_GUIDANCE =
  "Use VISP MCP tools when connected: `visp_next({})`, then `visp_<command>` schemas; otherwise use CLI `visp next`.";
const ACTIVATION_BODY = `${ACTIVATION_START}
Follow the VISP project instructions in [AGENTS.visp.md](AGENTS.visp.md). The package is visp-coder; the executable is \`visp\`. ${TOOL_ACCESS_GUIDANCE}

${commandMap(false)}

Research relevant uncertainties with host tools; apply conclusions in the brief. Read [VISP.commands.md](VISP.commands.md) for input examples, critic dispatch and recovery. No custom skill is needed. Reviewer configuration is not proof of invocation or quality.
${ACTIVATION_END}`;

export function agentActivationFile(harness: Harness) {
  return harness === "claude-code" ? "CLAUDE.md" : AGENT_ACTIVATION_FILE;
}

export type ActivationStatus = "added" | "current" | "replaced" | "not-required";
export type DeactivationStatus = "absent" | "removed" | "edited";

export interface ActivationPlan {
  readonly status: ActivationStatus;
  readonly content?: string;
}

/** Harnesses that discover project instructions through AGENTS.md. */
export function requiresAgentActivation(harness: Harness): boolean {
  return harness === "codex" || harness === "opencode" || harness === "claude-code";
}

/**
 * Plans the managed AGENTS.md block without touching the file. Text outside
 * the block belongs to the project and is preserved byte-for-byte.
 */
export function planAgentActivation(
  harness: Harness,
  current: string | undefined,
  force: boolean,
): Result<ActivationPlan> {
  if (!requiresAgentActivation(harness)) return ok({ status: "not-required" });

  const source = current ?? "";
  const starts = occurrences(source, ACTIVATION_START);
  const ends = occurrences(source, ACTIVATION_END);

  if (starts.length === 0 && ends.length === 0) {
    return ok({ status: "added", content: appendBlock(source) });
  }

  const start = starts[0];
  const endMarker = ends[0];
  if (
    starts.length !== 1 ||
    ends.length !== 1 ||
    start === undefined ||
    endMarker === undefined ||
    start >= endMarker
  ) {
    return err(
      vispError("ARTIFACT_INVALID", `${agentActivationFile(harness)} has malformed VISP markers`, {
        recovery: `Repair or remove the ${ACTIVATION_START} / ${ACTIVATION_END} block in ${agentActivationFile(harness)}, then rerun visp install`,
      }),
    );
  }

  const end = endMarker + ACTIVATION_END.length;
  const installed = lineEndingsNormalized(source.slice(start, end));
  if (installed === ACTIVATION_BODY) return ok({ status: "current" });

  if (!force && !ownedActivationBlock(installed)) {
    return err(
      vispError(
        "ARTIFACT_INVALID",
        `The VISP block in ${agentActivationFile(harness)} was edited and was left alone`,
        {
          recovery: `Rerun visp install --force to replace only the managed VISP block in ${agentActivationFile(harness)}`,
        },
      ),
    );
  }

  return ok({
    status: "replaced",
    content: `${source.slice(0, start)}${ACTIVATION_BODY}${source.slice(end)}`,
  });
}

/** Removes only the exact VISP-owned block, preserving every surrounding byte. */
export function planAgentDeactivation(current: string | undefined): {
  readonly status: DeactivationStatus;
  readonly content?: string;
} {
  if (
    current === undefined ||
    (!current.includes(ACTIVATION_START) && !current.includes(ACTIVATION_END))
  ) {
    return { status: "absent" };
  }
  if (
    occurrences(current, ACTIVATION_START).length !== 1 ||
    occurrences(current, ACTIVATION_END).length !== 1
  )
    return { status: "edited" };
  const start = current.indexOf(ACTIVATION_START);
  const end = current.indexOf(ACTIVATION_END, start) + ACTIVATION_END.length;
  if (
    start < 0 ||
    end < ACTIVATION_END.length ||
    !ownedActivationBlock(lineEndingsNormalized(current.slice(start, end)))
  ) {
    return { status: "edited" };
  }

  // The line breaks may be CRLF (a checkout converted them); each is taken whole.
  let before = current.slice(0, start);
  let after = current.slice(end);
  const blankLine = /(?:\r?\n){2}$/u;
  const lineBreak = /^\r?\n/u;
  if (blankLine.test(before) && lineBreak.test(after)) after = after.replace(lineBreak, "");
  else if (before === "" && lineBreak.test(after)) after = after.replace(lineBreak, "");
  if (blankLine.test(before) && after === "") before = before.replace(/\r?\n$/u, "");
  return { status: "removed", content: `${before}${after}` };
}

function ownedActivationBlock(block: string) {
  return (
    block === ACTIVATION_BODY ||
    block === LEGACY_ACTIVATION_BODY ||
    block ===
      `${ACTIVATION_START}\nFollow the VISP project instructions in [AGENTS.visp.md](AGENTS.visp.md). ${PREVIOUS_TOOL_ACCESS_GUIDANCE} Follow the next action before editing.\n${ACTIVATION_END}` ||
    block === ACTIVATION_BODY.replace(` ${TOOL_ACCESS_GUIDANCE}`, "") ||
    [
      PREVIOUS_COMMAND_MAP_HASH,
      // Command map that still listed the retired `context` alias.
      "c5f5d4d6e9ff08bbea8ec26bd112c3ea45bcf6fa71146f801db1686b3527f4cd",
      "8270cf288cf35ad035eeec2a5fa0691fe81f28c270e72fda34e1c444f2c796ed",
      "f3f9b71090c28f68ffb29fefaa393d4957698bccaba931b00a1d53a6a800f2a3",
      // `feature` without --check and no `pr` row; then `feature --check`, `pr` and "Start or resume".
      "19516859011879ec1dc1a83964654fdfa55376051de457aace36d94e5199f477",
      "4a0469d78adddc10b8aeec1e8fe539998dfc067eec82748eae497f0c3fe2a7e0",
    ].includes(sha256(block))
  );
}

function appendBlock(source: string): string {
  if (source === "") return `${ACTIVATION_BODY}\n`;
  const separator = source.endsWith("\n\n") ? "" : source.endsWith("\n") ? "\n" : "\n\n";
  return `${source}${separator}${ACTIVATION_BODY}\n`;
}

function occurrences(source: string, needle: string): number[] {
  const offsets: number[] = [];
  let from = 0;
  while (from < source.length) {
    const found = source.indexOf(needle, from);
    if (found === -1) break;
    offsets.push(found);
    from = found + needle.length;
  }
  return offsets;
}
