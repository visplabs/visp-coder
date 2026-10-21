# Spec: the Map tab in `visp ui`

Status: prototype · Owner: Dineth Keshawa Jayathilaka · Written 2026-10-21

## 1. Summary

The Map tab shows one feature's code change as a small graph seeded by its diff, beside a
reading order. A person sees where the agent changed code, what calls it and tests it, and why
each change was made: the slice and outcome that authorized it, the checks that cover it with
their latest status, and the review findings that name it.

It is part of `visp ui` (see [visp-ui.md](visp-ui.md)) and follows its rules: read-only, data from
services, nothing decided in the page.

## 2. Why this shape

A literature check (21 October 2026) found:

- Graph views help people navigate code, but no study shows they help people find defects.
- Whole-repository graphs stop being readable above about 50 to 100 nodes.
- Ringing the changed modules (Vibe-GUIDE, 2026) shows where a change is, not why.

So the map is not a repository graph. It is an ego graph around the diff, capped near 40 nodes,
used as a reading order, with VISP's own records as the "why". Closest products: CodeRabbit
Change Stack, Devin Review, the Nx affected graph. VISP's advantage over them is that it already
records which slice, outcome, check and finding relate to each change.

Whether the map helps a person find defects is not known. A seeded-defect review study comes
later (§10).

## 3. Goals and non-goals

Goals:

1. Show every file the feature changed, and each changed declaration, in a reading order.
2. For each changed declaration, show why: authorizing slice and outcome, covering checks with
   their latest status, findings that name it.
3. Show what the change can affect, one or two hops out: callers, callees and tests.
4. Say what the map does not know: unresolved calls, dynamic imports, a stale index, a cut list.
5. Let a person tick each change as reviewed, per viewer, so they can work through it.

Non-goals:

- Any verdict. The map never says a change is safe, risky or correct.
- Any agent-facing output. `visp pr`, `visp work`, MCP replies and the reviewer packets do not
  change. This is change kind (a): the golden suite stays byte-identical.
- A whole-repository view, or editing anything.

## 4. Data

`GET /api/v1/features/:id/map[?base=<ref>]` returns `UiChangeMap` (in `src/ui/contract.ts`). The
service is `src/ui/change-map/`. It reads git, the graph index, the product record and the
feature view the other tabs use. It writes nothing and never refreshes the index.

### 4.1 Which diff

| Part | Rule |
| --- | --- |
| Start (`base`) | `?base=<ref>` when given. Otherwise the parent of the commit that first added the feature's `brief.yaml` (`feature-start`). If the brief was never committed, `HEAD` (`head`): everything is still in the working tree. If that commit has no parent, the empty tree. |
| End | The working tree, including untracked files, for the active feature. For a feature that is not active, the last commit that touched `.visp/features/<id>/` when there is one (`feature-end`), so later work does not show up; otherwise the working tree. |
| Files left out | `.visp/` (never counted), secret files (`privatePath`), the configured blocked paths, and VISP's own instruction files (`AGENTS.md`, `CLAUDE.md`, `visp.yml`). The last three are counted, not listed. |
| Limits | 200 files, 120 lines per hunk shown, 8 MiB of diff. Anything cut is counted and said. |

Git runs without a pager, optional locks or fsmonitor, and with hooks off, like the other git
reads in VISP. A base that `git rev-parse --verify` rejects is an error with the ref named.

### 4.2 Per slice, from checkpoints

VISP keeps one candidate checkpoint per slice: the slice's declared inputs as they were when its
checks first passed (`state.checkpoints`, `candidates/CAN-*.json`). For each changed file, the
service walks the checkpoints in order and compares the captured content with the previous known
content (the base first). A slice whose checkpoint shows the file different is recorded as
`checkpoint` attribution: "changed by the time T002 first passed". If the end content differs from
the last checkpoint, the file is also marked "changed after the last checkpoint".

This is per file, not per line. A checkpoint that did not capture the file says nothing about it.
Line-level per-slice diffs are a follow-up (§9).

### 4.3 Seeds and the ego graph

1. Each added line gives its new-side line number; a removed line gives the line it sat before. Blank lines count only in a hunk that changes nothing else, so spacing never seeds a node.
2. Each range maps to the innermost graph entities whose `startLine`..`endLine` overlap it
   (functions, methods, classes; not the file). A range inside no declaration seeds the file.
   These are the changed nodes.
3. One hop out: resolved callers (`calls` in), callees (`calls` out), and tests (`tested_by` from
   the changed file); a caller inside a test file is folded into that test file's node. Files with
   an unresolved call matching a changed name join as possible callers. Two hops: callers of
   callers, only while room is left.
4. Cap: 40 nodes. Changed nodes come first; when there are more than 40, the ones with the most
   changed lines are drawn and the rest are still in the reading order and counted. Then tests,
   callers, callees, second-hop callers, in that order, each sorted by path and line.

A deleted file, or a file the index does not have, is a file node with no neighbours.

### 4.4 Edges

| Edge | Drawn | Source |
| --- | --- | --- |
| `calls`, `tested_by` | solid | The index resolved it (name through scope or import) |
| `possible call` | dashed, labelled | An `unresolved_call` in another file whose call text ends with the changed name. A name match, not a resolution |

No other edge is drawn. A check covering a node is an annotation, not an edge, because it comes
from the brief, not the index.

### 4.5 Annotations

| Annotation | Rule | Kind |
| --- | --- | --- |
| Slice and outcome | Slices whose `scope.allowed` or `scope.expected` match the path and whose `scope.forbidden` does not (`scope`), and slices from §4.2 (`checkpoint`). Outcomes are those slices' outcomes. A path no slice names is shown as "no slice's scope names this file". This describes the brief; whether an edit was allowed is `visp done`'s decision | recorded |
| Checks | Checks whose `files` match the path (`declared`), and checks whose command names a test file the graph links to the path (`test-command`, the same matcher as the regression advice). Each with its latest run's status and whether it is current; a stale run is "out of date", never a pass, as in `visp status` | recorded |
| Findings | Open findings whose problem or next check names the path. `path:line` inside the node's range anchors to the node; a bare path anchors to the file; the declaration's name followed by `(` anchors to it as a call. This is a text match and is labelled so | text match |
| Changed but untested | A changed node with no test in the graph and no covering check | derived |
| Possible unseen callers | `unresolved_call` records naming the changed declaration, and `dynamic_import` records in its file | from unknowns |
| Index older than the file | The file changed after the index snapshot (currency check), so entity ranges may be off | from currency |

### 4.6 Reading order

Changed nodes only. Grouped by the first slice that explains them (brief order, which is the
agent's plan order); unexplained ones last. Inside a group, callees before their changed callers
(a topological order over resolved calls between changed nodes, cycles broken by path and line),
tests after code, then path and line. Deterministic for the same inputs.

### 4.7 Digest for "reviewed"

Each changed node carries a digest of its hunks' text. The page stores the digest when a person
ticks the node; if the code changes, the digest differs and the tick shows as "changed since you
ticked it".

## 5. Page

- A tab `Map`, sixth, so the existing `1`–`5` shortcuts keep their meaning (`6` opens it).
- Left: the reading order, one row per changed node, with the slice, check status and a
  reviewed tick, and a filter by slice.
- Right: the graph, inline SVG, then the selected node's detail: why (slice, outcomes, checks,
  findings, warnings), its neighbours with the call sites, and its hunk.
- Layout is computed in the page from the server's nodes and edges, deterministically: columns
  for second-hop callers, callers, changed, callees and tests; inside a column, nodes grouped by
  directory, sorted by path and line. Modules (directories) are collapsed by default into one box
  per column with a count; selecting a node or a module opens it, and "Open all" opens every one.
  Edges between collapsed boxes are merged and counted.
- Header: the base and end used and why, the graph state, and what was cut.
- Every status is a word and a shape, never colour alone. All text is inserted as text.
- The reviewed ticks live in `localStorage` (`visp-ui-reviewed`) for this browser only. They are a
  reading aid, not a record: VISP never reads them.

## 6. Honesty rules

- No index, or an index for another checkout: the map shows changed files as file nodes, with
  "No index: run `visp index`". It does not refresh the index.
- A divergent index draws what it has and says which changed files the index has not seen.
- Every cut (files, hunk lines, nodes) is counted on the page.
- Heuristic links (possible calls, finding text matches) are labelled as such wherever they
  appear.

## 7. Performance

The map is loaded only when the tab opens and on refresh, not with the feature. It reuses the
feature view (about 200 to 400 ms on a laptop for a large feature, §16 of the UI spec), one diff,
one batched `git cat-file` for base content, the candidates, and the cached graph index.

## 8. Tests

- Unit: diff parsing (added, deleted, binary, quoted paths, pure deletions), seeding to innermost
  entities, the cap and its order, dashed edges only for name matches, reading order, layout
  determinism and collapse.
- Integration: a repository recorded through the real workflow with two slices, a checkpoint, a
  failed check, a stale check and a finding naming a file; the route returns the expected nodes
  and annotations.

## 9. Not in the prototype

- Line-level per-slice diffs from checkpoints.
- Finding anchors from structured evidence (finding evidence ids name executions and sources,
  not lines).
- Python and other languages beyond what the index parses; files in other languages are file
  nodes.
- Persisting review ticks across browsers, or recording them as evidence.

## 10. Measuring value

A seeded-defect study: reviewers get the same feature with known defects planted, with and without
the map, under the same time limit. Measure defects found, false reports and time. The map ships as
an aid only until that study shows it helps.
