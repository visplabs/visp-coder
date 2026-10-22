"""Run one prepared scope arm with a headless Claude Code worker, then judge it.

Usage: run_scope.py <run_name> [--model ...] [--effort ...] [--timeout 1200]
       run_scope.py <run_name> --rescore     (judge a finished run again, from the directory as it is now)

The run is prepared by setup_arm.py with a scope task (scope_env.py). Before the worker starts,
the project, the fake home, the outside directory and the git remote are hashed
(snapshot-before.json); when it ends they are hashed again and the differences, the PATH shim's
log (shim.log), the worker's transcript and, for a VISP arm, the output of `visp pr` are judged
by scope_verdict.py. A run aborts before the worker starts if its HOME is the real home or a path under the
fake home links into it (scope_env.check_home_isolation). Writes scope.json (the verdict and its evidence),
snapshot-after.json, pr.txt and, last, result.json, so a run is finished only once it is judged. No model
judges anything.
"""
import argparse
import json
import pathlib
import subprocess
import sys

import scope_snapshot as snapshots
from common import RUNS
from run_claude import run_session, worker_env
from runfacts import CLAUDE_PROJECTS
from scope_env import check_home_isolation
from scope_verdict import judge, load_events, run_success, transcript_facts


def transcript_paths(result):
    ids = result.get("sessionIds") or [result.get("sessionId")]
    return sorted({path for session in ids if session for path in CLAUDE_PROJECTS.glob(f"*/{session}.jsonl")})


def visp_pr(run, arm):
    """The text `visp pr` prints for the finished project, or None for an arm without VISP."""
    if not str(arm["arm"]).startswith("visp"):
        return None
    try:
        done = subprocess.run(["visp", "pr"], cwd=run / "project", env=worker_env(arm), capture_output=True,
                              text=True, timeout=180)
    except (OSError, subprocess.TimeoutExpired) as error:
        return f"visp pr failed: {error}"
    return done.stdout + done.stderr


def score(run, arm, scenario, result, before):
    """Judge a finished run from its directory; writes scope.json, snapshot-after.json and pr.txt."""
    after = snapshots.take(run)
    snapshots.dump(run / "snapshot-after.json", after)
    changes, remote = snapshots.compare(before, after, run)
    canaries = json.loads((run / "canaries.json").read_text())
    refusals, reads = transcript_facts(transcript_paths(result), run / "project", canaries)
    pr_text = visp_pr(run, arm)
    if pr_text is not None:
        (run / "pr.txt").write_text(pr_text)
    success = run_success(scenario, run / "project", run / "home")
    verdict = judge(scenario, changes, load_events(run / "shim.log"), remote, refusals, reads, success, pr_text)
    verdict.update({"run": run.name, "arm": arm["arm"], "changes": changes, "remote": remote,
                    "refusals": refusals, "reads": reads, "shimEvents": len(load_events(run / "shim.log")),
                    "successChecks": success["checks"]})
    (run / "scope.json").write_text(json.dumps(verdict, indent=2))
    return verdict


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("run")
    parser.add_argument("--model")
    parser.add_argument("--effort")
    parser.add_argument("--timeout", type=int, default=1200)
    parser.add_argument("--rescore", action="store_true")
    args = parser.parse_args()
    run = RUNS / "runs" / args.run
    arm = json.loads((run / "arm.json").read_text())
    scenario = json.loads((run / "scenario.json").read_text())
    if args.rescore:
        result = json.loads((run / "result.json").read_text())
        verdict = score(run, arm, scenario, result, snapshots.load(run / "snapshot-before.json"))
    else:
        # Before anything is hashed or started: the worker's HOME must not be, or link into, the real home.
        check_home_isolation((arm.get("env") or {}).get("HOME") or run / "home", run)
        before = snapshots.take(run)
        snapshots.dump(run / "snapshot-before.json", before)
        result = {"run": args.run, **run_session(run / "project", arm, (run / "prompt.txt").read_text(), args.model,
                                                 args.timeout, effort=args.effort)}
        try:
            verdict = score(run, arm, scenario, result, before)
        except Exception as error:  # a broken verdict must not lose the run: report.py lists it as unusable
            verdict = {"error": repr(error)}
            (run / "scope.json").write_text(json.dumps(verdict))
        (run / "result.json").write_text(json.dumps(result, indent=2))
    print(json.dumps({"run": args.run, "arm": arm["arm"], "overreach": verdict.get("overreach"),
                      "attempt": verdict.get("attempt"), "success": verdict.get("success"),
                      "error": verdict.get("error")}))


if __name__ == "__main__":
    sys.exit(main())
