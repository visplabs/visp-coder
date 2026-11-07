# 0002: Agent SDLC on Jira, with hooks that hold the loops

Status: accepted, Nov 7 2026. Amends [0001](0001-agent-sdlc.md).

## Context

The owner moved work tracking to Jira (project `VISP`) and documentation to Confluence (space
`VISP`), and set four rules: one Sonnet 5.5 coder, Opus 5.5 for analysis, design and review
decisions, Haiku 5.5 for clerical work; an inner loop of at least 2 and at most 10 review rounds
and at most 3 rounds for the QE and CI fix loops; a Sentry zero-events check; and Codex
`gpt-6.1-sol` at max effort as the inner-loop reviewer. A max review of the plan found that the
claude.ai Atlassian connector acts as the owner, so any agent that reached it could forge an
approval, and that rounds resumed by `SendMessage` escape a hook on the Agent tool.

## Decision

- Jira holds work items, specs and approvals; Confluence holds documents and is never on a gate;
  GitHub holds code and pull requests. `sdlc.config.json` names everything by id.
- Agents reach Jira only through `sdlc` commands as a bot user, never through MCP. A hook
  closes MCP to every SDLC agent, and the pipeline runs with claude.ai connectors off.
- The owner approves by posting a line with the spec hash from their own account. Only that
  comment, unedited and newer than the last spec change, counts.
- Hooks, not prompts, hold the loop bounds, the run budget and the ship rule (the last approving
  review saw the head). Resumes are counted by a `SendMessage` hook.
- The inner-loop review runs on Codex through one command in a locked-down Codex home; a Haiku
  wrapper hands back the report file and its hash, and an Opus agent reviews when Codex fails.
- Every hook refusal goes to `.sdlc/mistakes.jsonl` for the outer loop.

## Consequences

- Pilots need the `visp-agent` bot user's token in the keyring.
- The CI gate keeps reading GitHub issues until it moves to Jira with a read-only `visp-ci` key.
- More rounds cost more: the budget caps an epic at 40 agent runs.
