import { balancedCritic, type CriticConfig } from "../config/critic.js";
import type { Harness, Profile } from "../core/constants.js";
import { DEFAULT_PROFILE } from "../core/constants.js";
import { COMMAND_GUIDE_PATH, commandGuide } from "./command-guide.js";
import { criticAgentAssets } from "./critic-agent.js";
import { CODEX_HOOK_SCRIPT, renderCodexHooks, renderPreToolUseHook } from "./hooks.js";
import {
  renderAgentGuide,
  renderMinimalGuide,
  renderPointerGuide,
  SLASH_COMMANDS,
} from "./instructions.js";
import { renderClaudeSubagent, SUBAGENTS } from "./subagents.js";

/**
 * What each AI coder gets installed. The rules are identical everywhere; the
 * packaging is not — each harness gets one full copy of the guide in the place
 * it can afford, and a compact pointer in the surface it always loads. Claude
 * Code discovers the managed CLAUDE.md reference. Compatibility skills are pointers;
 * the normal command map and guide never depend on loading a custom skill.
 */

export interface Asset {
  readonly path: string;
  readonly content: string;
  /** Written with the executable bit. */
  readonly executable?: boolean;
  /** A generated hook: renders it for the CLI at another path, so the same build matches. */
  readonly render?: (executable: string) => string;
}

export interface HarnessPlan {
  readonly harness: Harness;
  readonly assets: readonly Asset[];
  /** Shown after install; things the user must do by hand. */
  readonly manualSteps: readonly string[];
}

export function planFor(
  harness: Harness,
  profile: Profile = DEFAULT_PROFILE,
  critic: CriticConfig | null = balancedCritic(harness) ?? null,
): HarnessPlan {
  const plan = basePlanFor(harness, profile);
  return {
    ...plan,
    assets: [
      ...plan.assets,
      { path: COMMAND_GUIDE_PATH, content: commandGuide(false, true) },
      ...criticAgentAssets(harness, critic),
      ...codexHookAssets(harness),
    ],
    manualSteps: [
      ...plan.manualSteps,
      ...(harness === "codex"
        ? [
            "Codex runs project hooks only after you trust them: run /hooks in Codex and trust VISP's hooks in .codex/hooks.json, again whenever install rewrites that file (an upgrade can add a hook). `visp doctor` names any hook still untrusted.",
          ]
        : []),
    ],
  };
}

function codexHookAssets(harness: Harness): Asset[] {
  if (harness !== "codex") return [];
  return [
    {
      path: CODEX_HOOK_SCRIPT,
      content: renderPreToolUseHook(),
      executable: true,
      render: renderPreToolUseHook,
    },
    { path: ".codex/hooks.json", content: renderCodexHooks() },
  ];
}

function basePlanFor(harness: Harness, profile: Profile): HarnessPlan {
  if (profile === "minimal") return minimal(harness);

  switch (harness) {
    case "claude-code":
      return claudeCode();
    case "codex":
      return codex();
    case "copilot":
      return copilot();
    case "cursor":
      return cursor();
    case "opencode":
      return opencode();
    default:
      return generic();
  }
}

/**
 * The smallest install that still steers: one short guide plus only the native
 * pointer a harness needs to discover it. Built for small models — every
 * capability the assets do not mention stays reachable as a CLI command.
 */
function minimal(harness: Harness): HarnessPlan {
  const nextCommand = SLASH_COMMANDS.find((command) => command.name === "visp-next");
  const onDemandSkill =
    harness === "opencode" || harness === "codex"
      ? [
          {
            path: ".agents/skills/visp/SKILL.md",
            content: skillFile(
              "Follow `AGENTS.visp.md`. Run `visp next` and carry out the one command it prints.",
            ),
          },
        ]
      : [];
  const nativePointer =
    harness === "copilot"
      ? [
          {
            path: ".github/instructions/visp.instructions.md",
            content: `---\napplyTo: "**"\n---\n\n${renderPointerGuide("AGENTS.visp.md")}\n`,
          },
        ]
      : harness === "cursor"
        ? [
            {
              path: ".cursor/rules/visp.mdc",
              content: `---\ndescription: Scoped, evidence-backed changes with visp\nalwaysApply: true\n---\n\n${renderPointerGuide("AGENTS.visp.md")}\n`,
            },
          ]
        : [];

  return {
    harness,
    assets: [
      { path: "AGENTS.visp.md", content: renderMinimalGuide() },
      ...(harness === "claude-code" && nextCommand
        ? [
            {
              path: `.claude/commands/${nextCommand.name}.md`,
              content: `---\ndescription: ${nextCommand.description}\n---\n\n${nextCommand.body}\n`,
            },
          ]
        : []),
      ...onDemandSkill,
      ...nativePointer,
    ],
    manualSteps: harness === "opencode" ? [] : referenceSteps(harness),
  };
}

function claudeCode(): HarnessPlan {
  return {
    harness: "claude-code",
    assets: [
      // Compatibility pointer only; core operation uses CLAUDE.md and the regular guides.
      {
        path: ".claude/skills/visp/SKILL.md",
        content: skillFile(
          `Follow AGENTS.visp.md; ${COMMAND_GUIDE_PATH} has command examples and recovery.`,
        ),
      },
      ...SUBAGENTS.map((agent) => ({
        path: `.claude/agents/${agent.name}.md`,
        content: renderClaudeSubagent(agent),
      })),
      ...SLASH_COMMANDS.map((command) => ({
        path: `.claude/commands/${command.name}.md`,
        content: `---\ndescription: ${command.description}\n---\n\n${command.body}\n`,
      })),
      // Always resident, so it carries the rules and points at the skill.
      {
        path: "AGENTS.visp.md",
        content: renderAgentGuide(),
      },
    ],
    // The edit hook is wired into .claude/settings.json by install itself.
    manualSteps: [],
  };
}

function codex(): HarnessPlan {
  return {
    harness: "codex",
    assets: [
      // AGENTS.visp.md is the surface Codex actually reads; the skill points back.
      { path: "AGENTS.visp.md", content: renderAgentGuide() },
      {
        path: ".agents/skills/visp/SKILL.md",
        content: skillFile(renderPointerGuide("AGENTS.visp.md")),
      },
    ],
    manualSteps: referenceSteps("codex"),
  };
}

function copilot(): HarnessPlan {
  return {
    harness: "copilot",
    assets: [
      // The instructions file is always-resident, so it carries the pointer
      // and the compact rules; the full guide lives once, in AGENTS.visp.md.
      {
        path: ".github/instructions/visp.instructions.md",
        content: `---\napplyTo: "**"\n---\n\n${renderPointerGuide("AGENTS.visp.md")}\n`,
      },
      { path: "AGENTS.visp.md", content: renderAgentGuide() },
    ],
    manualSteps: [],
  };
}

function cursor(): HarnessPlan {
  return {
    harness: "cursor",
    assets: [
      {
        path: ".cursor/rules/visp.mdc",
        content: `---\ndescription: Scoped, evidence-backed changes with visp\nalwaysApply: true\n---\n\n${renderPointerGuide("AGENTS.visp.md")}\n`,
      },
      { path: "AGENTS.visp.md", content: renderAgentGuide() },
    ],
    manualSteps: [],
  };
}

function opencode(): HarnessPlan {
  return {
    harness: "opencode",
    assets: [
      { path: "AGENTS.visp.md", content: renderAgentGuide() },
      {
        path: ".agents/skills/visp/SKILL.md",
        content: skillFile(renderPointerGuide("AGENTS.visp.md")),
      },
    ],
    manualSteps: [],
  };
}

function generic(): HarnessPlan {
  return {
    harness: "generic",
    assets: [{ path: "AGENTS.visp.md", content: renderAgentGuide() }],
    manualSteps: referenceSteps("generic"),
  };
}

function referenceSteps(harness: Harness): string[] {
  if (harness === "codex") {
    return [
      "Restart the Codex task so it reloads the project instructions activated in AGENTS.md.",
    ];
  }
  if (harness === "opencode") return [];
  if (harness === "generic") {
    return ["Point your coding agent at AGENTS.visp.md, or paste it into its system prompt."];
  }
  return [];
}

function skillFile(body: string): string {
  return `---
name: visp
description: Use for any code change in this project. Keeps edits inside a declared scope and backed by evidence. Trigger when asked to add a feature, fix a bug, or refactor.
---

${body}`;
}
