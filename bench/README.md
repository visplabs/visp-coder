# Benchmark harness

Fixed-contract tasks for comparing coding workflows (bare coding, Spec Kit, BMAD and VISP) with the same worker model. Correctness is measured by hidden checks the worker never sees. Results are direction, not proof: few tasks, few repetitions. The results so far are in [the research summary](../docs/research-summary.md).

## Tasks

| Task | Kind | Hidden checks |
| --- | --- | --- |
| `reservations-api` | New HTTP service: inventory reservations with expiry, idempotency and concurrency | 36 core + 8 extended |
| `spreadsheet-cli` | New command-line spreadsheet engine: precedence, ranges, error order, cycles | 38 |
| `reservations-bundles` | Change to an existing multi-module service (`start/`) | 60, including the prior contract |
| `spreadsheet-extend` | Larger change to an existing multi-module engine (`start/`) | 37 regression + 26 new |
| `conventions-carryover` | Two sessions on the existing reservations service: the first states team API conventions and adds a list and an audit log; a fresh second session adds prices, retirement and a reservations list under those conventions | 20 core + 20 new + 9 code + 8 memory |
| `sheet-carryover` | Two sessions on the existing spreadsheet engine: AVERAGE and ROUND, then MEDIAN and directed rounding carrying the empty-statistic rule and digits restriction | 22 core + 14 new + 8 memory |
| `archive-carryover` | Two sessions on the existing reservations service: item archiving and a quantity cap, then bundles and restocking that must preserve those feature decisions | 15 core + 17 new + 7 memory |
| `conventions-carryover-prose` | `conventions-carryover` with the first request stating the conventions in conversational prose instead of a labelled list | as `conventions-carryover` |
| `archive-carryover-raised` | `archive-carryover` after an intermediate feature (`intermediate.md`) raised the quantity cap to 50,000, with ten unrelated earlier requests (`noise.md`) in the store; checks use the raised cap | as `archive-carryover` |
| `slingshot-game` | New browser game: drag-to-launch slingshot, physics, three levels, test hooks on `window.gameTest` | 22 core + 6 UI |
| `catapult-game` | New browser game: catapult with four projectile kinds, three materials, per-level ammunition and three levels | request only; hidden checks not yet published |
| `ps5-controller-svg` | Visual: an SVG of a PS5 controller | none; blind judge, 10 elements + 2 styles |
| `xbox-controller-svg` | Visual: a detailed, constrained SVG of an Xbox controller saved as `xbox-controller.svg` | none; blind judge, 11 elements + 3 styles |
| `voxel-pagoda` | Visual: an isometric voxel pagoda garden | none; blind judge, 3 elements + 4 styles |
| `rainfall-chart` | Visual: a bar chart of Colombo's monthly rainfall from given values | none; blind judge, 7 elements + 2 styles |
| `lighthouse-pixel` | Visual: 64 × 64 pixel art of a lighthouse at sunset | none; blind judge, 6 elements + 5 styles |

- `tasks/<task>/task.md` is the request every arm receives; `start/`, when present, is the existing codebase the project starts from.
- `tasks/<task>/hidden_test.py <project>` runs the project and prints JSON results.
- A two-session task has `session1.md`, `session2.md` and `conventions.md` instead of `task.md`. For `conventions-carryover`, its `code` checks apply conventions that the first session's code already shows; its `memory` checks apply conventions stated only in the first conversation (money in integer `*Cents` fields, soft deletion answering 410 `gone`), so they pass only if the knowledge survived between sessions. `archive-carryover` instead tests feature decisions already expressed in session 1 code: its `memory` checks apply the archived-item restriction to bundles and the quantity cap to restocking. Each memory check includes a forbidden operation, so omitting both carried decisions fails every one.
- `reference/` holds correct implementations used only to validate the oracles; deliberately broken variants (a racy store, injected bugs) were checked to fail.
- A visual task has only `task.md`; `judge.py` scores its final image. The two games are also judged on their first screen.

## Quality benchmark

VISP's quality is measured on what a worker builds with it, against the same worker under another build or workflow:

1. Accuracy: the hidden-check pass rate (`score.py`).
2. Look and feel: the blind visual judge's overall score and checklist passes (`judge.py`), for the visual tasks and the games' first screen.
3. Code quality: the blind code-quality judge's overall score (`code_judge.py`), for every task but the visual ones.
4. Review quality: not measured yet.

### Presets

A preset (`presets.py`) fixes every model in a batch. `setup_arm.py --preset` records it in `arm.json`, the runners copy it into `result.json`, and `report.py` refuses a batch whose runs disagree.

| Preset | Worker | VISP reviewer and tester (`critic`) | Visual judge | Code judge |
| --- | --- | --- | --- | --- |
| `default` | `claude-haiku-4-5-20251001`, default effort | `harness: codex`, `launch: codex-exec`, `reasoningEffort: medium`, `webSearch: true` | Sonnet 5.5, high | Opus 5.5, high |
| `quality-2026-10` | `claude -p --model claude-haiku-5-5 --effort high` | `harness: claude-code`, `launch: claude-exec`, `model: claude-sonnet-5-5`, `reasoningEffort: high` | Sonnet 5.5, high | Opus 5.5, high |
| `quality-2026-10-sonnet` | `claude-sonnet-5-5`, high effort | as `quality-2026-10` | Sonnet 5.5, high | Opus 5.5, high |
| `quality-2026-10-haiku-critic` | as `quality-2026-10` | as `quality-2026-10`, with `model: claude-haiku-5-5` | Sonnet 5.5, high | Opus 5.5, high |

Without `--preset` a run uses `default`, the configuration of the published numbers. Every quality batch uses `quality-2026-10`.

`quality-2026-10-haiku-critic` gives VISP's reviewer and tester the worker's own model, to tell how much of VISP's gain comes from its loop and how much from a stronger reviewer. A `bare` arm runs the same under it as under `quality-2026-10`.

### Batches

```bash
bench/build_visp.sh <base-commit> visp-base && bench/build_visp.sh <candidate-commit> visp-cand
python3 bench/batch.py --batch q1 --preset quality-2026-10 --reps 3 --jobs 4 \
  --tasks rainfall-chart,ps5-controller-svg,lighthouse-pixel,voxel-pagoda,spreadsheet-cli,reservations-api,slingshot-game,sheet-carryover \
  --arms visp:visp-base,visp:visp-cand --dry-run      # print the queue; drop --dry-run to run it
python3 bench/report.py --batch q1 --score --runs     # score what is missing, then report
```

- `batch.py` names runs `<batch>-<task>-<label>-<rep>` (the label is the build name for a VISP arm, or `label=arm`) and queues them repetition by repetition, every task in turn, with the arm order rotating per task, so load and an early stop fall on every arm alike. Session timeouts: games 3600 s, every other task 2700 s. Two-session tasks run with `run_carryover.py --modes fresh` (the second session starts on the first session's project, notes kept); both sessions are recorded and the second is scored.
- It can be restarted: finished runs are skipped, and a run an interrupted batch left unfinished is moved to `$VISP_BENCH_RUNS/discarded/` and redone. Each runner and worker runs in its own session with its pid in the run directory (`runner.pid`, `worker.pid`); before a redo the batch stops any it finds still running there, and on SIGTERM or SIGHUP it stops those of its running runs before exiting. A lock stops two drivers on one batch. It writes `batches/<batch>/manifest.json` and `batch.log`.
- Invalid runs: after each run, `runfacts.py` looks for a usage limit and for a worker failure. A usage limit is one of the CLIs' limit messages ("You've hit your session limit", "… monthly spend limit", "… team's shared budget", "You're out of extra usage", "You're out of usage credits", "you have reached your weekly usage limit", "usage limit reached"), matched only where a failure is reported: a `result.json` whose session ended in error (or whose whole result is such a message), API-error events in the worker transcript, and VISP's records of a failed reviewer or tester call (the critic attempts' `message`, `acceptance-tests.json`'s `reason`). Ordinary tool output such as "Rate limit reached; resets in 30 s" never counts. A worker failure is a session the CLI ended in error (an API error, no response, a wrapper exit); a worker that gives up in its own words stays valid. Either way the run gets `invalid.json` and is never scored (`score.py`, `judge.py` and `code_judge.py` skip it); after a usage limit the batch starts no further runs. `--rerun-invalid` moves invalid runs to `discarded/` and runs them again. An empty `invalid.json` made by hand also excludes a run.
- `report.py` prints Markdown tables for `docs/research-summary.md` and writes `batches/<batch>/report.json`: per task and arm, the mean hidden pass rate, judge score, checklist passes and code-quality score; median wall time and the worker's time split; reviews run and unavailable, pictures delivered to the reviewer, hook refusals and timeouts. Invalid and unfinished runs are listed and excluded. It refuses a batch whose runs or judge files name another preset, worker or judge model. `--score` scores what is missing and judges again where a judge call failed. `--runs` adds one row per run.

### Pairwise judge and cost

- `pairwise.py --batch <batch>` (or `report.py --pairwise`) shows the visual judge each picture task's base and candidate images of the same rep, twice in both orders; a pair is a win only when both orders agree, a split verdict is a tie. Verdicts are cached in `batches/<batch>/pairwise.json`. On five identical PS5 pairs two passes gave 1-3-1 and 1-2-2, so read small tallies as direction.
- `report.py --compare BATCH:LABEL ...` compares arms across batches made under different presets or worker models, for example bare Sonnet 5.5 against VISP with a Haiku 5.5 worker: per task and over all tasks, the mean scores, median wall time, mean cost per run and cost per passed hidden check (the costed runs' summed cost over the hidden checks they passed). Each batch passes its own preset guard and all must use the same judges; it gives no quality-rule verdict, since the arms ran at different times.
- Every `claude` a run starts (the worker, and VISP's reviewer and tester) goes through `claude_shim/claude`, which runs the real CLI unchanged and appends each print-mode JSON result's reported `total_cost_usd` and usage to `<run>/claude-calls.jsonl`. `report.py` shows the mean cost per run, with VISP's own calls in brackets. VISP itself does not keep its reviewer's usage.

### Time

Wall time is the runner's measure over every session. The worker's own transcript (under `~/.claude/projects`) splits it: each gap between consecutive events is counted under the event that ends it (`runfacts.py`).

- `modelSeconds`: gaps ending in an assistant event, the model generating or thinking.
- `vispSeconds`: gaps ending in the result of a Bash command with a step that runs `visp`, or in VISP's Stop hook feedback. A `visp` command started in the background returns at once; the wait for it is idle.
- `idleSeconds`: pure waiting: the result of a command made only of waiting and reading (`sleep`, `tail -f`, `wait`, `pgrep`, `while …; do sleep` loops, `timeout N tail`, reading a background task's output file), of `Monitor`, `ScheduleWakeup` or a task-output tool, and the time from the end of the worker's turn to a background-task notification or a scheduled wake-up.
- `ownCommandSeconds`: gaps ending in any other tool result: the worker's own commands, tests and edits.
- `legacyIdle`: the Oct 13 measure, the sum of all gaps longer than 240 s, kept for comparison. It counted long model turns and long own commands as idle: in one Oct 13 slingshot run, 856 s of legacy idle were 955 s of the worker's own search scripts and 259 s of waiting.

### The quality rule

`report.py` compares the first arm (the base, or `--base`) with each other arm, task by task.

Each task kind has required scores: the hidden pass rate where the task has hidden checks, the judge's overall score and checklist passes for the visual tasks and games, and the code-quality score for every task but the visual ones. Missing output scores the minimum: hidden checks with no result pass nothing, a visual task with no image file is judged on the `index.html` it delivered, as served, and with neither (or a game with no `index.html`) it is judged 1 with no checklist item. A score file that is missing or holds a failed judge call (including the judge's own CLI hitting a limit) gives no score; the run is listed and `--score` judges it again.

A task is incomplete, and fails, unless both arms have the same number of valid runs, at least one, and every required score for each. A candidate passes a complete task when:

- each of its mean required scores is no lower than the base's, and
- its median wall time and median idle time are at most 15% above the base's (idle may also exceed a base under 60 s by up to 60 s). Idle is not compared when neither arm has a Claude Code transcript (Codex workers); with one only, the task is incomplete.

It passes the batch only when it passes every task. The rule has no tolerance for noise: with three repetitions a one-point judge difference can be noise (see the calibration below), so read a failure with the per-run rows.

### Code-quality judge

`code_judge.py <run>` (or `--project <dir> --task <task>`) gives Opus 5.5 at high effort, with only Read, Grep and Glob, a blind copy of the product's own source in an anonymous temporary directory. Left out: version control, workflow state and instructions (`.visp`, `.claude`, `.codex`, `.agents`, `.specify`, `_bmad*`, `specs/`, `CLAUDE.md`, `AGENTS*.md`, `VISP.commands.md`, `visp.yml`), every hidden file, dependencies, caches, images, binaries, paths that name a workflow, and the files VISP's independent tester wrote (the `file` of each `acceptance-tests.json`; the worker did not write them). In every other file, source or document, the workflow names (VISP, Spec Kit, BMAD) are replaced by "workflow", so a README or a test writing under `.visp/` is still judged, and the same rule on both trees keeps an unchanged README out of a change's diff.

A task with a `start/` codebase is judged on the change: the judge gets `before/` (the start), `after/` (the product) and `change.diff`, and is told to judge what was added or modified, not the provided code. Two-session tasks are judged on the project after the second session, with both requests.

The rubric is fixed: correctness risks, structure, readability, naming, tests (do the project's own tests exercise the specified behaviour, or are they trivial or absent) and idiom, each 1 to 10 with a one-line justification, plus an overall score. The CLI has no temperature setting, so each criterion is anchored: the prompt says what 3, 6 and 9 look like. The result is `code_judge.json` beside the project.

#### Calibration (Oct 14 2026)

`calibrate_code_judge.py` judges the eight references and five degraded variants twice each (`--check-oracles` also runs their hidden checks). The script generates the variants from `reference/`, except the hand-written monolith in `calibration/`; results go to `$VISP_BENCH_RUNS/code-judge-calibration`, one file per call, and a rerun repeats no call that has a file. The quality-only variants keep every hidden check passing; the bug variants fail some.

| Case | Degrades | Hidden | Correctness | Structure | Readability | Naming | Tests | Idiom | Overall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| reservations | reference | 44/44 | 6 | 3 | 5 | 5.5 | 1 | 6 | 3 |
| spreadsheet | reference | 38/38 | 5.5 | 6 | 6 | 6 | 1 | 6 | 4 |
| bundles | reference | 60/60 | 8 | 6 | 7 | 7 | 1.5 | 7.5 | 4 |
| spreadsheet-extend | reference | 63/63 | 5 | 6 | 6 | 7 | 1 | 6 | 3.5 |
| slingshot-game | reference | 28/28 | 5 | 5 | 5 | 6 | 1 | 6.5 | 5 |
| carryover | reference | 57/57 | 6 | 7 | 7 | 7 | 5 | 7 | 6 |
| archive-carryover | reference | 39/39 | 8 | 7 | 7 | 7 | 6 | 7 | 7 |
| sheet-carryover | reference | 44/44 | 8 | 7 | 7 | 7 | 7.5 | 7.5 | 7 |
| reservations-racy-bugs | no lock, three contract bugs | 39/44 | **2** | 3 | 5 | 5 | 1 | 5 | 2 |
| reservations-monolith | one long function, short generic names | 44/44 | 5.5 | **2** | **2** | **1** | 1 | 3 | 2 |
| spreadsheet-names | meaningless names, no comments | 38/38 | 5 | 4.5 | **2** | **1** | 1 | 3 | 2 |
| bundles-trivial-tests | provided tests replaced by trivial ones | 60/60 | 6.5 | 6 | 6.5 | 6.5 | **1** | 7 | 2.5 |
| slingshot-bugs | double removal, wrong win and loss rules | 25/28 | **3** | 5 | 5 | 6 | 1 | 6 | 3 |

- Every targeted criterion drops: correctness 6 to 2 and 5 to 3, readability 5 to 2 and 6 to 2, naming 5.5 to 1 and 6 to 1, structure 3 to 2. Overall drops by 1 to 2 points in every variant. The tests variant cannot drop far, because its reference already scores 1.5.
- The references do not score high. They are minimal programs written to qualify the oracles, and the judge marks down what the requests ask for and they leave out: tests (none in the four new projects; none added for the changes in `bundles` and `spreadsheet-extend`) and README updates. It also found a crash the hidden checks miss: `=IF(B1:B2,1,2)` raises an uncaught `#PARSE!` in the `spreadsheet-extend` reference. For a high anchor, the Oct 13 VISP run `r-reservations-api-visp-053-1` (44/44, 63 tests) scored 8 overall and 9 for tests.
- Repeat variance is small: over 91 paired scores the two repetitions differ by 0.15 on average and by at most 1.
- Cost: 30 Opus 5.5 calls in all (26 counted here, 3 that ended with `error_max_structured_output_retries` and were redone, and the Oct 13 check), 397k cache-write, 978k cache-read and 90k output tokens, $5.18. `judge.py`'s `ask` now retries that error once.

## Qualifying the spreadsheet oracles

```bash
python3 -m unittest bench/test_hidden_oracles.py
```

These local checks (spreadsheet-cli, spreadsheet-extend and sheet-carryover) verify that correct references pass, wrong division-error output fails,
and a nonzero program exit fails even when its output matches. They use temporary copies
and the standard library, without calling models. Oracle qualification is not a comparison
of coding workflows.

## Timing the dashboard

`bench/ui/bench-ui.mjs` times `visp ui` against the first-render and live-update targets in [the dashboard specification](../docs/specs/visp-ui.md#16-testing-and-acceptance), on a feature that `tests/integration/ui/large-demo.test.ts` seeds with 20 slices and 200 real executions (or the 110 VISP keeps, with `VISP_UI_LARGE_COMPACT=1`). Usage is at the top of the script; results are in the specification.

## Running

Runs, builds and worker homes live outside the repository, in `$VISP_BENCH_RUNS` (default `~/visp-bench`).

```bash
bench/build_visp.sh HEAD visp-head                          # freeze a VISP commit as a runnable build
python3 bench/setup_arm.py spreadsheet-cli bare r1          # or speckit | bmad | visp:visp-head | visp-codex:visp-head
python3 bench/run_claude.py r1                              # headless Claude Code worker (the preset's; Haiku 4.5 by default)
python3 bench/run_codex.py r1                               # or a headless Codex worker (gpt-5.6-luna, low effort)
python3 bench/score.py spreadsheet-cli r1                   # hidden checks; writes runs/r1/hidden.json

python3 bench/setup_arm.py conventions-carryover visp:visp-head c1
python3 bench/run_carryover.py c1 --modes wiped,fresh,oracle  # session 1 once, then session 2 per mode
python3 bench/score.py conventions-carryover c1/wiped c1/fresh c1/oracle
```

- `setup_arm.py` creates a fresh Git project, installs the arm's workflow and writes the prompt. Spec Kit needs `specify` on `PATH`; BMAD is fetched with `npx`. VISP arms use the preset's VISP-launched reviewer and tester: with `default`, Codex (`critic.launch: codex-exec`, medium effort), so the Codex CLI must be signed in; with the quality presets, Sonnet 5.5 through `claude -p`. `--skill <id>` seeds and admits a bundled VISP skill, so two arms on the same build differ only by that skill.
- `run_claude.py` runs `claude -p` in the project with project settings only, so each workflow's own instructions, skills and hooks apply; Spec Kit's phases are sent as follow-up turns and BMAD's approval prompts are answered, as a user would.
- `run_codex.py` runs `codex exec` with a clean home holding only the Codex sign-in and a workspace-write sandbox with network, with project hooks trusted.
- Each writes `result.json` (duration, turns, tokens) beside the project.
- `run_carryover.py` runs the first session once, records which files gained mentions of the conventions (`session1/carriers.json`) and scores it, then restores that snapshot at the same path before each second-session mode: `wiped` resets the assistant's notes (`.visp/memory`, `CLAUDE.md`, `AGENTS.md`), `fresh` keeps everything, `oracle` restates the conventions in the request, `resume` continues the first conversation. `memory` is `fresh` with Visp Memory as VISP's long-term store (`memory.service`), set up before the second session from `$VISP_BENCH_RUNS/visp-memory-venv`. Claude Code's own auto memory is disabled for every worker, so only what the project holds can carry.

A desktop app or terminal that ends its child processes can stop a long batch; start batches in their own session (for example `systemd-run --user` on Linux). On Linux both runners start each worker in its own user and PID namespace (`unshare`), so a worker's `killall python3` or `pkill -f` reaches only its own processes, not the runner or parallel runs. The wrapper is tried once first; where `unshare` is missing or the host blocks unprivileged namespaces or mounting `/proc`, workers run unwrapped (still in their own session) and are not isolated from each other.
