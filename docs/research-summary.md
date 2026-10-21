# Research summary

What VISP's own experiments have and have not shown, and the evidence behind the current design. The runs are few (usually three per arm) on tasks VISP's authors wrote, so treat them as direction, not proof. The harness, tasks, hidden checks and reference implementations are in [`bench/`](../bench/README.md).

## Question

Does an actor–critic harness with executed checks improve the code a coding agent produces, especially for weaker or cheaper models, at a time cost no higher than document-heavy workflows such as Spec Kit and BMAD?

## Current results (September 2026)

**Weaker coding agent: Claude Haiku 4.5**, run headless (`claude -p`) in its own project with project settings only, so each workflow's own instructions, skills and hooks applied. Spec Kit's phases were sent as follow-up turns and BMAD's "approve and continue" was answered, as a user would. VISP used a Codex reviewer and tester (`gpt-5.6-sol`, medium effort). Hidden checks passed and wall time, three runs per arm:

| Arm | Reservations API (44) | Spreadsheet engine (38) | Bundles on an existing service (60) | Extending an existing engine (63) |
|---|---|---|---|---|
| VISP | 44, 44, 44 · 8–10 min | 36, 35, 37 · 10–16 min | 60, 60, 60 · 5–9 min | 57, 62, 63 · 14–16 min |
| BMAD | 38, 38, 39 · 3–6 min | 33, 32, 35 · 3–22 min | 60, 60, 60 · 3–5 min | 56, 51, 50 · 7–13 min |
| Bare | 38, 39, 40 · 2–4 min | 28, 32, 26 · 5–8 min | 60, 60, 60 · 2–3 min | 51, 53, 53 · 9–11 min |
| Spec Kit | 39, 40, 37 · 10–13 min | 28, 28, 27 · 12–15 min | 60, 59, 59 · 8–11 min | 56, 59, 41 · 11–13 min |

Two earlier VISP rounds on the extension task scored 63, 63, 57 and 62, 56, 57. The tasks:

- **Reservations API:** inventory reservations with expiry, idempotency keys, confirmation and concurrency; 36 HTTP checks plus 8 contract checks the first oracle missed. Oracles were validated against a correct and a deliberately racy reference.
- **Spreadsheet engine:** precedence, right-associative powers, ranges, error-propagation order and cycles; cases computed by hand from the contract and matched by a reference.
- **Bundles:** a change to an existing multi-module service, with the prior contract as regression.
- **Extending an existing engine:** text and concatenation, comparisons, a lazy `IF`, `COUNT`, absolute references and `COPY`/`FORMULA` with reference moves; 37 existing cases as regression plus 26 new. Every arm's most common failure was a regression: extending the reference syntax broke `#REF!` for references outside the grid.

VISP matched or beat every arm on every task, and took about as long as Spec Kit. The small bundles change did not discriminate: every arm solved it.

**Stronger coding agent: Codex `gpt-5.6-luna` at low effort,** three runs per arm, after the Codex host fixes below:

| Arm | Spreadsheet engine (38) | Extending an existing engine (63) |
|---|---|---|
| VISP | 37, 36, 38 · 6–8 min | 62, 53, 57 · 8–9 min |
| Bare | 36, 33, 31 · 1.5–2.5 min | 59, 56, 55 · 3–4 min |

The gain was smaller and mixed. The 53 run declared the program itself as its check and never ran `visp done`, so it was never reviewed. On the reservations and bundles tasks, earlier two-run rounds tied (bare 44, 44 and VISP 43, 42 of 44; 60 each on bundles).

## Strong-worker results (October 2026)

**New projects, Codex `gpt-6-luna` at maximum effort,** three runs per arm, 90-minute cap. On reservations, the spreadsheet engine, conventions carryover and the slingshot game, VISP scored the maximum in every run (44, 38, 57, 28) at about 22 minutes per task. Spec Kit also scored the maximum at about twice that time, and bare and BMAD dropped a point once or twice. Those tasks no longer separate the arms at this worker strength.

On a harder catapult game (`bench/tasks/catapult-game`, 69 browser checks not yet published), the first VISP build scored 61, 68, 59 against bare 66.3, Spec Kit 66.7 and BMAD 66.3 on average: its tester treated "every level is winnable" as an open question, so unwinnable levels shipped. After the tester was told to search for each stated goal through allowed inputs, 18 VISP runs averaged 67.1. That lead is within run-to-run noise.

**Existing repositories: SWE-bench Verified Mini** (50 Django and Sphinx issues, official test images), same worker, two runs per arm. VISP used a Claude Sonnet 5.5 reviewer (`critic.launch: claude-exec`) and no tester, which runs for new projects only:

| Arm | Run 1 | Run 2 | Resolved of 100 | Mean time per task |
|---|---|---|---|---|
| VISP | 37 | 32 | 69 | 8.3 min |
| Bare | 32 | 34 | 66 | 3.5 min |
| Spec Kit | 30 | 34 | 64 | 10.8 min |
| BMAD | 33 | 29 | 62 | 6.2 min |

None of the differences is significant (sign tests, p 0.12 to 0.58). Five BMAD runs in the second round stopped within 30 seconds because the worker mistyped the path to BMAD's skill; they are counted as BMAD's result. In earlier rounds VISP's review never ran on these repositories: `init` read Django as JavaScript, adopted checks that could not pass there, and review packets broke on non-UTF-8 fixtures and on scopes of thousands of files. With those fixed, reviews ran.

**The tester matters where the hidden failures are behavioural.** Of 310 pinned tester suites, half failed on their first run, so defects were fixed before `done`. When `claude-exec` was added it started no tester; two catapult runs without one scored 55 (unwinnable levels again) and 68 (time cap), and two with the Claude tester added scored 64 and 66. Replaying review packets with more source, higher effort or a prompt to read more files found no additional hidden defects: the misses (an unwinnable level, a wrong gravity arc, a range corner) needed executed probes, not more reading.

## Quality batches (October 2026)

From October 2026 VISP changes that alter what agents see are measured with paired batches under one fixed configuration (`bench/presets.py` `quality-2026-10`): Claude Haiku 5.5 at high effort as the worker, a VISP-launched Claude Sonnet 5.5 reviewer and tester (`critic.launch: claude-exec`, high effort), a blind Sonnet 5.5 judge of the visual result against a per-task checklist, and a blind Claude Opus 5.5 judge of the produced source (correctness risks, structure, readability, naming, tests, idiom). Both builds run interleaved in one batch, three runs per task each; runs cut short by a usage limit or an API error are discarded and rerun. A candidate passes when no task drops in hidden-check pass rate, judge score, checklist passes or code score, and median wall and idle time are at most 15% worse unless a quality gain pays for it (`bench/report.py`). Three runs per arm is still few: a one-point judge difference in one run moves a task mean by 0.33.

**Integration build against develop (p12, 42 runs).** The build combined images on checks for the reviewer and auto-captured result pictures, the reviewer's recognizability rule, a hook that refuses backgrounded or polled VISP commands, the fresh-clone hook fix, MCP guard parity, and an opt-in `--known` context id for repeat `visp work`, plus refactors with no agent-visible change:

| Task | Hidden | Judge | Checklist | Code | Median wall |
| --- | --- | --- | --- | --- | --- |
| voxel-pagoda | – | 8.33 → 8.33 | 7 → 7 | – | 582 → 318 s |
| rainfall-chart | – | 9.67 → 9.67 | 9 → 9 | – | 199 → 160 s |
| lighthouse-pixel | – | 7.33 → 7.67 | 9.33 → 10.67 | – | 291 → 306 s |
| ps5-controller-svg | – | 5.67 → 5.67 | 9.33 → 9.33 | – | 155 → 201 s |
| slingshot-game | 100% → 100% | 8 → 8.33 | 8 → 8 | 8 → 8 | 1201 → 1410 s |
| reservations-bundles | 100% → 100% | – | – | 8 → 8 | 156 → 192 s |
| spreadsheet-extend | 100% → 100% | – | – | 7.33 → 8 | 864 → 645 s |

No task dropped on any quality metric. The time differences have specific causes. On the base build, workers backgrounded `visp done` and waited in self-matching `pgrep` loops (one rainfall run idled 45 minutes; pagoda's median includes 233 s of such waiting). On the new build those reviews finish in the foreground: slingshot ran 8 reviews against 3, and one base slingshot run was never reviewed at all. PS5 workers now write an image check with an experience outcome. The bundles median is noise: its mean fell from 261 to 233 s.

**Single changes (qv, qc), three runs each against the integration build:**

| Change | Task: judge (checklist) or code | Median wall | Kept |
| --- | --- | --- | --- |
| Reviewer: a named real thing is recognized by its identifying parts; a missing part is a required finding (two batches, six runs per arm pooled) | ps5 5.5 → 5.67 (element passes 46/60 → 46/60), lighthouse 8.0 → 8.5 (10 → 10.83), voxel 8.33 → 8.33 | ps5 235 → 378 s, then 225 → 197 s; lighthouse 397 → 310 s, then 381 → 407 s | yes |
| Worker: view the picture against the request before `done` | ps5 5.33 → 5.33, lighthouse 8.33 → 8.33, voxel 8.33 → 8.67 | ps5 +33%, voxel +73% | no |
| Reviewer: at most one optional maintainability finding | code: reservations-api 8 → 8.33, spreadsheet-cli 8 → 8, slingshot 8 → 7.67 | within noise | no: reviewers never raised one in 17 reviews |
| After a clean review leaving optional findings on a picture, offer one extra repair round (on top of the parts rule) | against the parts rule alone: ps5 5.33 → 5.33, voxel 8.67 → 8.67, lighthouse 8.33 → 8.33 | ps5 197 → 306 s | no |

**Final build against develop (fin, 42 runs).** The integration build with every change above that was kept (the parts rule included), the refactors, `visp uninstall` and the test-speed work:

| Task | Hidden | Judge | Checklist | Code | Median wall |
| --- | --- | --- | --- | --- | --- |
| voxel-pagoda | – | 8.33 → 8.67 | 7 → 7 | – | 380 → 435 s |
| rainfall-chart | – | 9.67 → 9.67 | 9 → 9 | – | 140 → 164 s |
| lighthouse-pixel | – | 7.33 → 7.67 | 9.67 → 10.33 | – | 323 → 366 s |
| ps5-controller-svg | – | 5.33 → 6.33 | 8.67 → 9.67 | – | 158 → 361 s |
| slingshot-game | 100% → 100% | 7.67 → 8 | 7.67 → 8 | 8 → 7.67 | 1498 → 2025 s |
| reservations-bundles | 100% → 100% | – | – | 8 → 8 | 173 → 252 s |
| spreadsheet-extend | 100% → 100% | – | – | 7 → 8 | 727 → 654 s |

The mean visual judge score rose from 7.67 to 8.08 and the mean code score on the code tasks from 7.67 to 7.89; hidden checks were at their maximum in both arms on every task, so this round cannot show an accuracy gain. On develop, reviews were often unavailable (lighthouse 0 of 6 attempts usable, pagoda 2 of 6) because reviewers cited evidence VISP had listed as unavailable; on the final build almost every review ran. The one score that fell, slingshot's code score, comes from a single run that hit the 60-minute cap: after half an hour of its own level searches the worker was routed back and forth between two slices for one finding on a shared file, a routing loop present since October 1 and fixed afterwards (`findingOwner`). Medians rose on most tasks because reviews now complete in the foreground and PS5 runs repair the parts the reviewer requires (one PS5 run went from 5 to 8); the bundles and rainfall means fell (374 → 249 s and 183 → 166 s), where develop's workers idled in polling loops.

A routing loop found in that run was fixed afterwards and checked in a small batch (pp: the final build with and without the fix, slingshot and spreadsheet-extend, three runs each): hidden checks, judge and checklist equal; code scores moved by a third of a point in opposite directions; the loop did not occur in either arm, so the batch shows no effect of the fix either way.

**Improvement round, rejected (pm1, ch2, ex1).** The round had the reviewer add improvement notes on a picture result and required one repair round after the first clean review. A paired batch (pm1: the same Haiku 5.5, Sonnet 5.5 reviewer and Sonnet judge preset, release 0.5.0-beta.4 against the round, five runs per arm on the Xbox and PS5 tasks, three on the rest) was agreed with a merge rule beforehand: no drop on any metric, more pairwise wins than losses over the picture tasks, median wall at most 15% worse unless the gain pays for it. It failed:

| Task | Judge | Checklist | Median wall |
| --- | --- | --- | --- |
| xbox-controller-svg | 7.6 → 7.8 | 13 → 13.6 | 483 → 541 s |
| ps5-controller-svg | 5.6 → 5.8 | 9.2 → 9.2 | 214 → 343 s |
| voxel-pagoda | 8 → 8.67 | 6.67 → 7 | 431 → 421 s |
| lighthouse-pixel | 8.33 → 8 | 10.33 → 10.33 | 375 → 327 s |
| rainfall-chart | 10 → 10 | 9 → 9 | 121 → 228 s |

The pairwise judge (each pair of the same rep, both orders, a split verdict a tie) gave the round 6 wins, 7 losses and 6 ties over the five picture tasks, so the rule "wins exceed losses" failed. Lighthouse's judge score fell by 0.33, and PS5 and rainfall ran 60% to 90% slower, with mean cost per run up as well (PS5 $0.26 → $0.50, rainfall $0.16 → $0.37 for the whole run). Slingshot, spreadsheet-extend and reservations-bundles are incomplete: the weekly usage limit ended one slingshot run of the round and several judge calls, so their rows hold fewer runs or lack scores. That cannot change the verdict, because the picture rules had already failed. The branch `quality/improvement-round` is kept and not merged. Its bench tooling (pairwise judge, per-call cost, the Xbox task, judging the picture the last slice declares) was moved to develop on its own.

Two variants were tried earlier on PS5 only and lost. Reviewing a picture part by part (ch2, five runs per arm against the round, reviewer budget 6): judge 5.6 → 5, checklist 9.2 → 8, median wall 287 → 491 s, reviews 10 → 24, pairwise 1 win, 2 losses and 2 ties. Notes that end in an executable check the worker can run (ex1, four runs per arm against beta.4): judge 5.75 → 5.25, checklist 9.75 → 9.25, wall 323 → 308 s, so no gain over the release; the prose-notes arm in the same batch scored 6.25 and 10.

The weakest visual task, the PS5 controller, failed the judge's parts checklist (two-tone shell, shoulder buttons, PS logo, "reads as a PS5 controller"). Before images reached the reviewer it judged from SVG coordinates; with images it filed missing parts as optional style. Asking the reviewer to list and check identifying parts raised the lighthouse score in both batches (the judge's "waves breaking against the rocks" item) but did not move the PS5 score once both batches are counted: the reviewer named missing parts, and Haiku's drawings still lacked the two-tone shell and shoulder buttons. A worker-side checklist and an extra optional repair round added time without a score change. Per-batch differences of 0.33 reversed between batches, so single three-run batches are not enough to call small effects either way.

## Bare Haiku 5.5 and the critic ablation (October 2026)

The October batches compared VISP builds with each other; bare Haiku 5.5 had not been measured. A same-model ablation was planned to settle whether VISP's gain comes from its loop or from its stronger Sonnet reviewer and tester. It first needed a gain to split, and there was none.

**Calibration, bare Haiku 5.5 at high effort** (preset `quality-2026-10`, batches cal1–cal4, two runs per task). 14 of 16 runs passed every hidden check, and the other two missed one check each. That includes three tasks built to land at 40–80% (`spreadsheet-rows`, `recurrence-cli`, and `spreadsheet-audit` with 18 seeded deviations from its README). Code scores were 8 on almost every run, against VISP's pooled October means of 7.65–8.17 on the same tasks:

| Task | Hidden checks | Bare runs 1 and 2 | Code | Cost per run |
| --- | --- | --- | --- | --- |
| spreadsheet-cli | 38 | 38, 38 | 8, 8 | $0.07, $0.11 |
| reservations-api | 44 | 44, 44 | 8, 8 | $0.04, $0.05 |
| spreadsheet-extend | 63 | 63, 63 | 8, 8 | $0.19, $0.13 |
| reservations-bundles | 60 | 60, 60 | 8, 9 | $0.02, $0.03 |
| slingshot-game | 28 | 27, 28 | 8, 7 | $0.55, $0.57 |
| recurrence-cli | 46 | 46, 46 | 8, 8 | $0.24, $0.40 |
| spreadsheet-audit | 48 | 48, 47 | 7, 8 | $0.36, $0.67 |

At low effort (`quality-2026-10-low`, batch low1, two runs on each of four tasks) bare Haiku 5.5 still passed 97.6% of hidden checks, in half the time at $0.03–0.05 per run. Its misses were single edge cases. Neither setting is a weak worker on these tasks.

**Picture tasks, four arms** (wave 1: batches ab-q, ab-h, ab-s; five runs per arm; VISP build of develop 573f8b7f). The pooled judge score is the mean over the three tasks:

| | Bare Haiku | VISP, Sonnet critic | VISP, Haiku critic | Bare Sonnet |
| --- | --- | --- | --- | --- |
| ps5-controller-svg judge | 5.0 | 5.8 | 5.4 | 6.6 |
| lighthouse-pixel judge | 8.4 | 8.2 | 8.6 | 8.4 |
| voxel-pagoda judge | 9.0 | 8.8 | 8.6 | 9.0 |
| Pooled judge | 7.47 | 7.60 | 7.53 | 8.00 |
| Mean cost per run | $0.04 | $0.37 | $0.13 | $0.29 |
| Median wall time | 228 s | 300 s | 314 s | 117 s |

Every VISP difference from bare Haiku is within noise: twice the standard error is about 1.2 on PS5 and 0.46 pooled. The pairwise judge preferred bare Haiku to VISP with the Sonnet critic 9 to 4, with 2 ties (lighthouse 5 to 0). A Haiku critic did no measurable harm at a third of the cost, but with no gain to split, the ablation cannot say whether the loop or the model matters. Bare Sonnet scored best, ran fastest and cost less per run than VISP with the Sonnet critic.

So VISP shows no measured quality gain for Claude Haiku 5.5, at high or low effort, on any current task, and costs 3–9× bare Haiku per run on these tasks. Run traces point to two costs on picture tasks. First drafts were smaller (pagoda generators averaged 243 lines under VISP against 582 bare). And after a review that left only optional findings, the edit hook refused the worker's own polishing ("No task is authorized to write lighthouse.py"). The plan and per-run detail are kept outside the repository with the other batch plans.

## Fixes measured with Haiku 5.5 (October 21 2026)

Run traces from the null batches above exposed VISP defects. Each fix was measured against the build before it, under preset `quality-2026-10`.

**Cross-session carryover** (co1, then co2). Four two-session tasks, two runs per arm. Each arm ran its own first session, so pairs are not shared. Second-session hidden checks, summed:

| Arm | Carried (memory) | New behaviour | Code-shown conventions | Session 2 mean | Cost per run |
| --- | --- | --- | --- | --- | --- |
| bare | 58/62 | 134/142 | 36/36 | 146 s | $0.06 |
| VISP before the fixes | 50/62 | 122/142 | 27/36 | 344 s | $0.71 |
| VISP after the fixes (#59) | 62/62 | 140/142 | 36/36 | 348 s | $0.69 |

Bare Haiku 5.5 carried most knowledge itself. It wrote stated conventions into `CLAUDE.md` and the README, and read earlier decisions from the code; Haiku 4.5 did neither. Before the fixes, VISP had three defects:
- Request-history recall and model rule reading ran only with a Codex reviewer, so they were off under `claude-exec` and the default Claude Code critic.
- A second session could not start its feature when the first had not committed. One worker stalled at 22 of 57 checks.
- Host notifications were recorded as user prompts.

After the fixes, every run recorded its request history, and the restock cap that both earlier arms lost in one run was carried.

**Tester browser kit and dispute limit** (kd1, then #57; lighthouse-pixel and slingshot-game, five runs per arm). The kit's `evaluate` did not call a function given as a string, and `waitFor` passed no arguments. Pinned suites with many failing tests could leave a feature unreviewed. With both fixed, lighthouse scored judge 7.4 → 7.8 and checklist 10 → 10.2, and median wall fell 438 → 362 s. The pairwise judge preferred the fixed build 4 to 0, with 1 tie. The same batch also made an unobserved stated goal blocking, and two of five slingshot runs then hit the 60-minute cap. That change was split out.

**Bounded NOT OBSERVED rule, rejected** (no1, #62; slingshot-game, five runs per arm). The rule gave an unobserved stated goal one required repair round, then reported it unverified. Results:
- No run timed out.
- Hidden checks were 100% in both arms.
- Judge fell 8.2 → 8.0 and code 8.0 → 7.8.
- Median wall rose 1053 → 1860 s.
The failure the rule targeted (one October run that shipped with a level unobserved) did not occur on develop, so there was no gain to pay for the time. Not merged.

**SVG rendering for the reviewer** (#61). Headless Chrome started with the GPU on and fell back to slow software rendering on hosts without one, so renders timed out. Failures in a 15-run golden loop went from 10 to 0, and production renders from 25 of 32 failing to 0. On the bench machine, which has a GPU, 0 of 499 picture packets had lost their image. The fix matters on CI, VMs and containers.

## What made the difference

**The harness must launch the critic itself.** In the first weak-agent pilot (Luna at low effort, a sentiment API with 36 hidden tests), bare coding scored 36 and both VISP arms 34: workers never ran a check that covered errors and never delegated review. A critic launched by VISP (`codex exec`, read-only) on the same code reported the two missing 405 responses, acceptance of `NaN` and a request that can hang without `Content-Length`, each with a next check. VISP now launches the reviewer after checks pass (`critic.launch: codex-exec`).

**Reviews found what hidden tests later confirmed.** Every non-VISP Haiku run on the reservations task missed at least one of: booleans used as numbers, Content-Type parameters, 405 for a wrong method. The first three reviews found all of them; later ones raised untested edge cases, so the default budget is three reviews. Findings still open at the handoff were real contract violations, not reviewer strictness: on the eight checks the first oracle missed, VISP runs scored 6–8 and other arms 3–6.

**The loop had to run inside real hosts.** Rounds with weak workers exposed, one at a time: the host killing a review that ran inside `done`; workers editing during a background review, which discarded it; sandboxes denying sockets to checks and network to the reviewer; a read-only Codex home; a reservation that rewrote every tracked file under a read-only `.agents/`; and Codex's sandbox ending VISP's background reviewer and tester. Each is fixed: sandbox denials are environment failures with a rerun-with-escalation instruction, the reviewer checks it can reach its model before a call is reserved and uses a private Codex home, and from a Codex worker's CLI the reviewer and tester run inside the command.

**Workers stop early unless the host sends them back.** Headless workers left slices open, one hand-edited the brief and another deleted `.visp/` to get past a scope error it could not read. VISP now installs Stop hooks for Claude Code and Codex that send the worker back to unfinished work, refuses agent edits and deletions of its state, names out-of-scope files in scope errors, lets a fresh reviewer close a repaired finding against current passing executions, and ends the loop in acceptance or a handoff to `visp pr` once the review budget is spent.

**Independent tests are only as good as the request they see.** Workers passed 187–238-character summaries of a 2,700-character contract to `visp feature`, and a tester writing from a summary missed the same gaps as the worker. VISP now takes the request from the host's recorded prompt (the Claude Code hook, or the Codex session file) and accepts a worker's text only as a verbatim quote. Written from the full contract, a tester suite (15 tests, about 2.5 minutes at medium effort) caught the boolean, Content-Type and 405 defects in every weaker arm. Against a correct reference it first failed five cases (a helper that sent no body where it meant JSON `null`, and extra fields the contract leaves open); after the tester was told to leave out open cases and trace cases through its own helpers, one defensible case remained.

**Frozen tests are harmful when they are wrong.** On the bundles task the first runs with the tester scored 60, 10 and 59: pinned suites assumed an error body and a status code the repository contradicts, and two workers changed correct code to satisfy them. A binding-documentation prompt, an LLM audit of the assertions (it missed both contradictions at medium and high effort) and an existing-behavior check did not make suites for existing code reliable, so the tester runs for new projects only by default. The opt-in execution mode, where the tester runs the existing program in a copy and must pass tests of existing behavior first, produced 11 correct suites of 14 against reference implementations; the other three assumed wrong setup, status codes or error bodies.

**Ceremony, not implementation, was the time cost.** In early timed-out runs, VISP replies were 76–83% of the model-visible context before the first edit, tool definitions were 44k characters per turn, and every run had briefs rejected for natural field names. Tool definitions are now about 21k characters, closed-slice replies went from 14k to 1k characters, briefs are normalized, and the light path (`visp work --check`, one slice for the whole request) replaced about six minutes of planning on small changes. The tester no longer blocks `work`, and the reviewer runs at medium effort, which matched high on hidden tests (36/36 in three runs each) at 12.0 instead of 14.2 minutes.

**Browser journeys found real defects** that unit tests missed: clipped controls, a launch that never fired, a second shot that never registered. Syntax-only checks (`node --check`) are not accepted as functional evidence.

**A bundled testing skill gave a small, uncertain gain.** `edge-cases-first` asks the worker to pin current behavior and the request's edge cases as tests before changing code. The first round exposed two delivery faults: an over-budget pack dropped skills before source excerpts that the compact reply never shows, and a skill arrived as one escaped JSON string. With both fixed, Haiku on one build, three runs per arm (control, then with the skill seeded and admitted): reservations 44, 40, 41 and 43, 44, 43; spreadsheet engine 36, 36, 36 and 37, 37, 37; extending an existing engine 58, 63, 62 and 63, 58, 58. That is 420 of 435 hidden checks against 416, at 20% more wall time and 26% more output tokens. No worker pinned existing behavior before editing, and the `#REF!` regression the skill targets appeared in one run of each arm. The skill stays opt-in.

**Stored knowledge helps only when VISP delivers it.** A two-session task (`bench/tasks/conventions-carryover`) states four API conventions for all later work in the first request; a fresh second session gets the next request with "our conventions from before still apply". Hidden checks split conventions the first session's code shows (27 checks over three runs) from ones only the conversation states (24). Haiku, three runs per arm, each second session paired on one first session:

| Second session | Code-shown | Stated only |
| --- | --- | --- |
| VISP state reset | 0–18 | 3–9 |
| VISP state kept (feature records hold the conventions) | 1–11 | 3–10 |
| Conventions restated in the request | 25–27 | 23–24 |
| State kept, with project rules | 25 | 24 |

No worker ever ran `visp learn`, and workers that read a README stating the conventions still missed them half the time. Project rules close the gap: `visp feature` captures rules stated for later work from the recorded prompt and every later feature's request and `work` reply carries them. The same rounds exposed two workflow defects, now fixed: an edit authorization left by a first session's handoff let a later session edit for a new request without starting a feature (three of nine second sessions), and a worker discarded a previous session's uncommitted work with `git checkout` to get the clean tree `visp feature` asked for.

Rules must be read by a model, not matched by phrase. Phrase matching found 4 of 18 held-out prompts that stated lasting rules; the reviewer's model at low effort found all 18, recorded nothing from 12 ordinary requests and, once told that instructions for carrying out a request are not rules, nothing from benchmark boilerplate. With the conventions restated as prose (`conventions-carryover-prose`), fresh second sessions applied 24 of 24 stated-only checks (26 of 27 code-shown) against 0 and 9 with VISP state reset.

**Visp Memory carried decisions that were not stated as rules.** In `archive-carryover` the first request specifies item archiving: an archived item cannot be reserved, and items hold at most 10,000 units. The second request adds bundle reservations and restocking without mentioning either. Three runs, second sessions paired on one first session each, no project rules captured (correctly: nothing was stated for later work):

| Second session | Carried decisions (18) | Mean time | Output tokens |
| --- | --- | --- | --- |
| VISP with project rules | 9 | 8.2 min | 34.6k |
| VISP with Visp Memory (`memory.service`) | 18 | 7.3 min | 28.2k |
| Decisions restated in the request | 18 | 11.2 min | 33.6k |

Without memory every run kept the archive check, which the reservation code already had, and none capped restocking. Visp Memory's keyword selection is coarse (scores 0.55–0.72 for relevant and boilerplate paragraphs alike), so VISP drops what the new request already says; five decisions reached each second request.

**A noisy store needs a model to choose.** The same task with ten earlier feature requests on the service already in Visp Memory (eight unrelated, two near-miss limits of other endpoints), three runs paired on one first session each:

| Second session | Carried decisions (18) | Notes the request carried | Near-miss notes carried | Mean time |
| --- | --- | --- | --- | --- |
| No memory | 9 | 0 | 0 | 8.5 min |
| Visp Memory keyword selection | 15 | 15–24 | 1 | 9.1 min |
| Reviewer's model choosing among candidates | 18 | 3 | 0 | 10.6 min |

Keyword relevance scored needed decisions and noise alike (0.54–0.57) and once cut the needed quantity limit. The model reads a wide candidate set (about 45 notes, some fourteen seconds at low effort); told that a resource's invariants apply to every operation on it while one endpoint's limits do not, it chose exactly the three decisions in every run. An earlier prompt without that distinction dropped the limit in one run. Workers ignored the near-miss note they were given, but carried 5–8 times more text. Times vary by several minutes between rounds and are not a result.

**An outdated decision stayed out when the model chose.** After the first session, a simulated intermediate feature raised the item limit from 10,000 to 50,000 units: its code change committed and its request recorded after the first one, with the ten noisy features also in the store. The same three first sessions, scored against 50,000 (21 carried checks, including restocking past the old limit):

| Second session | Carried checks (21) | Old limit delivered | Restock limit coded |
| --- | --- | --- | --- |
| No memory | 12 | — | none in 2 runs, 10,000 in 1 |
| Visp Memory keyword selection (15–16 notes) | 17 | 3 of 3 runs, beside the new one | 50,000, 50,000, 10,000 |
| Reviewer's model choosing (2–3 notes) | 21 | 0 of 3 | 50,000 in all 3 |

The run that coded 10,000 with keyword selection also restored 10,000 without memory, from the first session's traces, so keyword memory's harm is not shown; the model's choice, which stated only the new limit, kept that run on 50,000. The intermediate request said "replacing the 10000 limit"; a change stated less plainly is untested.

**A second domain: rules carried, memory added nothing.** `sheet-carryover` extends the spreadsheet engine. The first request adds AVERAGE with a stated house rule ("a statistic over no numbers is #DIV/0!, now and for every statistic we add") and ROUND with a feature-only decision (digits must be a whole number from 0 to 10); the second adds MEDIAN, ROUNDUP and ROUNDDOWN without mentioning either. Five runs, second sessions paired on one first session each, eight earlier features and two near-miss limits in the store:

| Second session | Carried checks (40) | Mean time |
| --- | --- | --- |
| Project rules only | 40 | 5.0 min |
| Rules and Visp Memory, first gate prompt | 36 | 6.5 min |
| Rules and Visp Memory, gate prompt with argument kinds | 38 | 8.6 min |
| Decisions restated in the request | 40 | 8.7 min |

Every first session captured the statistic rule and not the feature-only one. Without memory, workers reused ROUND's digits check from the code, so rules and code carried everything. The first gate prompt never passed the digits decision (it read it as ROUND's own); told that decisions about a kind of argument carry to operations taking the same kind, it passed it in every run that started a feature, still without near-miss notes. The remaining miss came from a run whose worker continued the first session's open task instead of starting a feature for the new request, so memory was never consulted; the two first-prompt misses accepted digits above 10. Memory helps where knowledge is in neither the request nor the code, as in `archive-carryover`; here it only cost time.

**VISP now keeps the store itself.** At these sizes the gate read every note Visp Memory offered it, so Visp Memory's search added nothing the gate used. VISP now records earlier requests in `.visp/state/request-history.json` and, with a VISP-launched reviewer, gives its model every recorded note (the newest 40,000 characters), oldest first, with the current project rules; the model is told a later note replaces an earlier one it conflicts with. No service, Python or Docker is needed. It runs whenever VISP launches the reviewer (`memory.recall` defaults to true and `false` turns it off; the `memory.service` integration with Visp Memory has since been removed), which in these rounds was `critic.launch: codex-exec`. Offline, reading 35–68 notes, it chose every needed decision in 15 of 15 selections across the three stores, with no near-miss note and never the replaced limit. Rerun on the same first sessions, with the current scorer (which gained one check per store since the tables above):

| Store | No memory | Visp Memory, keyword | Visp Memory with gate | VISP's own store |
| --- | --- | --- | --- | --- |
| Noisy inventory (21) | 9, 8.5 min | 17, 9.1 min | 21, 10.6 min | 21, 7.3 min |
| Outdated limit (24) | 12, 8.8 min | 19 | 24, 11.8 min | 24, 9.2 min |
| Spreadsheet (40) | 40, 5.0 min | — | 38, 8.6 min | 40, 6.2 min |

Every inventory run carried three notes and every spreadsheet run that started a feature one or two. One spreadsheet worker again continued the first session's open task, but ROUND's code carried the digits check there anyway. Core checks were unchanged against the earlier modes; four of five spreadsheet runs share a ROUND argument-count failure also present without memory.

**Correction: recall and the rule reader ran only with a Codex reviewer.** Both asked the model of a `codex-exec` reviewer and nothing else. Under `critic.launch: claude-exec`, which preset `quality-2026-10` uses, VISP matched rules by phrase, wrote no `request-history.json` and recalled nothing: no second session of bench batch co1 (eight VISP runs) received an earlier decision, and in `co1-archive-carryover-visp-dev-2` the second session never got the 10,000-unit restock cap and failed 4 of 7 memory checks, as bare Claude Code did. Both now use the model of either reviewer VISP launches (one `claude -p` at low effort for `claude-exec`). A reviewer the host runs (no `critic.launch`, as `visp init` sets up for Claude Code) gives VISP no model of its own to call, so there rules are still phrase-matched and nothing is recalled. Not yet measured: the co1 rerun proposed with this change.

**A later session's request now gets its own feature.** Both spreadsheet misses of `visp feature` had one cause: refused an edit under the first session's lapsed authorization, the worker asked `visp next`, which named the old open task, and built the new request inside it. `visp next`, and the Stop hook that asks it, now point to `visp feature` when the open task's authorization is from an earlier session and the host recorded a prompt no feature has taken; continuing is offered only if the user asked for it. Rerun (five runs, same first sessions): every second session started its own feature (before: 8 of 10), two of them after the new reply; memory checks 40 of 40.

**No demonstrated benefit yet** from the repository graph or `visp learn` notes in any run. `visp learn` notes have since been removed.

## Design consequences

- VISP launches the independent reviewer after checks pass, and an independent tester that writes acceptance tests from the verbatim request before work starts (new projects by default); pinned tests change only through a recorded intent change.
- The request comes from the host's recorded prompt, not the worker's summary.
- A slice must declare a runnable check before edits are authorized; the light path makes that one command for small requests.
- The loop always ends, in acceptance or a handoff document, within three reviews by default; host Stop hooks send the worker back until then.
- Replies are compact; complete results stay behind `--json` and `detail: true`. Brief input is normalized for common alternative field names.
- Reviewer web search and the opt-in tester's networked commands are logged and listed in `visp pr`.

## Evidence from other work

Independent studies point the same way: execution feedback against fixed tests is the strongest lever (TDFlow; SWT-bench), self-critique without external signals is weak (Olausson et al., ICLR 2024; Kamoi et al., TACL 2024), passing tests often do not mean mergeable code (PatchDiff; METR 2026), heavy specification documents add large review overhead for small gains, and fewer, smaller tools help (RAG-MCP).

## Limits and next steps

- The October batches ran three runs per arm; a one-point judge difference in one run moves a task mean by 0.33, and several 0.33 differences reversed between batches. Hidden checks were at their maximum on every task for both builds with the Haiku 5.5 worker, so these tasks no longer measure accuracy differences; harder tasks are needed.

- Three runs per arm on four tasks the authors wrote; differences of one or two checks are within run-to-run noise.
- The reviewer is a stronger model than the weak worker. Part of VISP's September gain may come from that model rather than the loop. The October same-model ablation could not separate them, because VISP showed no gain for Haiku 5.5 to split; only Haiku 4.5 still leaves headroom on these tasks.
- No new-project task separates VISP from bare Haiku 5.5 on hidden checks. Carryover was repeated with Haiku 5.5 against bare Claude Code: with the October 21 fixes VISP carried 62 of 62 decisions to bare's 58, on two runs per task, at about eleven times the cost.
- The opt-in tester for existing codebases needs more trials, including with its newest rule that tests of existing behavior must use every assertion helper the new tests use.
- Stronger workers gain little on these tasks. On SWE-bench Verified Mini and the catapult game VISP leads by amounts within noise; more runs, a weaker worker on the current build, and blind code review scored separately are still to come.
- The catapult game's hidden checks are not yet in `bench/`, so its scores cannot be reproduced from this repository.
