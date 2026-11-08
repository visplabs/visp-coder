# Contributing

## Setup

Use Node.js 22.16 or later and the pnpm version pinned in `package.json` (`packageManager`).

```sh
pnpm install --frozen-lockfile
pnpm build
```

## Commands

| Command | What it runs |
| --- | --- |
| `pnpm build` | Bundle `dist/` with tsup, including type declarations and the dashboard |
| `pnpm build:fast` | Bundle the CLI only, without `.d.ts` (about 1 s); wipes `dist/ui` |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | Biome over `src` and `tests`; `pnpm format` applies fixes |
| `pnpm knip` | Knip: unused files, exports, types and dependencies, then runtime import cycles |
| `pnpm test` | The default Vitest suite (unit, integration, functional) |
| `pnpm test:unit`, `test:integration`, `test:functional` | One suite |
| `pnpm test:browser` | Real-browser journeys (`tests/browser`); set `CHROME_BIN` to choose the browser |
| `pnpm test:qualification` | Node tests for the qualification helpers |
| `pnpm test:coverage` | Coverage of `src/`, including code reached only through the CLI, in `coverage/merged/` |
| `pnpm test:coverage:trust` | Coverage for the trust-boundary modules |
| `pnpm test:package` | Pack and install the package into a disposable consumer |
| `pnpm check` | typecheck, lint, knip, build and test |
| `pnpm release:check` | `check` plus browser, qualification, trust coverage and package tests |

`pnpm release:check` is the release gate and runs before publishing (`prepublishOnly`). CI
(`.github/workflows/ci.yml`) runs the same scripts as parallel jobs; keep the two in step when a
script changes. `pnpm test` runs in six shards, split by the per-file durations in
`tests/shard-timings.json`. When the `test` shards of a develop run differ by more than a minute,
refresh the durations from that run's `test-timings-*` artifacts with `scripts/ci/shard-timings.mjs`.
The `check` job fails if any job or matrix leg did not pass, including one cancelled before a runner
picked it up.

Coverage counts the CLI processes tests start. With `VISP_CHILD_COVERAGE` set, `tests/child-coverage.ts`
points `NODE_V8_COVERAGE` at a directory for each test file and keeps the merged profile of this
repository's `dist/` scripts. `scripts/ci/coverage-merge.mjs` converts those through the source
maps and adds them to vitest's own coverage, pairing branches, statements and functions by type and
line because the bundle and vitest's transform place some columns differently; anything unpaired is
dropped and reported, never added. Each `test` shard records coverage; the `coverage` job
merges them into the `coverage-report` artifact (`lcov.info`), which the `sonar` job sends to SonarQube Cloud. Processes a test kills write no
coverage, and hooks installed from `.script.mjs` templates are not counted.

## Releasing

1. On `develop`, set `version` in `package.json` and give `CHANGELOG.md` a `## <version> - <date>` section.
   Run a bench batch and use the build yourself for a while, then `pnpm sdlc release-check <version>`: it fails when Sentry holds an unresolved issue first seen in that version.
2. Merge `develop` into `main`.
3. Tag the merge on `main` and push the tag: `git tag v<version> && git push origin v<version>`.

`.github/workflows/release.yml` then checks that the tag matches `package.json` and is on `main`, runs `pnpm release:check`, stages the version on npm with provenance (a prerelease such as `0.5.0-beta.3` goes to the `beta` dist-tag, others to `latest`) and drafts the GitHub release from the changelog section. It needs a stage-only npm granular token ("Read and write (stage only)") in the `NPM_TOKEN` repository secret.

4. Approve the staged version with 2FA, on the package's Staged Packages tab on npmjs.com or with `npm stage list @visporg/visp-coder` and `npm stage approve <stage-id>` (npm 11.15 or later). Approval publishes it.
5. Publish the draft release: `gh release edit v<version> --draft=false`.

The job summary of the release run repeats steps 4 and 5.

**When `pnpm knip` fails**, delete what nothing uses rather than ignoring it; an export that only its own file uses is fine. Code that only tests call is not reported, so check that a function you replace loses its tests too. No import cycles are allowed. If one cannot be avoided, add `cycles.allow` with its exact path and give the reason in the commit.

**Rebuild before running tests.** Several tests run the compiled CLI from `dist/`, and hook and installation tests compare the build ID of the running code with the build that generated the hooks. A stale `dist/` makes them fail, so the test run checks the build ID before it starts and stops at once with one line (`dist is stale (build … != sources …): run pnpm build:fast`). Run `pnpm build:fast` after changing `src/`, `package.json`, `pnpm-lock.yaml`, `tsconfig.json` or `tsup.config.ts`. It wipes `dist/ui`; run `pnpm exec tsup --config tsup.ui.config.ts` when a test needs the dashboard. `pnpm build` is the full build. To run just the tests that cover a change: `pnpm exec vitest run $(node scripts/direct-tests.mjs src/core/exec.ts)`. `AGENTS.md` has the working rules for agents developing this repository.

Browser tests need an installed Chrome or Chromium; VISP never downloads one.

**Size limits.** Biome fails a file in `src/` or `scripts/sdlc/` over 400 lines and a function over 80. Files that were already over a limit are listed in `biome.json` overrides; when you split one, remove it from the list. Do not add new entries.

**Golden gate.** CI runs `node scripts/sdlc/golden-gate.mjs origin/<base>` on pull requests. Any change under `tests/golden/__snapshots__` makes the branch kind (b), and then a commit body must say "Kind (b)" and which snapshots changed. Run it locally before pushing.

**Agent safety hook.** `.claude/settings.json` registers `scripts/sdlc/hooks/safety.mjs` for Claude Code's Bash tool. It refuses force pushes, pushes to `main` or `develop`, tags, `gh pr merge`, releases, publishing, branch and worktree deletion, `git clean -x`, credential reads, changes to the GitHub identity agents run under (`GH_CONFIG_DIR`, `GH_TOKEN`), and editing, deleting or unlocking issues, where specs and approvals live. It does nothing unless `SDLC_OWNER=1` is set, for example in `.claude/settings.local.json` under `env`, so it only affects the maintainer's agent sessions.

## Agent SDLC

The maintainer's agent workflow is recorded in [docs/adr/0001-agent-sdlc.md](docs/adr/0001-agent-sdlc.md), and its move to Jira in [docs/adr/0002-sdlc-on-jira.md](docs/adr/0002-sdlc-on-jira.md). Work is tracked in the Jira project and Confluence space that `sdlc.config.json` names, by id. An epic is a feature: it holds the owner's words and the spec as fenced YAML blocks (`intent@1`, `acceptance@1`, `test-cases@1`). Each task is a Jira Task under the epic, holding one `task@1` block, and becomes one pull request. The schemas are in `scripts/sdlc/schemas/`.

| Command | What it does |
| --- | --- |
| `pnpm sdlc pull VISP-12` | Copy epic VISP-12 into `.sdlc/features/VISP-12/`, read-only: the owner's words, the spec under `spec/`, whether the owner approved that exact spec (`spec/approval.yml`), and each task's `task.yml` and `ticket.yml` (status, link) |
| `pnpm sdlc validate <file...>` | Check YAML files against the schema each names |
| `pnpm sdlc trace VISP-12 [--results <vitest json>]` | Follow every clause to criteria, test cases and results, and check each criterion is in exactly one task; exit 1 on an error |
| `pnpm sdlc packet VISP-12 [--results <vitest json>] [--notes <file>]` | Write the owner packet to `.sdlc/features/VISP-12/`, with the manager's retro notes |
| `pnpm sdlc jira show\|create-task\|edit-task\|move\|comment ...` | Jira as the agent bot user; only the `clerk` agent may write. `edit-task` re-plans a task: before it starts anything but its epic and key may change; once In Progress its scope may only grow, by files or one folder; each change is commented on the ticket and listed in the owner packet |
| `pnpm sdlc review --task VISP-12/VISP-13 --worktree <dir>` | One inner-loop review round on Codex; only the `reviewer` agent runs it |
| `pnpm sdlc sync-status VISP-12` | Move the epic's task tickets forward to match their PRs (In Review while open, Done once merged) and the epic to Done when every task is |
| `pnpm sdlc ci-failures <n> --task VISP-13` | Print a task PR's failed checks and new SonarQube Cloud issues, and log each to the mistake log; the manager runs it when CI fails |
| `pnpm sdlc release-check <version>` | Fail when Sentry holds an unresolved issue first seen in that release in bench, dogfood or QE runs |
| `pnpm sdlc check-pr <n> [--results <vitest json>]` | The CI gate for a task PR (below) |

A test case links its test as `<path> > <describe titles> > <test title>`. Produce results with `pnpm exec vitest run <files> --reporter=json --outputFile=results.json`. `.sdlc/` sits in the main checkout and is shared by every worktree.

**Credentials.** `sdlc` calls Jira as the agent bot user, `visp-agent`: an ordinary Jira user (not an admin) with a scoped API token (`read:jira-work`, `write:jira-work`, `read:jira-user`), since the free plan has no service accounts. Store its `email:token` once in the keyring: `secret-tool store --label "visp-sdlc" service visp-sdlc account visp-agent` (package `libsecret-tools`), and put the date the token expires in `jira.secret.expires`; every Jira call warns in the last 30 days. Treat that token as readable by agents. `sdlc release-check` reads a read-only Sentry token (`event:read`, `project:read`) from `SENTRY_READ_TOKEN` or the keyring entry `visp-sdlc`/`sentry-read`. Your own Jira token is never stored. The Codex reviewer uses its own home, `~/.codex-visp`, which you log in to once with `CODEX_HOME=~/.codex-visp codex login`; its `config.toml` turns off apps, plugins, browser, computer use, hooks and sub-agents.

A feature starts with two owner-only commands. They have `disable-model-invocation`, so no agent can run them; the `owner-commands.mjs` hook (UserPromptExpansion) does the work:

- `/feature <your request>` opens an epic holding your words verbatim and keeps a local copy; the session then starts `qe-spec`. When `qe-spec` stops, the stop hook checks its spec (valid blocks, your words unchanged, every must clause traced to a criterion and every criterion to a test case) and writes it into the epic with a generated Mermaid mind map.
- `/approve VISP-12` only reads. Its first line says whether the spec is approved and, if not, why, listing each approval comment that does not count. Then it shows your words, the clauses, the criteria and one line, `SDLC approval VISP-12 spec <first 12 characters of the hash>`. To approve, post that line as a new comment on the epic from your own Jira account. It counts only while you wrote it, nobody edited it, the hash matches the spec, and it is newer than the epic's last description change; spaces around the line are ignored. A status or label never counts.

Start the pipeline from a terminal with the pipeline settings, which turn off claude.ai connectors (they act as you):

```bash
claude --agent manager --settings scripts/sdlc/pipeline-settings.json
```

The manager starts each task agent with a line `SDLC-Task: VISP-12/VISP-13` in its prompt. These hooks in `.claude/settings.json` hold the agents to the contract; they do nothing unless `SDLC_OWNER=1`, and every refusal is appended to `.sdlc/mistakes.jsonl` for the retro, as are blocking review findings and CI failures:

| Hook | Event | What it does |
| --- | --- | --- |
| `owner-commands.mjs` | UserPromptExpansion `feature`, `approve` | Runs `/feature` and `/approve` as described above |
| `safety.mjs` | PreToolUse `Bash` | Refuses publishing, merging, tags, force pushes, pushes to `main` or `develop`, credential reads (including `.codex*/auth.json`), changing the agent identity, `CODEX_HOME` or model overrides; for agents also direct `codex` calls, `sdlc review` by anyone but the reviewer, Jira writes by anyone but the clerk, and a PR whose task may not ship yet |
| `agent-contract.mjs` | PreToolUse `Agent` | Refuses a task agent without a task line, before the spec is approved, before its ticket is Ready, or past the loop bounds and the epic's budget; appends the contract; drops a `model` or `effort` given on the call; moves a coder's ticket to In Progress |
| `resume-guard.mjs` | PreToolUse `SendMessage` | Counts a resumed task agent as a new round against the same bounds and budget |
| `mcp-guard.mjs` | PreToolUse `mcp__.*` | Lets an SDLC agent call only the MCP tools its `sdlc.config.json` entry lists (none today) |
| `scope.mjs` | PreToolUse `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `Bash` | Lets a coder change only its task's `scope.paths`, never `.claude/`, `.github/`, `scripts/sdlc/`, `sdlc.config.json`, `.sdlc/`, golden snapshots or lint, test and package configuration; keeps every other agent out of `.claude/`, `scripts/sdlc/`, `sdlc.config.json` and `.sdlc/` |
| `biome-feedback.mjs` | PostToolUse `Edit`, `Write`, `MultiEdit` | Tells the agent at once when Biome reports errors in the file it wrote |
| `subagent-stop.mjs` | SubagentStop | Validates the agent's yaml report, checks a coder's changed files against its scope, re-runs `build:fast`, the covering tests (with child coverage on, as in CI) and the typecheck (one heavy run at a time) and records what passed at which commit, then files the report with the commit it covers under `.sdlc/features/<epic>/tasks/<task>/` and a worklog entry. The reviewer's report is filed from the file `sdlc review` wrote, checked by its sha256. A report from an agent that ran on another model than the config sets is not filed. It waits up to 3 s for a report the transcript has not written yet, accepts a handback that is the yaml report without a fence, and files one report per round, so an agent that stops again after handing back is let through. A refused report keeps the agent working; after five refusals in a round it stops and the failure is logged |
| `ticket-status.mjs` | Stop | After each turn of a pipeline session, at most once a minute, moves the tickets of every approved epic forward to match their PRs, as `sdlc sync-status` does |
| `config-guard.mjs` | ConfigChange | During a pipeline session, settings and skill changes do not take effect |

**Loops.** `sdlc.config.json` sets the bounds; a maximum is a ceiling, not a target. The inner loop (coder, then review) runs at least 2 and at most 10 rounds; the verify loop (QE fails, coder fixes) and the CI loop (CI fails, coder fixes) at least 2 and at most 3. A round that arrives by `SendMessage` counts too. The manager waits for CI after every push (`gh pr checks --watch`) and sends a failure back to the coder. Before a PR, the last review must approve the head being shipped, so fixes from QE or CI are reviewed again. An epic has a budget of 40 agent runs and 25 coder runs. Past a bound, the task goes to the owner.

**Inner-loop review.** The `reviewer` agent is a thin Haiku wrapper around `sdlc review`, which runs Codex (`gpt-6.1-sol`, effort `max`) read-only in the coder's worktree on a blind packet: your words, the clauses, criteria and test cases, which criteria the epic's other tasks carry, the commands the stop hook ran and passed at this head, the commits since the last review and earlier findings, but not the coder's report. Codex does not run tests: its sandbox loses child-process output, so they would fail falsely. Codex answers in a strict JSON schema. If Codex fails, the command exits 3 and the manager runs `reviewer-fallback` (Opus) instead; two failures in one epic stop it.

**Test links.** The spec's test cases are written before the code, so their `test` fields are mostly empty. The coder's report links every unit and integration test case to a test (`case: TC-01, test: <path> > <describe> > <title>`), and qe-verify's report gives each journey and performance case its test. The stop hook refuses a report that leaves such a case unlinked or names a test it cannot find passing, then keeps the links as a `test-links@1` block in the task's Jira issue, never the epic, whose edits would void your approval. `sdlc pull` caches them as `links.yml`, and the trace, the packet and the CI gate lay them over the spec's own links.

**CI gate.** `.github/workflows/sdlc-trace.yml` runs `pnpm sdlc check-pr` on every pull request. A PR names its task with a line `Task: VISP-13`. The gate reads Jira with the read-only `visp-ci` key (repository secret `SDLC_JIRA_CI`, `email:token`) and passes only when your approval comment on the epic counts by the rules of `/approve`, with your account id taken from the repository variable `SDLC_OWNER_ACCOUNT_ID`, never from the PR, and every test case of the task's criteria links a test that passes. A PR from an agent branch (`sdlc/...`) without a task line fails; any other PR without one is skipped.

**Crash check for journeys.** For a task with journey criteria, the contract tells `qe-verify` to run its journeys with `VISP_CRASH_LOG=<main checkout>/.sdlc/run/crashes.jsonl` and `VISP_SENTRY_TAGS=task=VISP-13`, and to report the crashes VISP logged as `crashes`. The stop hook counts the log itself since the agent started (crashes tagged with the task, or untagged) and refuses a report that does not match, or that passes with crashes. A journey that passed while a hook crashed underneath, which hosts often ignore, still fails.

**Sentry and SonarQube Cloud.** Sentry is for real runs, not one task's gate: bench runs report to the `bench` environment (set `VISP_BENCH_SENTRY_DSN` for the driver; every run also writes `crashes.jsonl` and the report counts `vispCrashes`), your own sessions to `dogfood` (`VISP_SENTRY_DSN` and `VISP_SENTRY_ENVIRONMENT=dogfood` in your shell), each tagged with the release, command and host. Turn on Sentry's Jira integration so a new issue opens a ticket labelled `from-sentry`. SonarQube Cloud analyses every push and pull request in CI (job `sonar`, `sonar-project.properties`) with the merged coverage, and fails a pull request whose new code fails the quality gate; `pnpm sdlc ci-failures` lists the pull request's Sonar issues with file and line and logs each rule to the mistake log. The job needs the `SONAR_TOKEN` secret, and automatic analysis turned off in SonarQube Cloud first.

The stage agents are in `.claude/agents/`, their models and efforts pinned in `sdlc.config.json` (a test keeps the two equal), and their skills in `.claude/skills/`:

| Agent | Model, effort | Does |
| --- | --- | --- |
| `manager` | Opus 5.5, high | Runs an epic: tasks, stage agents, the inner loop, pull requests, owner packet |
| `qe-spec` | Opus 5.5, xhigh | Turns the owner's words into clauses, criteria, a mind map and test cases |
| `architect` | Opus 5.5, xhigh | Records architecture decisions in `docs/adr/` |
| `coder` | Sonnet 5.5, high | Implements one task with unit and integration tests in its own worktree; fixes findings when resumed |
| `reviewer` | Haiku 5.5, high | Runs `sdlc review` (Codex `gpt-6.1-sol`, max) and hands back the report file |
| `reviewer-fallback` | Opus 5.5, high | Reviews blind when the Codex round failed |
| `qe-verify` | Opus 5.5, high | Runs journeys, end-to-end and performance cases |
| `clerk` | Haiku 5.5, high | Files and moves Jira tickets with `sdlc jira`; decides nothing |

Skills: `coding-typescript`, `unit-integration-testing`, `qe-testing`, `performance-testing`. Their rules carry ids (`TS-03`, `UT-02`, ...) that review findings cite.

The owner's `.claude/settings.local.json` turns the hooks on and adds what must not affect other contributors: fork mode off, so each agent keeps its own model and hooks; the agent bot's GitHub identity; and the worktree hook, which starts agent worktrees from `origin/<baseBranch>` on a `sdlc/<name>` branch, then installs and builds:

```json
{
  "env": {
    "SDLC_OWNER": "1",
    "CLAUDE_CODE_FORK_SUBAGENT": "0",
    "GH_CONFIG_DIR": "/home/<you>/.config/gh-visp-agent"
  },
  "hooks": {
    "WorktreeCreate": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/scripts/sdlc/hooks/worktree-create.mjs\"",
            "timeout": 600
          }
        ]
      }
    ]
  }
}
```

## Project layout

| Path | Contents |
| --- | --- |
| `src/cli/` | Commander program and one module per command group |
| `src/mcp/` | MCP server, tool definitions (`tools/`), resources and reply shaping |
| `src/workflow/product/` | The product loop: brief, work, checks, review, critic, acceptance, `pr` |
| `src/workflow/evidence/` | Capture, control and observation readers |
| `src/testing/` | Browser journey runner and helpers (exported as `@visporg/visp-coder/testing`) |
| `src/config/` | `visp.yml` schema, starter template and critic defaults |
| `src/harness/` | Host installation: instructions, hooks, MCP registration, critic agents |
| `src/graph/` | Tree-sitter repository index and queries (`@visporg/visp-coder/graph`) |
| `src/memory/` | Earlier-request recall |
| `src/runner/` | `visp-runner` (`@visporg/visp-coder/runner`) |
| `src/migration/` | `visp-migrate` |
| `src/core/` | Shared primitives: file transactions, state lock, exec, paths, errors |
| `tests/unit`, `tests/integration`, `tests/functional`, `tests/browser`, `tests/qualification` | Test suites |
| `tests/fixtures/` | Briefs, replies, comparison scenarios and legacy history used by tests |
| `scripts/` | Package smoke test, upgrade qualification, review-calibration preparation, and `sdlc/` (agent safety hook, golden gate, spec schemas and the `sdlc` commands) |
| `bench/` | Benchmark tasks, hidden checks and runners comparing VISP with other workflows ([bench/README.md](bench/README.md)) |

CLI and MCP are thin adapters: decisions and data shapes live in `src/workflow/product/`, so a behavior change normally belongs there with tests for both surfaces.

## Documentation

User documentation lives in `README.md` and `docs/`; record user-visible changes in `CHANGELOG.md` under Unreleased, and new measurements in `docs/research-summary.md`. `tests/unit/harness/documented-workflow.test.ts` parses the browser-journey check in `README.md` and `docs/product-review.md` and the review response example in `docs/product-review.md`; keep them valid when editing.

## Conduct and security

Contributors follow the [code of conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately as described in the [security policy](SECURITY.md), not in a public issue.
