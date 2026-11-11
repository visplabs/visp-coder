---
description: 'Retro of one epic: what went wrong in the pipeline, with proposed fixes (owner only).'
argument-hint: 'VISP-<n>'
disable-model-invocation: true
---

Run a retro of epic $ARGUMENTS for the owner. Read only: change no file, write nothing to Jira.

1. Run `pnpm sdlc pull $ARGUMENTS`, then `pnpm sdlc retro $ARGUMENTS`, and read the report.
2. Sort each mistake group, carried finding, item left to the owner, CI failure and retro note
   into one kind:
   - **pipeline**: a hook, gate, command, agent instruction or setup refused correct work, let
     wrong work through, or hid a problem;
   - **agent**: the agent broke a rule its contract states clearly;
   - **task**: a product or test problem the inner loop caught and fixed (nothing to do);
   - **expected**: a refusal doing its job, such as a protected file.
3. For each pipeline item, find the cause in `scripts/sdlc/`, `.claude/agents/`, `.claude/` or
   the CI workflows and cite it as `file:line`. Check whether `develop` already fixes it
   (`git log --oneline -- <file>`, then read the code); say which commit if so.
4. Show one table: number, kind, problem in one line, evidence (the report line), cause, the
   smallest fix (with the test that would fail first), and "already fixed by …" when it is.
   Agent items name the contract line the agent broke; propose a contract or hook change only
   when the same mistake repeats across tasks.
5. Ask the owner which open pipeline items to file as Jira issues labelled `sdlc-fix`. File
   nothing yourself.
