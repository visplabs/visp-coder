# Critic

The critic is VISP's independent reviewer. It is a separate model session that receives the original request, the brief's outcomes, current source, check results and screenshots, and returns a structured assessment with at most three findings. It does not receive the actor's verdicts, earlier approvals or workflow history, and it runs read-only.

An accepted critic response is the product assessment for that selection; the actor does not need to approve its own work as well. When the critic is unavailable, work continues with host review and the missing independent review stays visible. Real check failures and missing evidence remain unresolved either way.

## Launch modes

`critic.launch` decides who starts the reviewer.

### `codex-exec`: VISP launches the reviewer

`visp init --harness codex` writes:

```yaml
critic:
  harness: codex
  launch: codex-exec
```

With this setting, when `visp done` (CLI or MCP) finds that every executed check passed, VISP reserves one critic call and runs one ephemeral `codex exec` session:

- read-only sandbox (`--sandbox read-only`), `--ephemeral`, `--ignore-user-config`, so no personal configuration or skills are loaded;
- the configured `model` and `reasoningEffort`;
- the packet's screenshots attached as images;
- the packet's response schema passed with `--output-schema`.

Where the review runs depends on the host. Over MCP, and from the CLI of hosts other than Codex, it runs in a detached background process that records its own result, so it survives the host ending the command or the agent's turn; `done` waits for it (using the remaining time in a 100-second CLI or 50-second MCP call budget) and returns its findings as the next step. From a Codex worker's CLI (`harness: codex`) it runs inside `visp done`, because Codex's sandbox ends every process a shell command started. The reviewer first confirms it can reach its model; from a sandboxed shell without network it reports itself unavailable without spending a call, and `visp done` should be rerun with sandbox escalation. While it runs, editing, closing and acceptance wait for it.

`visp next` waits within a 100-second CLI or 50-second MCP call budget for a running review. If it returns, `next` reports its findings as the next step (reopen the slice and fix, or continue). If it is still running, `next` returns `action: wait` and the command to run again.

The reviewer first sweeps every stated rule with a concrete input and its common natural variants, including whitespace-only blank lines, empty cells inside ranges, and sign/zero formatting. Stated-rule violations and common inputs take priority within the three-finding cap. Unstated extreme-input overflow, recursion depth, platform limits and out-of-grammar cases are advisory (`required: false`) unless the request explicitly calls for them. Advisory findings remain reported but do not reopen slices, block acceptance, or force middle-slice reviews.

Each review packet lists the required open findings by ID; the reviewer re-checks them and may close a repaired one by citing current passing check executions, even when no failing reproduction was recorded. Findings are required only for departures from the stated request, including a regression of behavior the repository already documents. After a clean review, middle slices skip review until the slice that completes the feature. `visp accept` has the reviewer assess the assembled product first. Once the review budget is spent with findings still open, `visp next` first asks for one repair round per finding in the slice that owns it: the reviewed slice, or for a feature review the slice of the first outcome the finding names (the first slice when it names none). A round counts once that slice's checks all pass on a version after the latest review, and stays counted when another slice's repair later changes shared files. When every finding has had its round, nothing currently fails, and the current version is one a round passed on, `visp next` returns `completion: handoff` and routes to `visp pr`, so the loop ends with a document for the human reviewer rather than cycling. `visp init --harness codex` sets `reasoningEffort: medium`, which matched `high` in weak-worker runs at lower time.

With `webSearch: true` (written by `visp init --harness codex`), the reviewer may run live web searches for public documentation of standards and libraries; it is told never to put project code, data or secrets in a query. Monitoring: every review call's web searches and shell commands are appended to `.visp/features/<id>/reviewer-activity.jsonl`, and `visp pr` lists every query under "Outside access". Set `webSearch: false` to keep the reviewer offline.

Requirements: `critic.harness: codex` and a runnable `codex` CLI. If either is missing, `done` reports why no review happened and the loop continues without one.

### `claude-exec`: VISP launches a Claude reviewer

```yaml
critic:
  harness: claude-code
  launch: claude-exec
  model: claude-sonnet-5-5
```

The same flow as `codex-exec`, with one `claude -p` session per reserved call: `--restricted --safe-mode` with only the Read, Grep and Glob tools (confined to the project and a temporary directory holding the packet's screenshots), so it cannot run commands, edit files or fetch pages; user, project and local settings files, project `CLAUDE.md`, skills, plugins and hooks are not loaded, and nothing can prompt for permission; no MCP servers (`--strict-mcp-config`) and no saved session; the configured `model` and `reasoningEffort` (`--effort`); and the packet's response schema as structured output (`--json-schema`). It uses your Claude Code sign-in. The worker can use any harness. The independent tester runs the same way, as one `claude -p` session in an empty temporary directory (new projects only; tests of an existing codebase with `existingCodeTests` need `codex-exec` with `harness: codex`). Both need the `claude` CLI signed in (`claude auth status`). As for the reviewer, a critic without its own `harness` uses the project's `harness`, so `launch: codex-exec` in a Codex project or `claude-exec` in a Claude Code project starts the tester. The reviewer's model also reads project rules and recalls earlier decisions (`memory.recall`), as one low-effort `claude -p` call. `visp init --harness claude-code` writes `launch: claude-exec`; a project that sets `launch: host` gets no recall. Requirements: `critic.harness: claude-code` and a runnable `claude` CLI signed in for the process that runs `visp done` (checked with `claude auth status` before a call is reserved); `visp doctor` checks both.

#### Independent acceptance tests

With `launch: codex-exec` or `claude-exec`, `visp feature` also starts an independent tester, so it writes while the worker drafts the brief. For a new project, its `codex exec` or `claude -p` session runs in an empty temporary directory with the critic's model at medium effort and receives the original request, not the brief, plan or worker's code. It returns one standard-library test file (Python or Node.js) and, for each test, the request text it relies on. Rules with more than one reasonable reading are returned as `ambiguities`, with the quoted rule, its readings, and the reading most implementations/users expect. The tester does not write assertions for these cases. VISP records the notes in `acceptance-tests.json`, even if the tester declines a file. The tester states that reading as one plain statement. `work` delivers it in CLI and MCP replies as default advice: the worker uses it unless the request, a pinned test or an explicit user decision says otherwise, and reports such a conflict instead of overriding it. Reviewer packets carry the readings so the reviewer checks for a deliberate, conventional choice; a defensible alternative need not be reverted. These are interpretation advice, not new requirements. If the request names no interface a test could use, it declines. Because the tester and reviewer judge the work against the request alone, `visp feature` requires the complete request as `--source-brief` (`-` reads stdin) unless the host's prompt hook recorded it (Claude Code and Codex); a paraphrase is replaced by the recorded prompt.

VISP keeps the file only if it has at least three assertions and **fails on the unimplemented project** (a suite that passes before any work checks nothing). It declines a suite the tester describes as structural-only rather than behavioral. At tester launch, VISP captures a private copy of product sources, including tracked and untracked files, declared ignored inputs, file modes and local symlinks. Each baseline and repair attempt runs on a fresh copy of those launch-time sources, so concurrent worker edits do not discard the suite or change its baseline. Copies are removed afterwards; abandoned copies are swept on a later tester launch. Changes before launch or during capture still prevent an untrustworthy baseline. External symlinks that cannot be isolated are refused. A rejected suite gets one repair round with the failure output. VISP then saves the file under `acceptance/<feature>/` and pins it into the brief's `acceptanceBaseline` with provenance `visp-tester`. Node filenames ending `.test.mjs` or `.spec.mjs` are saved as `.acceptance.mjs`, so `node --test` does not discover them automatically. Run a pinned suite with the command recorded in `acceptance-tests.json`. From then on:

- the tests are protected intent: changing them requires an intent change, which the reviewer document lists; the worker's only route against a wrong test is a dispute ruled by the independent reviewer (below);
- `done` on the last open slice and `accept` run them as `PINNED_1`, and a failure keeps the slice open; `done` on earlier slices runs them for information and reports `acceptanceTests` without blocking;
- `visp pr --full` shows each test with the request text it relies on.

**Disputing a wrong pinned test.** A pinned suite can itself be wrong (an assertion about object key order the request never states, a case the request defines differently, cleanup that throws after every assertion passed). The worker cannot edit it, so it can dispute a *failing* test: `visp done --dispute "<test name>" --reason "<quote the request sentence + why>"` (`visp accept` takes the same flags; MCP: `dispute` and `reason`). The tester's suites print one `FAIL: <exact declared test name>: <reason>` line per failing test; only a declared test on such a line of a run where the pinned suite failed as a blocking check (last slice or `accept`) can be disputed, so a name in a passing or verbose line, or a run on an earlier slice, cannot. A reason of at least 20 characters is required, at most 30 disputes may await a ruling at once (the tester's test guidance, so one defect that fails a whole suite can be disputed in one call and ruled on in one review), a test is filed at most twice (a rejected one needs a product change first), and nothing can be disputed unless VISP itself launches the reviewer (`critic.launch: codex-exec` or `claude-exec`, feature critic on). The reviewer launches even though the pinned check failed only when every failing test of that run has an open dispute; any other failing test still blocks. Open disputes are refreshed to the current failing run when the source changes, or expire when the test no longer fails. The reviewer's packet carries each disputed test's name, the tester's quote, the worker's reason, the bounded failure output (a reason or output shared with an earlier dispute is shown once, then named), the test source around its name and any earlier rulings on that test, and the reviewer rules on each: `upheld` (the request itself contradicts the test, or the failure comes from the test rather than the product; the ruling quotes the request) or `rejected` (the product must satisfy it). Only a review VISP launched and observed can rule, and only on the tests recorded on that attempt at reservation; a native or host-submitted result cannot. An upheld test is waived, with the reviewer's reasoning, in `acceptance-tests.json` and `visp pr`, but only while the critic state holds the attempt that ruled it: a hand edit of the record waives nothing. VISP passes the waived names to every later run of the suite in `VISP_WAIVED_TESTS` (a JSON array), and the tester writes suites that skip them; for a suite that does not read the variable, a run counts as passed when every test on its `FAIL:` lines is waived (the execution says so), so an upheld ruling is never a dead end. A dispute the reviewer leaves unruled gets exactly one more review, then is handed to the human reviewer: `next` points to `visp pr`, which lists it. Without a VISP-launched reviewer nothing can be waived; `next` and `done` say so and tell the worker to satisfy the test or report the disagreement to the user.

`visp work` does not wait for the tester: it reports `independentTests` as `running`, and the tests are pinned whenever the tester finishes. Pinned files are not part of a slice's authorized contract or scope; they are protected by their hashes and the intent-change rule instead, so pinning mid-slice revokes nothing. A feature accepted before the tests arrive is not reopened. A rejected file is kept in the record for inspection. A failed attempt is recorded in `.visp/features/<id>/acceptance-tests.json`; after fixing the environment, run `visp work --feature <id> --retry-tests` to try it again. A retry (also the one a repeated `visp feature` request starts) keeps the mode the tester first started in, recorded in `.visp/features/<id>/tester-launch-mode`: a tester that started on a new project stays in new-project mode after source files are added or committed, and VISP refuses to run one in execution mode, giving the reason, unless `critic.existingCodeTests` is `true`. A feature whose project already pins acceptance checks (`workflow.acceptanceChecks`) does not get a tester. When a feature would get one but VISP launches none (`launch: host`, a harness that does not match the launcher, a missing CLI), `work` reports `independentTests` as `skipped` with the reason. Like the reviewer, the tester runs inside `visp feature` from a Codex worker's CLI and in the background elsewhere.

Candidate and pinned acceptance tests run as local processes with a limited environment: runtime paths and locale are passed, while operator tokens and other environment variables are removed. `HOME` points to the system temporary directory. They can still read files reachable by the VISP process and use the network; run this feature only with test code you trust. Subprocesses inside a host's workspace sandbox may receive `EPERM` even when VISP's own run succeeds; treat that as an environment failure and use in-process assertions where possible.

**New projects only, by default.** The tester runs when the repository has fewer than three tracked source files. On existing codebases, a tester that only reads the code assumed routes, error formats and setup the code does not have, and workers then changed correct code to satisfy the frozen tests. There the worker's own checks and the reviewer carry the work.

**Existing codebases (experimental, opt-in).** `critic.existingCodeTests: true` runs the tester on existing codebases in execution mode:

- it works in a disposable, writable copy of the repository with network access, where it runs the existing program and must base assertions about existing behavior on what it observed;
- its file must include tests of existing behavior for every existing interface its new tests use, using every assertion helper the new tests use; they run alone with `VISP_TEST_SCOPE=existing` and must pass on a fresh copy of the launch-time repository before anything is pinned, so a wrongly assumed format fails there instead of being frozen.

In trials 11 of 14 pinned suites were correct against a reference implementation; the rest assumed wrong setup, status codes or error bodies. A wrong pinned suite pushes the worker to break correct code, so this stays opt-in.

Safety in execution mode: the copy leaves out VISP state, `workflow.blockedPaths` and common secret files (`.env`, `.env.*`, private keys, `.npmrc`, `.pypirc`, `.netrc`); the session's commands get only core environment variables (`PATH`, `HOME` and similar), not tokens or credentials; and every command is logged to `.visp/features/<id>/tester-activity.jsonl` counted by `visp pr`, and listed by `visp pr --full` under "Tester commands with network access". The Codex sandbox still lets the session read other files your user account can read, so enable execution mode only for repositories whose content you trust.

### `host`: the coding host delegates (default when no launch is set)

Without `launch: codex-exec` or `claude-exec`, VISP never starts a model. After checks run, `next` and `status` include `criticAdvice` alongside the normal next action. The host then follows a three-step protocol:

```sh
visp critic --preflight                           # read-only: readiness and requirements
visp critic --prepare --capabilities -            # reserve one call, write the packet
# delegate the packet to the host's reviewer agent, then submit its reply unchanged:
visp critic --attempt <id> --capabilities - --submit <response-file>
```

The capabilities report states what the host actually observed: `harness`, `model`, `reasoningEffort`, `freshContext`, `readOnly` and `images`. Preparation fails before reserving anything if the report does not meet the requirements. `prepare` returns the packet path, image paths, the attempt ID, its deadline and the exact submission command. Submit promptly; the deadline includes delegation.

`visp install` writes a reviewer agent definition for the host:

| Host | Agent definition |
| --- | --- |
| Codex | `.codex/agents/visp-critic.toml` |
| Claude Code | `.claude/agents/visp-critic.md` |
| Cursor | `.cursor/agents/visp-critic.md` |
| Copilot | `.github/agents/visp-critic.agent.md` |

MCP `visp_critic` exposes the same operations (`status`, `preflight`, `prepare`, `submit`, `configure`, `set-policy`, `reconcile`, `restore`). Standard MCP sampling is not used for the critic because it requires a token ceiling.

If a reserved call fails on the host side, record it with `--attempt <id> --failure "<reason>" --failure-kind <kind>` (`host-unavailable`, `permission-denied`, `model-unavailable`, `image-unavailable`, `invocation-failed`, `schema-rejected` or `setup-unverified`). `--not-invoked` marks a failure the host reports before invocation.

## Defaults

| Reviewer host | Model | Effort |
| --- | --- | --- |
| `codex` | `gpt-5.6-sol` | `high` |
| `claude-code` | `claude-sonnet-5` | `high` |
| `cursor` | `gpt-5.6-sol` | `high` |
| `copilot` | `gpt-5.6-sol` | `high` |

`generic` and `opencode` installations have no default reviewer host; set `critic.harness` to one of the four above. An enabled critic without a supported reviewer host is reported as a setup gap.

These are pinned defaults, not a live price optimization. Model availability depends on your plan and client; VISP never substitutes a different model.

## Budgets

| Setting | Default | Range |
| --- | --- | --- |
| `maxCalls` | 3 per feature | 1–6 |
| `timeoutMs` | 180,000 (3 minutes) per call | 1,000–300,000 |
| `maxImageBytes` | 4 MiB per review | 1 KiB–12 MiB |

A feature also has an 18-minute ceiling on total reserved review time. Every reserved call counts, including failed, interrupted or rejected ones, and nothing is retried automatically. Editing the brief, switching phases or turning the critic off and on never refunds calls. When the budget is spent, continue with host review; exhaustion does not approve anything.

VISP does not cap the reviewer's input or output tokens; the host and model own those limits.

## Configuration

Project settings in `visp.yml`:

```yaml
critic:
  harness: codex            # codex, claude-code, cursor, copilot
  launch: codex-exec        # claude-exec, or host (default when unset; init writes codex-exec and claude-exec)
  mode: auto                # auto, manual, both, off
  model: gpt-5.6-sol
  reasoningEffort: high     # low, medium, high, xhigh
  maxCalls: 3
  timeoutMs: 180000
  maxImageBytes: 4194304
  webSearch: false          # codex-exec: monitored reviewer web search
  existingCodeTests: false  # codex-exec: experimental tester on existing codebases
```

Every key is optional. `enabled: false` is the older spelling of `mode: off`.

Personal defaults for future features live in `~/.config/visp/critic-defaults.json` and are managed with `visp critic defaults`:

```sh
visp critic defaults --json                                   # inspect; no changes
visp critic defaults --save --mode both                       # all hosts
visp critic defaults --harness codex --save --model gpt-5.6-sol --reasoning high --max-calls 4
visp critic defaults --harness cursor --save --off            # one host
```

Resolution order: project `visp.yml`, then the saved per-host setting, then the saved global setting, then the built-in default (`auto`). `visp doctor --settings` shows where each value came from.

A feature pins its critic configuration when it is created. Changing defaults never rewrites an existing feature. To change one feature explicitly:

```sh
visp critic --off --reason "User asked for a run without the critic"
visp critic --on                          # resume with the pinned reviewer and remaining budget
visp critic --on --harness codex          # choose a host for a feature that has none
visp critic --mode manual                 # auto, manual, both or off for this feature
visp critic --task T001 --configure -     # explicit model and limits as JSON or YAML
```

Only turn the critic off when the user asks. Setup errors, unavailable models and exhausted budgets are not reasons to disable it.

## Manual feedback from the user

In `manual` or `both` mode, `work` and `next` suggest asking the user for feedback at the first usable slice:

```sh
visp critic feedback --ask "What should improve in this version?"
visp critic feedback --id <request> --reply "<the user's words>"
visp critic feedback --id <request> --defer
```

MCP hosts that support it show a form (`visp_user_feedback`); others receive a handoff for their own question prompt. Feedback returns in the next work context. It spends no critic calls, and silence or a positive reply is not passing evidence.

## Optional consultations

- **Design question before implementation:** `visp critic --phase understanding --question "<decision>" --preflight`. It reviews the proposed brief and existing source, returns up to three findings and stops. Ordinary `work` does not wait for it. It shares the feature's call budget.
- **Source-only advice:** `visp critic --source-only --preflight` when rendering is unavailable. It records findings and limitations only and cannot approve outcomes or judge visuals.

## Candidates

After the first successful execution of a slice, VISP saves the implemented source as a candidate under `.visp/features/<id>/candidates/` (up to 2,000 files and 32 MiB). Status lists candidates with the reviewer's preference, which is an opinion, not a proven optimum. To restore one explicitly:

```sh
visp critic --task T001 --restore <candidate-id> --expected-subject <current subjectDigest>
```

Restore requires current authorization and unchanged intent, stays inside the authorized scope and refuses concurrent edits. It restores source only; checks decide which evidence still applies.

## Response format

Reviewer responses and prepared review sessions share one shape: `{summary, assessments, findings, limitations, resolutions}`. See [product review](product-review.md#prepare-and-submit-a-review) for the fields and rules. Citations must use evidence IDs from the packet; unknown IDs and images outside the selection are rejected, and malformed responses are not rewritten.

## Embedding

Hosts that embed VISP can supply their own reviewer through `ProductCriticHost` (`inspect` and `review`) and call `runProductCritic(workspace, request, host, signal)`. The CLI accepts one through `buildProgram({criticHost, signal})` and the MCP server through `createServer(root, profile, criticHost)`. The adapter's call timing (`adapterCall`) is recorded; cancellation and deadline expiry keep the reserved call spent and discard late responses.
