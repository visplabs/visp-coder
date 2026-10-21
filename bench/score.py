"""Score benchmark runs with a task's hidden tests.

Usage: score.py <task> [--stage 1] <run_name> [<run_name> ...]
Writes hidden.json (hidden-stage1.json with --stage 1) beside each project and prints one line
per run. A two-session run's modes are scored as <run>/<mode>; run_carryover.py scores the first
session itself. A chain run is scored on its final project with every step's checks, grouped by
step; run_chain.py scores each step itself. Runs marked invalid (invalid.json, a usage limit stopped them) are skipped.
"""
import json
import pathlib
import subprocess
import sys

from common import RUNS

BENCH = pathlib.Path(__file__).resolve().parent
GROUPS = ("ext", "new", "code", "memory", "ui")
task, names = sys.argv[1], sys.argv[2:]
stage = []
if names[:1] == ["--stage"]:
    stage, names = names[:2], names[2:]
for name in names:
    project = RUNS / "runs" / name / "project"
    if (RUNS / "runs" / name.split("/")[0] / "invalid.json").exists():
        print(f"{name}: skipped, the run is invalid (invalid.json)")
        continue
    out = subprocess.run([sys.executable, str(BENCH / "tasks" / task / "hidden_test.py"), str(project), *stage],
                         capture_output=True, text=True, timeout=600)
    (project.parent / ("hidden-stage1.json" if stage else "hidden.json")).write_text(out.stdout)
    try:
        result = json.loads(out.stdout)
    except ValueError:
        print(f"{name}: no result ({out.stderr[-300:]})")
        continue
    groups = {}
    for r in result["results"]:
        prefix = r["name"].split(":", 1)[0] if r["name"].startswith(tuple(f"{g}:" for g in GROUPS)) else "core"
        if "step" in r:
            prefix = "base" if r["step"] == 0 else f"s{r['step']}"
        groups.setdefault(prefix, []).append(r)
    failed = [r["name"] for r in result["results"] if not r["passed"]]
    score = " ".join(
        f"{'' if name == 'core' else name + ' '}{sum(r['passed'] for r in rows)}/{len(rows)}"
        for name, rows in groups.items()
    )
    print(f"{name}: {score} failed={failed}")
