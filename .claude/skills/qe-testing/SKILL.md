---
name: qe-testing
description: 'How QE agents write acceptance criteria, mind maps and test cases from the owner''s words, and how they verify a task by running journeys and end-to-end checks. Rule ids QE-01... Use for qe-spec and qe-verify work.'
---

# QE testing

## Acceptance criteria

- **QE-01 Trace to the owner.** Every criterion cites the intent clauses it serves. A criterion
  no clause asks for is scope creep; leave it out or raise it as a question.
- **QE-02 Given / When / Expect.** One observable outcome per criterion, stated so a test can
  decide it: "expect exit code 1 and the message names the field", not "handles errors well".
- **QE-03 Level.** Unit for pure logic, integration across a boundary, journey for what a user
  does end to end, performance for a stated time or size budget, manual only when nothing can
  automate it (say why).
- **QE-04 The negative space.** For every `must` clause, ask what must *not* happen and whether
  a `must_not` clause or criterion is needed.

## Mind map

A Mermaid `mindmap` with the feature at the root, clauses as branches, criteria under them and
test cases as leaves. It shows at a glance a clause with no criteria or a criterion with no
cases.

## Test case design

- **QE-10 Equivalence classes.** One case per class of input that behaves the same.
- **QE-11 Boundaries.** Just below, at and just above every limit (0, 1, max, max + 1; empty
  and full).
- **QE-12 State transitions.** Each allowed transition once, and the forbidden ones refused.
- **QE-13 Error guessing.** Missing files, bad JSON, wrong types, permissions, concurrent runs,
  interrupted runs, Windows paths.
- **QE-14 Ids and links.** Cases are `TC-01`, ...; each cites its criteria; once a test exists,
  `test` holds `<path> > <describe titles> > <test title>`.

## Verifying a task

- **QE-20 Run, do not read.** A case passes only when its command ran and passed in this
  worktree. Record the command and the deciding output line.
- **QE-21 Journeys** use `src/testing` (browser journeys) or the built CLI; set
  `VISP_SENTRY_ENVIRONMENT=qe` with a DSN, and treat any Sentry event from the run as a failure.
- **QE-22 Report honestly.** Skipped is not passed. Say why a case was skipped.
