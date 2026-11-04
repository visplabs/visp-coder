# 0001 Agent SDLC

Status: Accepted
Date: 2026-11-02

## Context

The maintainer develops visp-coder mostly through coding agents. Without structure, agents drift
from what was asked, reviewers raise points the request never made, and nothing records whether
each requirement was delivered. This decision is about the maintainer's development setup. It is
not a VISP product feature.

## Decision

- The owner's words anchor every stage. A feature issue holds them verbatim, split into intent
  clauses, with acceptance criteria and test cases as YAML blocks. Specs live in GitHub issues,
  not in the repository.
- Every acceptance criterion cites an intent clause, and every test case cites a criterion.
  `sdlc trace` checks the chain and, with test results, whether each clause is delivered.
- Each stage (QE spec, coding, review, QE verification) is a separate agent with a model suited
  to it. Stages hand back YAML validated against the schemas in `scripts/sdlc/schemas/`.
- Work climbs a validation ladder before the owner sees it: hooks, CI, trace, a blind review
  against the owner's words, QE verification, then the owner packet.
- Agents act under their own GitHub identity, not the owner's, so CI can tell an owner
  approval from an agent's.
- Hooks are opt-in (`SDLC_OWNER=1`), so contributors to the public repository are unaffected.

## Consequences

- Each feature costs more model runs than working without the setup. Trivial changes skip most
  stages; the pilot will show which stages earn their cost.
- The spec is outside git history. GitHub keeps issue edit history, and the approval hash ties
  a merge to the exact spec the owner approved.
- Rollout is in steps: safety hook, golden gate and size limits; contracts and the `sdlc`
  commands; agents and hooks; approval commands; CI trace; pilot.
