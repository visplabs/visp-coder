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
| `src/memory/`, `src/skills/` | Earlier-request recall and the skill lifecycle |
| `src/runner/` | `visp-runner` (`@visporg/visp-coder/runner`) |
| `src/migration/` | `visp-migrate` |
| `src/core/` | Shared primitives: file transactions, state lock, exec, paths, errors |
| `tests/unit`, `tests/integration`, `tests/functional`, `tests/browser`, `tests/qualification` | Test suites |
| `tests/fixtures/` | Briefs, replies, comparison scenarios and legacy history used by tests |
| `scripts/` | Package smoke test, upgrade qualification and review-calibration preparation |
| `bench/` | Benchmark tasks, hidden checks and runners comparing VISP with other workflows ([bench/README.md](bench/README.md)) |

CLI and MCP are thin adapters: decisions and data shapes live in `src/workflow/product/`, so a behavior change normally belongs there with tests for both surfaces.

## Documentation

User documentation lives in `README.md` and `docs/`; record user-visible changes in `CHANGELOG.md` under Unreleased, and new measurements in `docs/research-summary.md`. `tests/unit/harness/documented-workflow.test.ts` parses the browser-journey check in `README.md` and `docs/product-review.md` and the review response example in `docs/product-review.md`; keep them valid when editing.

## Conduct and security

Contributors follow the [code of conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately as described in the [security policy](SECURITY.md), not in a public issue.
