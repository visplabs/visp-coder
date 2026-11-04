# Architecture decision records

Each file records one decision about how visp-coder is built: the context, the decision, and
what follows from it. These files are the source of truth; the wiki links here.

Name new records `NNNN-short-title.md`, numbered in order, and copy the template below. A record
is not edited after it is accepted. To change a decision, write a new record that supersedes the
old one and set the old one's status to `Superseded by NNNN`.

| Record | Status |
| --- | --- |
| [0001 Agent SDLC](0001-agent-sdlc.md) | Accepted |

## Template

```markdown
# NNNN Title

Status: Proposed | Accepted | Superseded by NNNN
Date: YYYY-MM-DD

## Context
What forces the decision, with evidence.

## Decision
What we will do.

## Consequences
What becomes easier, what becomes harder, and what we will watch.
```
