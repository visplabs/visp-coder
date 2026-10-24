# Requirement gaps on a stale pass: offline replay (October 23 2026)

PR #94 makes the gap "cites C001, which has not passed on the current version" count only
executions on the current version. Before, it counted a pass on any version. A new gap in a
worker's `done` reply could add turns and cost, so this replay asks how often the new code adds
one on past runs.

## Method

Offline, no model calls. For each finished run with a VISP feature, the replay reads the final
`product-state.json`, `brief.yaml` and `requirements.json` of the feature, and runs the real
`applicableExecutions`, `latestExecutionsByOwner` and `requirementGaps` from the branch
(bundled with esbuild). Calibration: every brief parsed, and in all 108 features the final version's executions are
applicable under the branch's contract digest.

- **Calls.** A `done` records its accounts, runs its checks one after another on one version,
  then judges. Executions in a row on one version, less than 3 minutes apart, are one call.
  The replay evaluates after the last execution of each call that follows the first account
  record: 80 calls.
- **Brief.** The final brief stands in for the brief at each call. If a brief patch changed a
  slice's contract in between, the new code sees an earlier pass as not applicable, so this
  can only add gaps to the new side, never hide them.
- **Accounts.** The accounts stored at the end, those recorded by then.
- **Old:** `passedChecks` over every execution up to that call. **New:** only those
  `applicableExecutions` returns for the call's version and slice.
- **Counted:** a gap the new code raises and the old code does not.

Runs: 9 B2 groups (candidate, candidate-nocritic, develop; 3 tasks; 8 reps; 72 runs) and
leandef1/2 (36 features: 18 lean-arm ones, and 18 develop-arm ones that list no requirements and have no accounts).

## Result

| Runs | Features | With accounts | Calls replayed | New gaps | Runs with a new gap |
| --- | --- | --- | --- | --- | --- |
| B2, 9 groups | 72 | 72 | 61 | 0 | 0 |
| leandef1/2 lean arms | 18 | 18 | 19 | 0 | 0 |
| leandef1/2 develop arms | 18 | 0 | 0 | 0 | 0 |
| Total | 108 | 90 | 80 | 0 | 0 |

The new code adds no "has not passed on the current version" gap in any of the 80 calls, so
there is no re-run to look at. Per group, the calls were: B2 lighthouse-pixel 7/7/7,
reservations-bundles 7/8/6, spreadsheet-extend 5/8/6 (candidate, candidate-nocritic, develop).

Why it is 0:

- Every run recorded its accounts in one `done` (one timestamp per run). That `done` reran the
  checks of its slice on the current version, so the check it cites has a current pass.
- No run has an execution on a different version after that `done`: none of the 90 had an edit
  between the accounts and the end of the run.

## Control

A replay that finds nothing should be shown to find something. The control applies the final
accounts at every call, including calls before they were recorded (which cannot have happened).
It adds 6 gaps, all in one run (b2-spreadsheet-extend-develop-2), at its first call. There the
brief was patched afterwards (a second slice), so the first call's pass has another contract
than the final brief's and counts as not applicable. This is an artefact of replaying an early
call with the final brief, and it never reached a worker; it shows the replay can raise the gap.

## What the replay cannot see

- A stored account keeps only its last submission. An earlier `done` whose accounts a later one
  replaced is not replayed. All 90 runs show a single account timestamp, and 59 had executions
  before it, 9 of them on more than one version.
- `visp status`, `visp next` and the critic result use the same function but are not recorded,
  and the version they saw cannot be recomputed offline (the digest includes the build ID). They
  show the new gap only between an edit and the next `done`, with accounts already recorded. No
  run edited after its accounts.
- The new gap needs a cited check that the `done` does not rerun, or an edit after the accounts.
  Runs by weaker workers that cite another slice's check, or edit after `done`, would show it,
  and then the gap is correct: that pass does not describe the code.
