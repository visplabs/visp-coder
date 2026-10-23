# Requirement-account check: B2 replay (October 23 2026)

PR #79's review found four ways the requirement-account check verified a named test that did
not run, or ran on an earlier version (commits `1c01c766`, `89097054`, `eac80d4b`). This replay
asks whether fixing them changes what batch B2's candidate runs were told.

## Method

Offline, no model calls. Both verifiers read the same inputs for each run: the final
`requirements.json` and `product-state.json` of each feature, and the run's test files.

- **Unfixed:** `src/` at `c2c2368d`, which is the B2 candidate build. Its source differs only in
  `regression-runner.ts`.
- **Fixed:** the branch after the three commits.

The real `account-verification.ts` and `test-sources.ts` were bundled with esbuild. Test files
were listed by walking the project, leaving out `.git`, `node_modules`, `__pycache__` and
`.visp`.

The fixed verifier ran twice:

- **all runs:** every execution, as before, which isolates the matching and counting fixes;
- **current runs:** only executions on the version the feature ended on. For an accepted feature
  that is its accepted subject and contract; otherwise it is the subject of its latest
  execution. The real current subject cannot be recomputed offline, because the digest includes
  the VISP build ID.

Each named test gets a label: `verified` with its basis (`listed` or `suite-passed`), the
`claimed` reason, or no verification.

## Results

| Runs | Features | Named tests | Suite level | By name | Labels changed (all runs / current runs) |
| --- | --- | --- | --- | --- | --- |
| B2 candidate and candidate+nocritic, all 48 runs (8 reps × 3 tasks × 2 arms) | 48 | 335 | 296 | 39 | 0 / 0 |
| The 35 of them finished when the review was written (before 01:50) | 35 | 251 | 222 | 29 | 0 / 0 |
| leandef1 and leandef2 lean runs | 18 | 202 | 150 | 52 | 0 / 0 |

Every B2 name was verified before the fix and is still verified after it, on the same basis. That
is 331 accounts. In leandef1/2, 149 accounts are verified and 40 name no test, as before. All
B2 checks ran unittest: mostly `python3 -m unittest discover -s tests`, and some with `-v`,
`-B`, `-I` or `-p`. A few ran a test script directly. What the replay shows:

- For every name verified at suite level, the run's `Ran N` equals the unittest test methods in
  the files the run covered.
- No line of a `-v` run marks a named test skipped.
- The latest run of every cited check is on the version the feature ended on.

Named tests per task and arm (all 48 runs):

| Task | candidate | candidate+nocritic |
| --- | --- | --- |
| lighthouse-pixel | 18 | 18 |
| reservations-bundles | 75 | 75 |
| spreadsheet-extend | 75 | 74 |

The review's six counterexamples all read not confirmed after the fix:

- a `t.Skip` go test behind `ok pkg`;
- a TAP `# SKIP`;
- a one-file pytest run with 10 parametrized passes;
- inherited unittest methods (`Ran 6`, 3 defined);
- the helper `post_json`;
- a name passing in one class and skipped in another.

Before the fix all six read verified.
