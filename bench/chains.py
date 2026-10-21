"""Chained-changes tasks: their steps, and the regressions their per-step hidden results show.

A chain task has start/, steps/step1.md ... stepN.md and a hidden_test.py whose `--step k` runs
the checks of steps 0..k, each result carrying its `step` (0 is the starting contract). A run made
by run_chain.py has baseline.json (the start scored with --step 0) and step<k>/hidden.json (the
project after step k scored with --step k).

A check is carried into step k when it belongs to an earlier step and passed in the evaluation
before step k. A carried check that fails after step k is a regression of step k.
"""
import json
import pathlib
import re

BENCH = pathlib.Path(__file__).resolve().parent


def is_chain(task):
    return (BENCH / "tasks" / task / "steps").is_dir()


def step_files(task):
    """steps/step1.md ... stepN.md, in step order."""
    files = (BENCH / "tasks" / task / "steps").glob("step*.md")
    return sorted(files, key=lambda path: int(re.sub(r"\D", "", path.stem)))


def _load(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def _outcomes(scored):
    """{check name: (step, passed)} of one evaluation; empty when the checks gave no result."""
    results = (scored or {}).get("results") or []
    return {r["name"]: (r.get("step", 0), bool(r["passed"])) for r in results}


def summarize(baseline, evaluations, redefined=None):
    """Per-step and whole-chain regression facts.

    baseline: the start's results with --step 0; evaluations: [(step, results with --step step)],
    in step order. A step without a result passes nothing, so its carried checks all regress.
    redefined: {step: check names} that step's own request changes (a ChainSWE issue's
    FAIL_TO_PASS tests can be earlier issues' tests its test patch rewrites); they are not
    carried into that step.
    """
    previous = _outcomes(baseline)
    steps, carried, broken, events, evaluated = [], set(), set(), 0, 0
    for step, scored in evaluations:
        now = _outcomes(scored)
        changed = (redefined or {}).get(step, set())
        carried_here = sorted(name for name, (origin, passed) in previous.items()
                              if passed and origin < step and name not in changed)
        regressions = [name for name in carried_here if not now.get(name, (None, False))[1]]
        new = [passed for origin, passed in now.values() if origin == step]
        steps.append({
            "step": step, "passed": sum(passed for _, passed in now.values()), "total": len(now),
            "newPassed": sum(new), "newTotal": len(new), "carried": len(carried_here), "regressions": regressions,
            "noResult": not now,
        })
        carried.update(carried_here)
        broken.update(regressions)
        events += len(regressions)
        evaluated += len(carried_here)
        previous = now
    return {
        "steps": steps, "carriedChecks": len(carried), "brokenChecks": sorted(broken),
        "kept": round(1 - len(broken) / len(carried), 4) if carried else None,
        "regressed": bool(broken), "regressionEvents": events, "carriedEvaluations": evaluated,
    }


def run_summary(run):
    """summarize() over a run_chain.py run's files; None when the run has no step results."""
    evaluations = []
    for path in sorted(run.glob("step*/hidden.json"), key=lambda path: int(re.sub(r"\D", "", path.parent.name))):
        evaluations.append((int(re.sub(r"\D", "", path.parent.name)), _load(path)))
    if not evaluations:
        return None
    return summarize(_load(run / "baseline.json"), evaluations)
