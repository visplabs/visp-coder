"""Score benchmark runs with a task's reviewer probes.

Usage: probe.py <task> <run_name> [<run_name> ...]
       probe.py <task> --project <dir> [--out <file>]
       probe.py --list <task>

Probes are checks like the hidden checks, kept in bench/tasks/<task>/probes/probes.py and scored as
their own metric. They test contract rules that a VISP reviewer's findings cover and the hidden
checks leave out (bench/probekit.py explains the groups). The first form writes probes.json beside
each run's project and prints one line per run, as score.py does for hidden.json. The second scores
any directory (for example a copy of a finished tree) and writes nothing unless --out is given.
Runs marked invalid (invalid.json) are skipped.
"""
import json
import pathlib
import subprocess
import sys

BENCH = pathlib.Path(__file__).resolve().parent


def probe_script(task):
    return BENCH / "tasks" / task / "probes" / "probes.py"


def has_probes(task):
    return probe_script(task).exists()


def score_project(task, project, timeout=600):
    """Run the task's probes on a project directory; returns the result dict, or {"error": ...}."""
    if not has_probes(task):
        raise SystemExit(f"task {task} has no probes ({probe_script(task)})")
    try:
        out = subprocess.run([sys.executable, str(probe_script(task)), str(project)], capture_output=True,
                             text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"error": f"probes timed out after {timeout} s"}
    try:
        return json.loads(out.stdout)
    except ValueError:
        return {"error": f"no result: {out.stderr[-300:]}"}


def summarize(result):
    """Counts of a probes result: all probes, the probes that came from a reviewer finding, and per group."""
    results = (result or {}).get("results") or []
    passed = sum(bool(r["passed"]) for r in results)
    found = [r for r in results if r.get("finding")]
    groups = {}
    for r in results:
        pair = groups.setdefault(r.get("group") or "request", [0, 0])
        pair[0] += bool(r["passed"])
        pair[1] += 1
    return {
        "passed": passed, "total": len(results), "rate": passed / len(results) if results else 0.0,
        "text": f"{passed}/{len(results)}",
        "findingsPassed": sum(bool(r["passed"]) for r in found), "findingsTotal": len(found),
        "groups": {name: {"passed": p, "total": t} for name, (p, t) in groups.items()},
        "failed": [r["name"] for r in results if not r["passed"]],
    }


def line(name, result):
    if not result or "error" in result:
        return f"{name}: no result ({(result or {}).get('error', 'empty')})"
    s = summarize(result)
    groups = " ".join(f"{g} {v['passed']}/{v['total']}" for g, v in s["groups"].items())
    return (f"{name}: probes {s['text']} ({groups}) findings {s['findingsPassed']}/{s['findingsTotal']} "
            f"failed={s['failed']}")


def main(argv):
    from common import RUNS

    if argv[:1] == ["--list"]:
        if len(argv) != 2 or not has_probes(argv[1]):
            raise SystemExit("usage: probe.py --list <task> (a task with a probes/ directory)")
        print(subprocess.run([sys.executable, str(probe_script(argv[1])), "--list"], capture_output=True,
                             text=True, check=True).stdout, end="")
        return
    if len(argv) < 2:
        raise SystemExit(__doc__)
    task, rest = argv[0], argv[1:]
    if rest[0] == "--project":
        result = score_project(task, rest[1])
        if "--out" in rest:
            pathlib.Path(rest[rest.index("--out") + 1]).write_text(json.dumps(result, indent=1))
        print(line(rest[1], result))
        return
    for name in rest:
        project = RUNS / "runs" / name / "project"
        if (RUNS / "runs" / name.split("/")[0] / "invalid.json").exists():
            print(f"{name}: skipped, the run is invalid (invalid.json)")
            continue
        result = score_project(task, project)
        (project.parent / "probes.json").write_text(json.dumps(result, indent=1))
        print(line(name, result))


if __name__ == "__main__":
    main(sys.argv[1:])
