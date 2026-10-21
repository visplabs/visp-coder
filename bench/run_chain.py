"""Run a chained-changes task: each step's request in its own worker session, on one project.

Usage: run_chain.py <run_name> [--model ...] [--effort ...] [--timeout 2700]

The run must be prepared by setup_arm.py with a chain task (steps/step1.md ... stepN.md, see
chains.py). The starting project is scored first with hidden_test.py --step 0 (baseline.json).
Each step k is then a fresh session on the project exactly as step k-1 left it, as
run_carryover.py's fresh mode: nothing is committed, reset or restated between steps. After it,
the project is scored with --step k, which runs the checks of every step so far.

Writes step<k>/ (result.json, hidden.json, snapshot.tar: the project without .git) per step, and
last chain.json, the per-step summary (new checks passed, carried checks, regressions) whose
presence marks the run finished. The last step's hidden.json is also <run>/hidden.json, the
final score. A session that ends in a CLI error (an API error, a usage limit, a wrapper exit)
stops the chain, since later steps would start from a broken session; batch.py then marks the run
invalid. Timeouts per session are --timeout; a timed-out step is scored and the chain goes on.
"""
import argparse
import json
import shutil
import subprocess
import sys
import tarfile

from chains import BENCH, step_files, summarize
from common import RUNS
from run_claude import run_session

SKIP = {".git", "__pycache__", "node_modules"}


def score(project, task, step):
    """The hidden checks of steps 0..step on the project, or a record of why there is no result."""
    try:
        completed = subprocess.run([sys.executable, str(BENCH / "tasks" / task / "hidden_test.py"), str(project),
                                    "--step", str(step)], capture_output=True, text=True, timeout=900)
        return json.loads(completed.stdout)
    except (subprocess.TimeoutExpired, ValueError) as error:
        return {"passed": 0, "total": 0, "results": [], "error": repr(error)[-500:]}


def snapshot(project, path):
    """The project as a step left it, without version control or caches."""
    with tarfile.open(path, "w") as archive:
        for child in project.iterdir():
            archive.add(child, arcname=child.name,
                        filter=lambda info: None if SKIP.intersection(info.name.split("/")) else info)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("run")
    parser.add_argument("--model", help="default: the worker of the arm's preset")
    parser.add_argument("--effort", help="default: the worker effort of the arm's preset")
    parser.add_argument("--timeout", type=int, default=2700, help="seconds per step session")
    args = parser.parse_args()
    run = RUNS / "runs" / args.run
    project = run / "project"
    arm = json.loads((run / "arm.json").read_text())
    steps = len(step_files(arm["task"]))
    baseline = score(project, arm["task"], 0)
    (run / "baseline.json").write_text(json.dumps(baseline, indent=1))
    evaluations = []
    for step in range(1, steps + 1):
        out = run / f"step{step}"
        out.mkdir(exist_ok=False)
        result = run_session(project, arm, (run / f"prompt-step{step}.txt").read_text(), args.model, args.timeout,
                             effort=args.effort)
        (out / "result.json").write_text(json.dumps({"run": args.run, "step": step, **result}, indent=2))
        scored = score(project, arm["task"], step)
        (out / "hidden.json").write_text(json.dumps(scored, indent=1))
        snapshot(project, out / "snapshot.tar")
        evaluations.append((step, scored))
        facts = summarize(baseline, evaluations)["steps"][-1]
        print(json.dumps({"run": args.run, "step": step, "seconds": result["seconds"], "timedOut": result["timedOut"],
                          "isError": result["isError"], "hidden": f"{scored['passed']}/{scored['total']}",
                          "new": f"{facts['newPassed']}/{facts['newTotal']}", "carried": facts["carried"],
                          "regressions": facts["regressions"]}), flush=True)
        if result["isError"]:
            break
    shutil.copyfile(run / f"step{evaluations[-1][0]}" / "hidden.json", run / "hidden.json")
    summary = summarize(baseline, evaluations)
    (run / "chain.json").write_text(json.dumps({"run": args.run, "task": arm["task"], "steps": steps,
                                                "completed": len(evaluations), **summary}, indent=2))


if __name__ == "__main__":
    main()
