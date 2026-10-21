# Workflow

A feature is one brief plus the records VISP generates while the agent works through it. The agent authors only the brief; status, executions, reviews and summaries are generated and should not be edited.

## Starting a feature

```sh
visp feature "<goal>" --source-brief - <<'REQUEST'
<original request, verbatim>
REQUEST
visp work --check "<test command>"
```

The quoted heredoc preserves backticks and other shell characters literally. Under Claude Code (with the installed prompt hook) and Codex, VISP takes the request from the user's recorded prompt; a `--source-brief` is kept only when it quotes that prompt verbatim, for example one request out of a longer message, so a paraphrase cannot replace it. On other hosts pass the complete request. `--risk low|medium|high|critical` records project risk and `--branch` creates a feature branch. The feature is created under `.visp/features/<id>/` with a `brief.yaml` that holds the preserved request and an empty plan. `feature` pins the current critic configuration into the feature; later changes to defaults do not affect it.

Feature ordinals are reserved atomically across local Git refs and linked worktrees. Existing branch tips are inspected before allocation; independent clones can still reserve the same ordinal before exchanging refs. After a checkout switch, absent active features and tasks are ignored; `next` names the current branch and suggests switching back when needed. Bare `work` cannot silently take over an earlier session’s pending new request. With several active host sessions and no caller identity, new grants are left unstamped.

A feature starts from committed work: `visp feature` refuses uncommitted changes and asks for a commit, and never discards them. Two cases start anyway and keep the changes uncommitted, recorded as the new feature's starting point and not attributed to it unless it changes those files further: Git cannot be written (as in Codex's sandbox), or the changes are exactly the work of the active feature, accepted and unchanged since (Claude Code commits only when the user asks, so a worker leaves an accepted feature uncommitted). A file changed or added after the acceptance makes `visp feature` ask for the commit again. After a feature is accepted, a user prompt recorded later that no feature has taken makes `visp next` and bare `visp work` point to `visp feature`; naming the feature (`--feature`) continues it.

The request is committed in `brief.yaml`, `intent.json` and product state and appears in `visp pr` text for publication. VISP masks recognizable credentials, high-entropy tokens and local paths and reports when the initial request was changed. Review the preserved request before sharing it.

## The brief

Read it with `visp brief --template` (editable form, no state change) or `visp brief` (current brief). Update it in one of two ways:

- `visp brief --patch - --reason "<why>"` merges changed fields from stdin. Entries in `outcomes`, `examples`, `decisions`, `checks` and `slices` merge by `id`; entries without an `id` are appended and receive one. Arrays inside an entry (for example `scope.allowed`) replace that field.
- `visp brief --from - --reason "<why>"` replaces the whole brief. Use it to delete entries.

`--check-template command` and `--check-template browser` print an editable check example. Input can also be a project file path instead of `-`. MCP `visp_brief` accepts `patch`, `brief`, `template` and `reason`.

### Fields

| Field | Contents |
| --- | --- |
| `version`, `feature`, `originalRequest` | Owned by VISP; keep them as returned |
| `goal` | One-line summary of the request |
| `outcomes[]` | `id`, `kind` (`functional`, `quality`, `experience`), `statement`, `priority` (`must`, `should`, `could`; default `must`), `provenance` (`user-stated`, `independent`, `agent-proposed`), optional `expectations[]` (`id`, `statement`, optional `viewport`), `source`, `sourceQuote`, `reviewRequired` |
| `examples[]` | Behavior examples: `id`, `title`, `given[]`, `when`, `expected[]`, `outcomes[]` |
| `decisions[]` | `id`, `statement`, `rationale`, `evidence[]`, `implications[]`, `outcomes[]` |
| `uncertainties[]` | Open questions that could change the implementation |
| `checks[]` | Executable checks (below) |
| `slices[]` | Units of work (below) |
| `acceptanceBaseline` | Pinned acceptance material, kept by VISP |
| `design` | Optional `description`, `references[]`, `refinementCycles` (default 2) |

Functional outcomes need executed evidence. Quality and experience outcomes can also rest on review; an experience outcome needs rendered images to be reviewed.

Changing a method or decision needs only `--reason`. Changing protected intent (outcomes, examples or pinned expectations) needs `--intent-change "<reason>" --provenance "<decision source>"`. That records a claim of authorization; it does not authenticate a person. The original request is never rewritten.

### Normalization

Models often use natural field names. Before strict validation VISP rewrites unambiguous alternatives and lists each rewrite in the reply's `normalized` array. Examples:

- `description`/`text` → `statement`; `then`/`expect` → `expected`; `decision` → `statement`, `reason`/`why` → `rationale`
- `outcome`, `verifies` or `covers` → `outcomes`; a string where a list belongs → a one-item list
- outcome kinds such as `behavior`, `performance` or `ux` → `functional`, `quality` or `experience`
- slice IDs like `S1` → `T001`; a scope given as a list → `scope.allowed`; `exclude`/`blocked` → `forbidden`
- a check's top-level `journey` → `command.journey`
- acceptance criteria placed in `acceptanceBaseline` → expectations of the named outcome

Anything ambiguous is still refused with the invalid field paths.

## Slices and scope

```yaml
slices:
  - id: T001
    goal: Retry a failed save from the banner.
    outcomes: [O001]
    dependsOn: []
    scope:
      allowed: [src/save.js, test/save.test.mjs]
      expected: [src/save.js]
      forbidden: []
    checks: [C001]
    approach: Keep the edited text until persistence succeeds.
    taskClass: bugfix   # optional: feature, bugfix, refactor, test, docs, chore, config
```

`scope.allowed` is the set of paths the agent may change while the slice is authorized; `expected` names the files the slice should touch; `forbidden` narrows `allowed`. `workflow.blockedPaths` from `visp.yml` refuse explicit guard checks and Claude edit-tool writes regardless of slice scope. Slash-free blocked patterns match at any depth, case-insensitively. Git-listed changes are checked at commit and `done`, and ignored `.env*` files are checked against the authorization baseline at `done`; other ignored files written through a shell are outside those after-the-fact checks. Keep the first slice to one usable behavior, including its result and failure path, before expanding.

Scope is enforced by `visp guard`, which the installed hooks call: the Claude Code edit hook before each write, the Git `pre-commit` hook before each commit, and, if installed with `visp install --hooks claude git ci` (or `--hooks git ci` outside Claude Code), a CI job that checks the pull request diff against the slice scopes in the union of committed briefs for features changed in the PR diff or matching the branch (`visp guard --scope tasks`). `--hooks` replaces the default hook set, so include the local hooks you still need. Changing scope requires a brief update and a new `visp work`.

## Checks

A check is either a command or a browser journey:

```yaml
checks:
  - id: C001
    command: [node, --test, test/save.test.mjs]   # or a string: "npm test"
    outcomes: [O001]
    files: [src/save.js, test/save.test.mjs]
    verifierFiles: [test/save.test.mjs]
    environment: node                              # node, browser or other
    timeoutMs: 120000                               # optional per-check timeout
```

- **Commands** run as an argument vector, never through a shell. A string is split into arguments; shell syntax such as `&&`, pipes or `VAR=value` prefixes is refused. Use two checks or a script the project owns.
- **Browser journeys** use `command: {kind: browser-journey, journey: {...}}`. VISP drives an installed Chrome/Chromium with an isolated profile and records operations, measurements and screenshots. See [product review](product-review.md).
- **`files`** lists the product and test files the check depends on; changes to them make earlier results stale.
- **`environmentVariables`** optionally lists application environment variable names (for example `[APP_MODE, API_ENDPOINT]`) whose values must affect evidence freshness. Declared variables are part of the product identity, so a reader whose shell lacks them sees the evidence as stale: declare only settings that change what the product does, and set them wherever `visp next` runs. Toolchain variables (`PATH`, `NODE_*`, `PYTHON*`, `LANG`, `LC_*`, `TZ`, `CI`) and the browser are not product identity; they decide only whether a passed check may be reused (see Evidence below).
- **`verifierFiles`** lists the assertion program and its helpers, fixtures and configuration. VISP hashes them separately from the product so a repair can be compared against the same verifier. An explicit Node script, preload, global setup, `--env-file` or `--test-rerun-failures` input must be listed, or the check stops before running with an environment failure. Use repository-relative paths.
- **`images`** (command checks only) lists up to four PNG, JPEG, WebP, GIF or SVG files the check writes in every run (an SVG is rendered to PNG in a browser), such as a rendered scene or chart. When the check passes they reach the reviewer as images of that product version. The check must also cover an `experience` outcome naming what the picture must show. See [images from command checks](product-review.md#images-from-command-checks).

A check must exercise behavior to count as functional evidence. Syntax-only or static commands (for example `node --check`) still run but do not establish behavior. A check may not run a VISP workflow command (`visp done`, `visp capture` and similar) against its own workspace.

`workflow.validationCommands` from `visp.yml` run alongside every slice's checks as `CONFIG_1`, `CONFIG_2`, and so on. `workflow.acceptanceChecks` are pinned when a feature is created and run at acceptance.

Checks accept an optional `timeoutMs` (1–3,600,000 ms); command checks otherwise use 10 minutes and browser journeys retain their 60-second journey deadline. Timeouts are recorded as `timed-out`, with advice to inspect the check and its wait budget. On POSIX, VISP terminates the whole owned process group when a check exits, times out or is cancelled. Verbose output is bounded while retaining its beginning and end.

Supervised checks inherit the operator’s environment, including tokens and other credentials, except for shell bookkeeping (`_`, `SHLVL`, `PWD`, `OLDPWD`). Their output is recorded as evidence. Python bytecode is redirected to a private per-user cache outside the project unless `PYTHONPYCACHEPREFIX` is explicitly set. Pinned acceptance tests and their pin-time baseline run with a private `HOME` and temporary directory that VISP removes afterwards, so concurrent runs never share a browser profile lock. A command that could not start (for example, the executable is not installed) is recorded as an environment failure with the note that no product behavior was tested, not as a test failure. The note is short and starts with `missing-command:`; when a check runs `python` (or `pip`) where only `python3` (`pip3`) is installed, `visp work` stops before authorizing edits and prints the `visp brief --patch` that switches the check. VISP only names the patch: it never rewrites a check.

Declared env files remain part of the check identity, but candidate snapshots keep only hashes for ignored files, secret filenames and blocked paths. Such inputs cannot be restored from a candidate. Check output is committed as a redacted tail; raw command output is local in `.visp/session/check-output/`.

## Work, done, next, accept

Untracked, non-ignored files still affect evidence freshness so new source is checked. `work`, `next` and verification name the first untracked file outside all slice scopes and check inputs; ignore generated logs and reports, or declare intended product files before checking. A short list of tool output is the exception: untracked, undeclared caches and litter (`__pycache__/` output, `.pytest_cache/`, `.mypy_cache/`, `.ruff_cache/`, `.coverage`, `.DS_Store`, `.idea/`, `.playwright-mcp/`, and at the repository root `coverage/`, `htmlcov/`, `test-results/`, `playwright-report/`, `logs/`, `*.log`) is neither part of the evidence nor a scope violation. Scripts, pages and native modules (`.py`, `.js`, `.html`, `.so` and similar) are never skipped, not even inside a cache or editor directory or in `logs/`, and neither is a `.pyc` outside `__pycache__/` (it can be imported without source). A check that reads a generated report from `coverage/` or `htmlcov/` must declare it as an input. A path that a slice scope (allowed, expected or forbidden), a check input or a blocked-path rule matches, and any tracked file, is always counted. A wildcard check pattern that starts with `**` or `*` never walks `node_modules`, `dist`, `build` or the other tool directories unless it names them.

Authorizations record the Git commit at `work`. Incoming committed changes whose working content still matches `HEAD` are reported separately and do not count against the slice scope or changed-file limit; local edits on top of them still do.

**`visp work [--task <id>]`** selects the next ready slice (or the named one), checks that it has an outcome, a bounded scope and runnable checks, and authorizes edits in its scope. It returns the objective, scope, relevant outcomes and findings, and source excerpts, trimmed to `context.tokenBudget`. `--inspect` reads the same context without authorizing, probing the environment or refreshing the graph. For slices with browser checks, `work` first confirms an isolated browser can start and capture; `--retry-environment` retries after the host environment is fixed.

**Independent acceptance tests.** With `critic.launch: codex-exec` and `critic.harness: codex` (or `claude-exec` and `claude-code`), `visp feature` starts an independent tester on a new project that writes tests from the original request. VISP keeps them only if they fail against a private launch-time source copy and pins them whenever the tester finishes, even if the worker has since edited the product; `work` does not wait and reports them as `independentTests`. Ambiguous request rules are recorded separately from tests and arrive as default advice with the conventional reading: use it unless the request, a pinned test or an explicit user decision says otherwise, report such a conflict instead of overriding it, and record the choice in the implementation, tests or documentation. Reviewers receive the same readings as advice. See [the critic guide](critic.md#independent-acceptance-tests).

**Light path.** `visp work --check "<test command>"` on a feature without slices creates one slice covering the whole request (scope `**`, the command as its check) and authorizes it; on a slice without checks it declares that check. Use a full brief only for several independently usable parts.

**The check gate.** `work` refuses a slice whose functional outcome is not exercised by any declared check, and returns a patch that adds one:

```
T001 has no runnable check. Declare the command that exercises this slice
(your test runner or a browser journey) before editing.
```

Without a check, `done` has nothing to execute and the reviewer has no evidence.

**`visp verify`** runs the slice's checks without closing it.

**`visp done`** runs the checks and records each execution. When all pass and any required review is current, the slice closes. If `critic.launch: codex-exec` or `claude-exec` is set and every check passed, `done` then starts the independent reviewer and waits for it (using the time left in a 100-second CLI or 50-second MCP call budget), so its findings usually arrive in the same step; see [the critic guide](critic.md). On the last open slice `done` also runs the pinned acceptance tests; on earlier slices it reports them without blocking. While a review is pending, editing, closing and acceptance wait for it.

The reviewer checks stated rules and common natural input variants before optional robustness concerns. Only required findings cause repair routing or reopening; advisory findings remain visible without blocking closure or acceptance.

**`visp next`** is read-only and returns one action with its command. When a background review is running it waits within a 100-second CLI or 50-second MCP call budget; if the review is still running it returns `action: wait` with `visp next --feature <id>` to run again. `visp status` shows outcomes, slice progress, evidence and open findings.

**Host hooks.** For Claude Code, `visp install` wires hooks into `.claude/settings.json` that refuse out-of-scope edits made with Edit, Write and NotebookEdit, record user prompts for `visp feature` (not the host's background-task notifications, which Claude Code delivers as prompts), refuse agent edits under `.visp/` (except drafts) and shell commands that would delete VISP state or pinned tests, refuse a `visp work`, `done`, `verify`, `accept`, `next`, `pr`, `status`, `brief`, `critic` or `review` started as a background task (the worker is told to rerun it in the foreground with a 600000 ms timeout, because the command bounds its own waits and prints the next step; `visp feature` and `visp ui` may still run in the background), and on Stop send the worker back to an unfinished, recently active feature (the same step at most twice; once for a handoff or an unusable environment; six times per session and feature at most). When `visp next` names no feature, as when it points to `visp feature` for a request no feature has taken, only a session that tried an edit since the user's latest prompt is sent back; a refused edit counts. The Stop hook reads `visp next` as an observer (`VISP_OBSERVER=stop-hook`): it trusts the browser capability the worker recorded, so it never demands a capture the sandboxed worker cannot run. The shell hook does not intercept general shell writes. For Codex, it writes the same prompt, shell and Stop hooks to `.codex/hooks.json`, plus an edit hook that refuses an `apply_patch` patch naming any file outside the authorized scope (both ends of a move count) before Codex applies it. An `apply_patch` call whose patch text the hook cannot find is let through and reported by `visp doctor`. Codex runs project hooks only after you trust them with `/hooks`, including for later headless runs, and again after an upgrade adds a hook. Untrusted headless runs have no Stop reminder and no edit check. `visp feature` warns when a Codex request could be read only from the session file, which means the hooks did not run. Edit scope is still checked at commit and by `visp done`.

**`visp accept`** reruns the checks against the assembled product, including pinned acceptance checks (which `done` also runs on the last open slice), and requires a current assessment of every mandatory outcome and expectation. Passing commands alone do not satisfy it.

Run `done`, `verify`, `accept` and `next` with the host's maximum shell timeout (at least 10 minutes when supported). With a Codex worker, the review that `done` starts runs inside the command until the reviewer answers or its own timeout ends, so `done` can take a few minutes. Each check prints progress to stderr; MCP callers requesting progress receive notifications. Every completed execution is saved immediately, and a retry after interruption reuses current passing checks. A completed explicit `verify` or `accept` is rerun on the next fresh invocation.

Environment failures (a missing browser, or denied process, filesystem or socket access) are recorded as `environment-failed`. Follow the recorded cause: for `app-unreachable`, start or restart the app at the reported URL and rerun the journey; for a missing browser or shared library, restore the installation; for a confirmed sandbox denial, use the host's supported escalation. Only deterministic missing-browser failures are reused from the startup probe; transient startup and permission failures are retried. `--retry-environment` explicitly bypasses the cache. Journey timeouts require inspecting authored selectors, expected states and waits.

After a failure, `work` includes the failing output and says whether it describes the current version. Repeated identical failures ask for a different hypothesis.

## Lean mode

Three experimental `workflow` switches, off by default, aim to cut ceremony where the worker is already strong. They are not yet measured against the default; `bench/` holds the comparison.

- **`draftFirst: visual`.** For a picture request, `visp feature` names `visp work` as the next step, and bare `visp work` authorizes one slice covering the whole request (scope `**`) with no check. `next` tells the worker to draft the whole picture in one pass, then declare the command that renders or checks it with `visp work --check "<command>"` and run `visp done`, where review starts. The authorization keeps its pre-draft baseline, so the draft is the slice's own change. A request counts as a picture when it names an SVG, PNG, pixel or voxel art, an image, illustration, drawing, painting, poster, logo, icon, sprite, artwork, isometric view or scene, and names no game, app, website, server, API, endpoint, CLI, library, engine, repository, database, form, dashboard, plugin or extension.
- **`reviewCadence: feature`.** Only the slice that completes the feature starts VISP's reviewer; earlier slices close on their checks, and their outcomes are assessed by that whole-feature review. A middle slice with an open required finding or a pending dispute is still reviewed. After two product reviews, another review runs only while a required finding is open; otherwise `visp next` hands off to `visp pr` as it does for a spent budget.
- **`requestGaps: required`.** The reviewer is told to list what the request names and to begin a finding about a named thing that is missing, broken or unrecognizable with "Request gap:". VISP makes every such finding required, whatever the reviewer's flag. The `done` and `accept` replies list only required findings; the rest arrive under `critic.notes` with advice not to edit for them, and the feedback plan leaves them out.

## Regression gate

`workflow.regressionGate` (experimental, default `off`) runs earlier tests at `visp done` and `visp accept`, after the call's own checks pass.

- **What runs.** In order, up to 12 commands:
  - existing tests linked to a changed file: by the repository index (the tests that import it first, then tests of its importers, up to three steps away; `from package import module` counts), or by convention (a test that names the module's import path or file name, as `call_command("createsuperuser")` does, is named after it, as `test_<module>.py`, or sits in its app's test directory, as `tests/auth_tests/test_management.py` for `django/contrib/auth/management/`);
  - this feature's pinned suite (on a slice that does not run it already) and the checks of its other closed slices;
  - the pinned suites, then the declared checks, of up to ten earlier accepted features, newest first;
  - tests that import no application code (subprocess or HTTP suites), only when they make up at least half of a project's tests and number four or fewer.

  Only files named and written as tests count (`test_*.py`, `*_test.py`, `tests.py`, `*.test.*`, `*.spec.*`, `__tests__/`, with at least one test), and only in the language of the changed code. A test runs through the runner a declared check uses (`tests/runtests.py`, pytest, unittest, `node --test`, vitest, jest, mocha, behind a wrapper such as `./swe-test` too), else Django's `tests/runtests.py`, else the runner the file or project names. In a Python test file, only the classes that mention the changed module run (`label.Class`, `path::Class`). Tests the call's own checks ran, browser journeys and tests added by this work are left out. The reply counts the selection (`selected`: linked to the change, from earlier work, unlinked) and lists what was left out and why, including a time budget of 180 s.
- **How a failure is judged.** A failing command runs once more. A test whose failure differs on that rerun is flaky. A consistent failure then runs on the old code: the baseline from the slice's `visp work` (at `accept`, the last slice's), rebuilt in a temporary copy with the current tests, as the flip check does. Failures are compared by test name and normalized message, not by exit code:
  - passed on the old code, fails now: **regression**;
  - failed on the old code too: **pre-existing**;
  - flaky, timed out, failed to start, or the old code could not run: **unchecked**.
- **What it changes.**
  - The `done` and `accept` replies carry a short `regressionGate` entry.
  - The reviewer packet carries one line with the executed results.
  - `visp next` names a current regression.
  - The advice to run related tests by hand is not shown, since VISP runs them.
  - With `advise`, nothing blocks. With `gate`, a regression keeps the slice open, or the feature unaccepted, and no review is spent until it is fixed. If the request changes that behavior, update the test to the request; a test that fails on the old code does not block.
- **Never a pass by default.** A missing index or baseline, or no test reaching the change, makes the result `unchecked`. Pre-existing and unchecked failures never block.
- **Safety.** The gate never edits or discards work: the old code runs only in a temporary tree, without Python bytecode caches, which its interpreter rebuilds. With `workflow.flipCheck: off`, no command runs twice, so failures are reported but not compared. Results are cached per product version, so the `done` that follows a review does not run them again.

## Repairing a finding

1. Run the declared check that shows the defect.
2. `visp reproduce --finding <id> --execution <execution-id> --reason "<how it reproduces>"` links the failed execution to the finding before editing.
3. Repair, rerun the same check and one adjacent behavior.
4. The reviewer resolves the finding with fresh evidence. A passing rerun alone does not resolve it.

## Evidence rules

- An execution record proves that VISP ran a command or journey and what it returned. Whether the assertions test the right thing is still a review judgment.
- Evidence is bound to the current source, brief contract, VISP build and declared variables. Changing any of them makes affected evidence stale. The toolchain a check ran under (the executable its command selects, `NODE_OPTIONS`, `PYTHON*`, `LD_PRELOAD`, locale, `TZ`, `CI`, the browser) does not make evidence stale to a reader with a different PATH or node, but a passed check is reused only when it ran under the same toolchain: `done` and `accept` run it again otherwise.
- A failed journey stays unresolved until the same journey passes on the repaired product; a different successful journey does not clear it.
- Review judgments are attributed to their reviewer. The actor's statements, printed summaries and self-reported results are not evidence.
- Missing, stale or unavailable evidence keeps an outcome open; it never becomes a pass.

## `visp pr`

`visp pr` prints a Markdown document built from recorded state:

- the preserved request, with recognized credentials and local paths masked;
- an outcomes table with checks and statuses;
- decisions, slice scope and uncommitted changes;
- each check's command and latest executed result, including pinned acceptance checks;
- the independent tests with the request text each relies on, and every intent change;
- independent review attribution, with open findings and their next checks;
- the reviewer's web searches and the tester's commands with network access, when there are any;
- the next step.

`visp handoff` shows the current status in the same form as `status`. Neither command publishes anything.
