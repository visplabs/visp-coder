---
name: performance-testing
description: 'How to measure and judge performance in visp-coder: repeated wall-clock runs, median and p90 against a stored baseline, and the 15% budget from AGENTS.md. Rule ids PF-01... Use for performance criteria and CLI or hook latency changes.'
---

# Performance testing

- **PF-01 Measure, do not estimate.** Every performance claim comes from runs on this machine
  with the exact command recorded.
- **PF-02 Repeat.** Warm up once, then run at least 10 times; report the median and p90. One run
  is noise.
- **PF-03 Compare like with like.** Baseline and candidate run on the same machine, same build
  type (`pnpm build`), same inputs, one after the other, nothing heavy running alongside (the
  SDLC run lock keeps other heavy runs out).
- **PF-04 Budget.** A change may be at most 15% slower than the baseline median unless the
  owner accepts a measured quality gain that pays for it (AGENTS.md speed guardrail).
- **PF-05 Baselines** live in `.sdlc/perf/baselines.yml` as
  `{ name, command, median_ms, p90_ms, runs, commit, measured_at }`. Update a baseline only
  from `develop`, never from the branch under test.
- **PF-06 What to measure.** CLI start (`node dist/cli/main.js --version`), hook latency (feed a
  recorded event on stdin), and any command the criterion names. For in-process functions, use
  `vitest bench`.

A simple timing loop, when no tool is installed:

```sh
for i in $(seq 11); do /usr/bin/time -f %e <command> >/dev/null; done 2>&1 | tail -n 10 | sort -n
```
