# visp

VISP is a harness for AI coding agents. It runs an actor–critic loop around the agent's work: the agent (the actor) writes a short brief and builds one usable slice at a time inside an authorized file scope, VISP executes the checks the brief declares, and an independent reviewer (the critic) judges the result against the original request. Findings come back to the agent as the next repair step.

VISP works as a CLI (`visp`) and as an MCP server (`visp serve --mcp`). Both use the same workflow services.

What VISP records as evidence is what it executed itself: check commands, browser journeys and their screenshots, and the reviewer's attributed judgments. The agent's own claims are never evidence.

## Install

Requires Node.js 22.16 or later and a Git repository.

```sh
npm install -g @visporg/visp-coder@beta
```

The package installs three executables: `visp`, `visp-migrate` (backed-up upgrades of saved history) and `visp-runner` (optional experiment runner).

Set up a project for your coding host (`claude-code`, `codex`, `cursor`, `copilot`, `opencode` or `generic`):

```sh
visp init --harness codex
visp install --harness codex --dry-run   # preview what will be written
visp install --harness codex
```

To take VISP out again, run `visp uninstall --dry-run`, then `visp uninstall` (add `--harness <host>` for a host other than the configured one). It reverses `install`: it removes the generated instruction files, `VISP.commands.md`, the VISP block in `AGENTS.md` or `CLAUDE.md`, the hook scripts, the `visp` MCP entry and VISP's Claude Code hook entries (editing only those entries, with the previous text saved under `.visp/state/backups/`), the Git `pre-commit` hook (restoring the hook `install` set aside as `pre-commit.local`) and an unedited CI workflow. A file or hook entry you edited is reported and kept; `--force` removes it too (saving an edited Git hook under `.visp/state/backups/` first). It refuses while a slice is authorized, with or without `--force`: finish the slice with `visp done`. It also refuses a `--harness` other than the installed one. Feature history and project state under `.visp/`, `visp.yml` and the `.gitignore` entries from `init` stay; delete them by hand with `rm -rf .visp visp.yml` if you want them gone.

`init` writes `visp.yml` and `.visp/`. `install` writes the host's instruction files and `VISP.commands.md`, registers the MCP server for Claude Code, Codex, Cursor, Copilot and OpenCode, and installs a Git `pre-commit` scope check. Generic hosts need their MCP server entry configured manually. Claude Code also gets edit, shell, prompt and Stop hooks in `.claude/settings.json`; Codex gets prompt, shell, edit (`apply_patch`) and Stop hooks in `.codex/hooks.json`. Open Codex and trust project hooks with `/hooks` before relying on them, including before headless `codex exec` runs, and again after an upgrade adds a hook (`visp doctor` names any hook still untrusted). Cursor, Copilot, OpenCode and generic hosts have no VISP host hooks, so use `visp done` and the Git hook as their local checks. The MCP and hook entries use the installed CLI path, and generated scripts under `.visp/hooks/` are local to each checkout, so run `visp install` in every clone before coding. Until then the committed Claude Code hooks do nothing, except that an edit is refused while a slice is authorized in that checkout. Commit the setup before starting feature work. `visp doctor` checks the installation. When switching VISP builds, use `visp install --replace-runtime` and restart MCP and host processes using the old build; `--force` only replaces edited files.

## Quick start

```sh
visp feature "Add a retry button to the failed-save banner"
visp work --check "npm test"                  # one slice for the whole request, checked by your tests
# ...implement...
visp done                                     # run checks; independent review
visp next                                     # findings or the next step
visp accept                                   # check the assembled product
visp pr                                       # reviewer document for the pull request
```

Run `visp done`, `verify`, `accept` and `next` with the coding host's maximum shell timeout (at least 10 minutes when supported). VISP prints check progress to stderr and saves each completed execution, so an interrupted run can resume current passing checks. Review polling uses the time remaining in a 100-second CLI or 50-second MCP call budget; long checks can still require a longer host timeout.

In practice the coding agent runs these commands itself. Claude Code and trusted Codex hooks can send it back when it stops early; other hosts rely on instructions and explicit `visp next` calls.
When supplying the original request explicitly, use `--source-brief -` with a quoted heredoc as shown in [the workflow guide](docs/workflow.md#starting-a-feature), so shell characters in the request stay literal.

## The loop

1. **`visp feature "<request>"`** starts a feature and preserves the request with credential patterns and local paths masked. Under Claude Code and Codex, VISP takes it from the user's recorded prompt, so a paraphrase cannot replace it.
2. **`visp work --check "<test command>"`** (the light path) works the whole request as one slice checked by that command. For several independently usable parts, write a brief instead: **`visp brief`** reads or updates `.visp/features/<id>/brief.yaml` (outcomes, behavior examples, decisions, checks and slices), and **`visp work`** authorizes one slice at a time. `work` delivers the relevant outcomes, source excerpts, graph context, findings and memory, allows edits only inside the slice's scope, and refuses a slice with a functional outcome that no declared check exercises.
3. **Independent tests.** With `critic.launch: codex-exec` and `critic.harness: codex`, or `critic.launch: claude-exec` and `critic.harness: claude-code`, an independent tester started by `visp feature` writes acceptance tests from the request alone while the worker proceeds (new projects by default). VISP pins them only if they fail before implementation, and the worker cannot quietly change them.
4. **Implement** within the authorized files.
5. **`visp done`** runs the slice's checks (plus any `workflow.validationCommands`, and the pinned tests on the last slice). If every check passes and `codex-exec` or `claude-exec` is configured, VISP runs the independent reviewer and returns its findings as the next repair step.
6. **`visp next`** reports the next action; fix the findings and run `visp done` again. Required findings reopen the slice.
7. **`visp accept`** reruns the checks against the assembled product and requires a current assessment of every mandatory outcome. Once the review budget (three reviews by default) is spent with findings open, `visp next` hands off to `visp pr` instead, so the loop always ends.
8. **`visp pr`** prints the evidence record for the reviewer: what is not verified first, then the request, the check behind each requirement with its latest executed result, the change against its declared scope, regressions and cost.

A check blocked by the host sandbox (for example, network sockets denied to a test server) is recorded as an environment failure, not a product failure. Rerun the same command with the host's sandbox escalation; do not change the product to work around it.

## A brief

A slice needs an outcome, a bounded write scope and at least one runnable check for its functional outcomes. Checks are argument vectors or command strings run without a shell, or browser journeys that VISP drives in an isolated Chrome/Chromium:

```yaml
outcomes:
  - id: O001
    kind: functional
    statement: Starting the game switches it to the playing state.
    priority: must
checks:
  - id: C001
    command: [node, --test, test/game.test.mjs]
    outcomes: [O001]
    files: [src/game.js, test/game.test.mjs]
    verifierFiles: [test/game.test.mjs]
    environment: node
  - id: C002
    command:
      kind: browser-journey
      journey:
        url: http://localhost:3000/
        viewport: { width: 390, height: 844 }
        actions:
          - { kind: click, selector: '#start', capture: true }
          - kind: wait-for
            selector: '#game'
            attribute: { name: data-state, value: playing }
            timeoutMs: 5000
            capture: true
    outcomes: [O001]
    files: [index.html, src/game.js]
    environment: browser
slices:
  - id: T001
    goal: Start a game from the title screen.
    outcomes: [O001]
    scope:
      allowed: [index.html, src/game.js, test/game.test.mjs]
    checks: [C001, C002]
```

Adapt the selectors, URL and files to the real application. HTTP(S) journeys need the app to be running already. See [the workflow guide](docs/workflow.md) for every brief field and [product review](docs/product-review.md) for browser journeys.

The request and redacted check output are saved in the committed feature trail; `visp pr` includes the request in text intended for publication. Review that trail before committing. Raw command logs stay in ignored `.visp/session/check-output/`; redaction is best effort, and authored command definitions or screenshots can still contain private data.

## Core commands

| Command | Purpose |
| --- | --- |
| `visp init --harness <host>` | Create `visp.yml` and `.visp/` |
| `visp install` | Install host instructions, MCP registration and scope hooks |
| `visp uninstall` | Remove what `install` wrote and still recognizes as VISP's (`--dry-run` previews; `.visp/` and `visp.yml` stay) |
| `visp feature "<request>"` | Start a feature from the original request |
| `visp brief` | Read (`--template`) or update (`--patch -`, `--from -`) the brief |
| `visp work [--task <id>]` | Authorize a slice and deliver its context; `--inspect` reads without authorizing |
| `visp verify` | Run the slice's checks without closing it |
| `visp done` | Run checks, start independent review, close the slice when resolved |
| `visp next` / `visp status` | Read-only: next action / outcomes, progress and open findings |
| `visp capture --from -` | Run an ad hoc browser journey; `--replay <run-id>` reruns a recorded one |
| `visp review` | Prepare or submit a review session against current evidence |
| `visp critic` | Configure and run the independent reviewer; `critic feedback` asks the user |
| `visp reproduce` | Link a failed execution to an open finding before repair |
| `visp observations` | List an outcome's captured output and image paths |
| `visp accept` | Check the assembled product against its mandatory outcomes |
| `visp pr` | Print the feature's evidence record (`--json` for tools, `--full` for the whole handoff) |
| `visp ui` | Open a live, read-only dashboard of the work in your browser |
| `visp index` / `visp query` | Build and query the repository graph |
| `visp rules` / `visp rules remove <id>` | List or remove the rules the user stated for all later work |
| `visp guard` | Check changed files against the authorized scope (used by hooks and CI) |
| `visp trail prune` | Remove local captures and candidates no longer referenced by retained history |
| `visp doctor` | Check the setup; `--settings` explains effective configuration |

CLI text output is compact. `--json` prints the full result envelope. MCP tools reply with compact text plus the complete result in `structuredContent`; pass `detail: true` for full text.

Library callers should obtain a `LoadedWorkspaceState` with `loadWorkspace()` before calling the exported product and observation services. The older `WorkspaceState` shape without `files` remains supported by `resolveFeature()` only.

## Independent review

The critic is a separate model session that receives the original request, current source, check results and screenshots, but not the actor's verdicts or history. It returns an assessment of each outcome and up to three findings. With `critic.launch: codex-exec` (written by `visp init --harness codex`), VISP launches a read-only `codex exec` reviewer itself; the independent tester also runs when `critic.harness: codex`. This needs the Codex CLI signed in, whichever host does the coding. With `critic.launch: claude-exec` and `critic.harness: claude-code`, VISP launches a read-only `claude -p` reviewer instead, and the tester runs as a `claude -p` session too (new projects only). With `launch: host` (the default), the coding host delegates the review to its own subagent using the packet VISP prepares. See [the critic guide](docs/critic.md).

## Results

On VISP's own benchmark (`bench/`: four tasks with hidden checks, Claude Haiku 4.5 as the coding agent, three runs per arm), VISP matched or beat every other arm on every task, most clearly on the larger ones: 35–37 of 38 on a spreadsheet engine against 26–35 for bare coding, Spec Kit and BMAD, and 56–63 of 63 over three rounds on extending an existing codebase against 41–59. It took about as long as Spec Kit (5–18 minutes) and longer than bare coding. With a stronger coding agent the gap was small. The runs are few and the tasks are VISP's own; see [the research summary](docs/research-summary.md) for every number and its limits.

## Documentation

- [Workflow](docs/workflow.md): briefs, slices, checks, scope and the check gate
- [Product review](docs/product-review.md): browser journeys, capture and review sessions
- [Critic](docs/critic.md): independent review setup, launch modes and budgets
- [Dashboard](docs/dashboard.md): `visp ui`, the live local view of checks, reviews and questions
- [Configuration](docs/configuration.md): `visp.yml`, the repository graph and `.visp/`
- [Migration](docs/migration.md): upgrading saved history and the 0.5 removals
- [Runner](docs/runner.md): the optional `visp-runner` experiment runner
- [Internals](docs/internals.md): state integrity, learning records and prompt design
- [Research summary](docs/research-summary.md): what VISP's own experiments have shown
- [Contributing](CONTRIBUTING.md), [code of conduct](CODE_OF_CONDUCT.md), [security policy](SECURITY.md) and [changelog](CHANGELOG.md)

## License

[Apache License 2.0](LICENSE). Copyright 2026 Dineth Keshawa Jayathilaka; see [NOTICE](NOTICE).
