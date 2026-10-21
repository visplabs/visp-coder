# Configuration

## `visp.yml`

`visp init --harness <host>` writes a commented `visp.yml` at the project root. Every key is optional; the values below are the defaults unless noted. Unknown keys are rejected with their path, and the file is never rewritten for you.

```yaml
preset: typescript          # detected at init; react, node-api, typescript, javascript, python, go, rust, generic
harness: claude-code        # claude-code, opencode, codex, copilot, cursor, generic (default generic)
profile: minimal            # minimal or standard

critic:                     # see docs/critic.md
  harness: claude-code
  # launch: codex-exec
  # webSearch: true        # reviewer web search, every query logged (codex-exec only)
  # existingCodeTests: true # experimental: independent tester on existing codebases
  # mode: auto

workflow:
  strictness: standard      # relaxed, standard, strict, locked
  reviewMode: current       # current or observation-preview
  maxChangedFiles: 40
  blockedPaths: [".env", ".env.*", node_modules, dist, build, .git]
  validationCommands: []    # for example: - pnpm test
  acceptanceChecks: []
  flipCheck: auto           # off | auto | on; see workflow.flipCheck below
  # Lean mode (experimental, not yet measured; see docs/workflow.md#lean-mode):
  # draftFirst: off         # off | visual
  # reviewCadence: slice    # slice | feature
  # requestGaps: reviewer   # reviewer | required

graph:
  languages: [typescript, javascript, python]
  exclude: []
  maxFileBytes: 1048576

context:
  tokenBudget: 12000
  maxSnippets: 4

skills:
  enabled: true
  mode: review              # review is the only supported mode
  minSupport: 3
  maxPerPack: 3

memory:
  enabled: true
  recall: true

telemetry:
  enabled: true
```

| Key | Meaning |
| --- | --- |
| `preset` | Project type detected at init; used to suggest `validationCommands`. Changing it later regenerates nothing. |
| `harness` | The coding host `visp install` targets. Rerun `visp install` after changing it; `visp uninstall` removes that host's installation. |
| `profile` | How much always-resident text is installed. `minimal` installs a short guide and the core MCP tools (every other capability stays available as a CLI command); `standard` installs the full guide and all MCP tools. Rerun `visp install` after changing it. |
| `critic` | Reviewer host, launch mode (`host`, `codex-exec`, `claude-exec`), feedback mode, model and budgets. See [the critic guide](critic.md). |
| `critic.webSearch` | With `launch: codex-exec`, lets the reviewer search the web for public documentation; every query is logged and listed by `visp pr`. |
| `critic.existingCodeTests` | Experimental. With `launch: codex-exec`, also runs the independent tester on existing codebases, in a disposable copy with network access. See [the critic guide](critic.md#independent-acceptance-tests). |
| `workflow.strictness` | Default rule strictness until a policy is recorded; afterwards use `visp policy set-strictness <mode>`. `locked` is `strict` with overrides refused. |
| `workflow.reviewMode` | `observation-preview` is an opt-in review mode; see [product review](product-review.md). |
| `workflow.maxChangedFiles` | Changed-file ceiling for an authorized slice. A recorded policy limit takes precedence. |
| `workflow.blockedPaths` | Paths rejected by explicit `visp guard` checks and Claude's edit hook regardless of slice scope. A slash-free pattern matches at any directory depth, without regard to case. Git-listed changes are checked again at commit and `done`; ignored `.env` and `.env.*` files are hashed at authorization and checked at `done`. Ignored build output is not checked after a shell write. Blocked files are left out of the source VISP delivers and of the tester's execution-mode copy. |
| `workflow.validationCommands` | Commands run with every slice's checks as `CONFIG_1`, `CONFIG_2`, … One entry is one command, run without a shell; write `pnpm test` and `pnpm lint` as two entries, or give an argument list such as `["pnpm", "test", "--", "--reporter=dot"]`. |
| `workflow.acceptanceChecks` | `{command, files}` checks pinned into each new feature and run at `visp accept`. |
| `workflow.flipCheck` | `off`, `auto` (default) or `on`. For each passing declared check, VISP runs the check a second time on the old implementation, in a temporary relocated copy of the project (tests kept), to show whether it fails without the change. The result is display only and never gates acceptance. References to the project by its absolute path in copied, overlaid or scanned files are rewritten to the copy, or make the comparison unchecked when they sit in binary or UTF-16 bytes. Other spellings are not detected and can reach the project: a symbolic link to the project directory, escaped forms (JSON `\/` or `\u002F`, URL `%2F`, `\x2F` in source strings) and paths the check builds at run time (for example from `HOME`). The check's external side effects (databases, services, files outside the project) happen again. Set `workflow.flipCheck: off` for checks that must not run twice. `auto` compares changes to existing implementation; `on` also compares added files. A comparison is skipped and reported unchecked when the project has git-ignored state it cannot reproduce. |
| `workflow.draftFirst` | Lean mode, experimental. `visual` lets a picture request (an SVG, pixel or voxel art, an image or illustration, not a game, app, API or engine) start with `visp work` and no check: the worker drafts the whole picture, then declares its check with `visp work --check`. Default `off`. See [lean mode](workflow.md#lean-mode). |
| `workflow.reviewCadence` | Lean mode, experimental. `feature` reviews only the slice that completes the feature, and a review after the second runs only while a required finding is open. Default `slice`. |
| `workflow.requestGaps` | Lean mode, experimental. `required` makes every reviewer finding that begins "Request gap:" required and shows the other findings as notes the worker is told not to act on. Default `reviewer`, which keeps the reviewer's own labels. |
| `graph.languages`, `graph.exclude`, `graph.maxFileBytes` | What the repository index parses. |
| `context.tokenBudget` | Approximate budget for the complete context `work` delivers. |
| `context.maxSnippets` | Maximum source excerpts in delivered context. |
| `skills.*` | Skill selection: `minSupport` closed slices a derived proposal must cite; `maxPerPack` admitted skills per context (0 selects none). |
| `memory.enabled` | Enable project notes and earlier-request recall. |
| `memory.recall` | With a reviewer VISP launches (`critic.launch: codex-exec` or `claude-exec`) and no `memory.service`, use its model to select decisions from earlier requests and append them to a new feature's original request and `work` replies. Defaults to `true`; set `false` to skip this recall. A reviewer the host runs (no `critic.launch`, as `visp init` sets up for Claude Code) gives VISP no model to call, so nothing is recalled. |
| `memory.service.command`, `memory.service.select` | Optional Visp Memory CLI and selection mode (`model` or `keyword`) for long-term request decisions. |
| `telemetry.enabled` | Local usage import; activity recording is independent. Records stay on the machine. |

`visp doctor --settings` (MCP `visp_doctor` with `settings: true`) shows each effective value, whether it came from the file or a default, and which controls are inactive.

## Policy and overrides

Rules can be inspected and changed without editing `visp.yml`:

```sh
visp policy show
visp policy set-strictness strict
visp policy set <rule> <on|off>
visp override create <rule> --reason "<why>" --days 3
visp override list
visp override revoke <id>
```

Policy and overrides are stored in `.visp/policy.json` and `.visp/overrides.json` and are committed, so an exception is visible to reviewers.

## Repository index

`visp index` reads the repository without running it and uses tree-sitter to extract definitions, imports, calls, and the tests that cover them, for TypeScript, JavaScript and Python. HTML pages contribute their script chain, so `index.html → main.js` is an edge. Entrypoints (for example an Express route) are recognized from code, not from file names. `visp index --refresh` re-indexes only what changed; `visp work` refreshes the graph when source exists.

```sh
visp query describe                    # what is in this repository
visp query search makeToken            # where is it defined
visp query callers 'src/auth/token.ts#function:makeToken'   # what calls this symbol
visp query testsFor src/auth/token.ts  # what covers it
visp query impact src/auth/token.ts    # what depends on it, transitively
visp query tracePath src/app.ts src/auth/token.ts  # shortest structural path
visp query unknowns                    # what the index could not resolve
```

Other operations are `entity`, `neighbors` and `callees`. `tracePath` takes a source and destination; MCP passes the destination as `to`. `--depth`, `--results`, `--nodes` and `--edges` bound a query (defaults 3, 50, 2,000 and 8,000; maxima 8, 200, 20,000 and 80,000). A truncated answer keeps its unknowns, so a partial result never looks complete. Query receipts include the snapshot ID and creation time, and replies flag source changes newer than that snapshot. MCP exposes `visp_index` and `visp_query`.

## Memory and skills

`visp learn "<note>"` records a project note under `.visp/memory/`; `visp recall [query]` lists notes. `work` delivers up to four matching notes (6,000 bytes) labeled with their source; notes are untrusted context, not instructions.

With the default `memory.recall: true` and a reviewer VISP launches (`critic.launch: codex-exec` or `claude-exec`), each new feature can receive relevant decisions from earlier feature requests: VISP records earlier requests in `.visp/state/request-history.json`, and the reviewer's model, at low effort and seeing only the notes, chooses the ones that constrain the new request. The selected decisions are appended to the feature's original request, so the tester and reviewer see them as part of that request. Set `memory.recall: false` to disable this step when no `memory.service` is configured. VISP calls a model only where the project lets it launch the reviewer, so with a reviewer the host runs (no `critic.launch`, the Claude Code default from `visp init`) nothing is recalled and rules are found by phrase matching; set `critic.launch: claude-exec` to turn both on.

Project rules are different: they are requirements the user stated for all later work, such as "these conventions apply to this change and all later work" followed by a list, or "from now on, never log request bodies". `visp feature` finds them in the user's recorded prompts (never in a worker's text; with `critic.launch: codex-exec` or `claude-exec` the reviewer's model reads them and each must quote the prompt, otherwise phrase matching does), records them in `.visp/rules.json`, and the tester, the reviewer and every `work` reply read the current rules (a later message that replaces or withdraws a rule wins; a removed rule stops applying at once). `visp rules` lists them and `visp rules remove <id>` removes one that was not meant.

With `memory.service` (experimental), [Visp Memory](https://github.com/visplabs/visp-memory) is the long-term store: when a feature starts, VISP records earlier features' requests there and adds the recorded decisions it selects for the new request to that request and to `work` replies. Visp Memory runs locally (SQLite, keyword recall by default); VISP calls its CLI and carries on without it when it fails.

```yaml
memory:
  service:
    command: visp-memory
```

Skills are procedures a person admits into the project. They are advice selected by a trigger; they cannot widen scope, change policy or satisfy a check.

```sh
visp skill catalog                     # bundled skills
visp skill seed <id>                   # copy one in as an inert proposal
visp skill propose --id <id> --file SKILL.md --feature <feature> --from-task T001 T002 T003
visp skill admit <id> --by <reviewer>
visp skill list
visp skill retire <id> --reason "<why>"
```

See [internals](internals.md#skills) for revision, evaluation and rollback records.

## The `.visp/` directory

`init` adds the machine-local parts to `.gitignore`; everything else under `.visp/` is meant to be committed, because a reviewer or CI needs to see what a change declared and what was checked.

| Path | Tracked | Contents |
| --- | --- | --- |
| `features/<id>/brief.yaml` | yes | The authored brief |
| `features/<id>/product-state.json` | yes | Generated slice status, executions, reviews and findings |
| `features/<id>/captures/` | no | Local screenshots and journey receipts |
| `features/<id>/review-sessions/` | yes | Prepared review packets and responses |
| `features/<id>/critic/`, `critic-budget.json` | yes | Critic requests, attempts and the feature's call ledger |
| `features/<id>/candidates/` | no | Local source checkpoints; private inputs are hash-only |
| `features/<id>/acceptance-tests.json` | yes | The independent tester's record: status, tests with their request quotes, the baseline run |
| `features/<id>/reviewer-activity.jsonl`, `tester-activity.jsonl` | yes | Web searches and commands of VISP-launched reviewer and tester sessions |
| `policy.json`, `overrides.json` | yes | Recorded rules and exceptions |
| `project.json` | yes | Preset and project identity |
| `memory/` | yes | Project notes |
| `skills/` | yes | Skill documents, revisions and lifecycle history |
| `exports/`, `migrations/backups/` | yes | History exports and upgrade backups from `visp-migrate` |
| `hooks/` | no | Generated, build-specific hook scripts; reinstall locally after cloning |
| `state/` | no | Local slice authorizations (`state/product-authorizations/`), install records, transaction journals and the writer lock |
| `graph/` | no | The repository index database |
| `session/` | no | Per-session data, including recent user prompts recorded by the host's prompt hook |
| `cache/`, `prompts/`, `reports/` | no | Derived data |
| `status.json` | no | This checkout's active feature and slice |
| `telemetry.json`, `telemetry.json.events/` | no | Local usage records |

Authorizations are per checkout: authorizing a slice on one machine grants nothing elsewhere, which is why CI judges a pull request against the committed brief instead. Let VISP commands write everything under `.visp/`; do not edit generated records by hand.

If a project tracked `.visp/hooks/` before this ignore rule was added, remove those generated files from the Git index once with `git rm --cached -r .visp/hooks/`, then commit the updated `.gitignore`. Each developer's `visp install` recreates the hooks locally.

Pinned acceptance tests live outside `.visp/`, under `acceptance/<feature>/`, and are committed with the feature.

If `.gitignore` deliberately ignores all of `.visp/`, `init` and `visp doctor` respect that choice. Share any evidence needed by reviewers separately.

New setups ignore captures and candidates. For existing setups, `visp init` or `visp-migrate apply` adds those ignore entries; already tracked files remain tracked until you explicitly remove them from the Git index. The tracked trail includes the request and redacted check-output tails (at most 8 KB per command execution). Raw command output remains in `.visp/session/check-output/`. Environment values, recognizable credentials and local paths are masked before storing diagnostic text; review the result before committing or publishing. Authored command definitions retain their exact argument vectors for evidence identity; avoid putting credentials in them.

The rolling trail retains 100 executions, 20 capture runs and 40 captures, plus the latest result for each task/check and any evidence referenced by review or repair history. A 100-execution tail can use about 0.8 MB of output plus metadata; screenshots and source checkpoints can add many megabytes locally. Referenced history can exceed these retention targets. `visp trail prune [--feature <id>]` removes unreferenced local captures and candidates, and the `captures/run-*.json` copies of capture runs that earlier builds wrote (the product state holds those runs); it keeps candidates named by critic history. Share local image artifacts separately when a remote reviewer needs them.
