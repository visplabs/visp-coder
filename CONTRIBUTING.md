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
| `pnpm test:coverage:trust` | Coverage for the trust-boundary modules |
| `pnpm test:package` | Pack and install the package into a disposable consumer |
| `pnpm check` | typecheck, lint, knip, build and test |
| `pnpm release:check` | `check` plus browser, qualification, trust coverage and package tests |

`pnpm release:check` is the release gate and runs before publishing (`prepublishOnly`). CI
(`.github/workflows/ci.yml`) runs the same scripts as parallel jobs, with `pnpm test` in four
shards; keep the two in step when a script changes.

## Releasing

1. On `develop`, set `version` in `package.json` and give `CHANGELOG.md` a `## <version> - <date>` section.
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

The maintainer's agent workflow is recorded in [docs/adr/0001-agent-sdlc.md](docs/adr/0001-agent-sdlc.md). A feature's spec lives in its GitHub issue as fenced YAML blocks (`intent@1`, `acceptance@1`, `test-cases@1`); the schemas are in `scripts/sdlc/schemas/`.

| Command | What it does |
| --- | --- |
| `pnpm sdlc pull F-12` | Copy the owner's words of issue #12 into `.sdlc/features/F-12/owner-text.md`, its spec blocks into `spec/`, and each task sub-issue's `task@1` block into `tasks/T-<n>/task.yml`, read-only |
| `pnpm sdlc validate <file...>` | Check YAML files against the schema each names |
| `pnpm sdlc trace F-12 [--results <vitest json>]` | Follow every clause to criteria, test cases and results; exit 1 on an error |
| `pnpm sdlc packet F-12 [--results <vitest json>]` | Write the owner packet to `.sdlc/features/F-12/` |

A test case links its test as `<path> > <describe titles> > <test title>`. Produce results with `pnpm exec vitest run <files> --reporter=json --outputFile=results.json`. `.sdlc/` sits in the main checkout and is shared by every worktree.

A feature starts with two owner-only commands. They have `disable-model-invocation`, so no agent can run them, and the `owner-commands.mjs` hook (UserPromptExpansion) does the work under the owner's own GitHub login rather than the agent bot's:

- `/feature <your request>` opens a feature issue (label `sdlc:feature`) holding your words verbatim and keeps a local copy; the session then starts `qe-spec`. When `qe-spec` stops, the stop hook checks its spec (valid blocks, your words unchanged, every must clause traced to a criterion and every criterion to a test case) and writes it into the issue with a generated Mermaid mind map.
- `/approve F-12` shows the clauses, criteria and spec hash without approving. `/approve F-12 <hash prefix>` approves exactly that: it refuses if the spec changed since it was shown, then comments the full hash, labels the issue `intent-approved` and locks it. Set `SDLC_OWNER_GH_CONFIG_DIR` if your own gh login is not in the default config directory.

The manager starts each task agent with a line `SDLC-Task: F-12/T-13` in its prompt. These hooks in `.claude/settings.json` then hold the agents to the contract; like the safety hook, they do nothing unless `SDLC_OWNER=1`:

| Hook | Event | What it does |
| --- | --- | --- |
| `owner-commands.mjs` | UserPromptExpansion `feature`, `approve` | Runs `/feature` and `/approve` as described above |
| `agent-contract.mjs` | PreToolUse `Agent` | Refuses `qe-spec` without an `SDLC-Feature: F-12` line and appends your words; refuses a coder, reviewer or QE-verify agent without a task line and appends the owner's words, the task's clauses, criteria and test cases, the role's rules and the report format |
| `scope.mjs` | PreToolUse `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `Bash` | Lets a coder change only its task's `scope.paths`, never `.claude/`, `.github/`, `scripts/sdlc/`, golden snapshots or lint, test and package configuration |
| `biome-feedback.mjs` | PostToolUse `Edit`, `Write`, `MultiEdit` | Tells the agent at once when Biome reports errors in the file it wrote |
| `subagent-stop.mjs` | SubagentStop | Validates the agent's yaml report, checks a coder's changed files against its scope, re-runs `build:fast`, the covering tests and the typecheck (one heavy run at a time), then files the report under `.sdlc/features/<F>/tasks/<T>/` and a worklog entry under `.sdlc/worklog/`. For `qe-spec` it writes the checked spec into the feature issue. A refused report keeps the agent working; after five refusals it stops and the failure is logged |

The stage agents are in `.claude/agents/` and their skills in `.claude/skills/`:

| Agent | Model, effort | Does |
| --- | --- | --- |
| `manager` | sonnet, high | Runs a feature: task sub-issues, stage agents, pull requests, owner packet (`claude --agent manager`) |
| `architect` | opus, xhigh | Records architecture decisions in `docs/adr/` |
| `qe-spec` | sonnet, high | Turns the owner's words into clauses, criteria, a mind map and test cases |
| `coder-s`, `coder-m`, `coder-l` | haiku medium, sonnet high, opus xhigh | Implement one task by size, with unit and integration tests, in their own worktree |
| `reviewer` | opus, high | Reviews a task blind against the owner's words; blocking findings need evidence |
| `qe-verify` | sonnet, high | Runs journeys, end-to-end and performance cases |

Skills: `coding-typescript`, `unit-integration-testing`, `qe-testing`, `performance-testing`. Their rules carry ids (`TS-03`, `UT-02`, ...) that review findings cite.

The owner's `.claude/settings.local.json` turns them on and adds what must not affect other contributors: fork mode off, so each agent keeps its own model and hooks; the agent bot's GitHub identity; and the worktree hook, which starts agent worktrees from `origin/develop` on a `sdlc/<name>` branch, then installs and builds:

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
