"""Run a benchmark batch: tasks x arms x repetitions under one preset, several runs at a time.

Usage: batch.py --batch <name> --tasks a,b,c --arms visp:visp-base,visp:visp-cand [--reps 3] [--jobs 4]
                [--preset quality-2026-10] [--dry-run] [--rerun-invalid] [--spend-cap USD]

An arm is anything setup_arm.py accepts, optionally labelled as label=arm; the label defaults to
the build name for VISP arms (visp:visp-base -> visp-base, visp-codex:x -> codex-x) and to the
arm itself otherwise; a mode joins the label with a dash (visp:cand+lean+nocritic -> cand-lean-nocritic). A worker mode ends the
arm (bare+compact100k, visp:cand+compact100k; presets.WORKER_ENV_MODES) and sets environment variables for the
Claude Code worker; the dry run shows them and arm.json records them. Runs are named <batch>-<task>-<label>-<rep> under $VISP_BENCH_RUNS/runs.

The queue goes repetition by repetition, and within one through every task with the arms in an
order that rotates per task, so machine load and a partial batch fall on every arm alike. A
two-session task (session1.md) runs with run_carryover.py in fresh mode: the second session
starts on the project the first left, notes kept. A -raised task runs in intermediate mode, with a
session of its intermediate.md between the two. A chain task (steps/) runs with run_chain.py:
each step is a fresh session on the project the previous step left. Timeouts per session: games
3600 s, every other task 2700 s (per step for a chain). A visp-codex arm runs with run_codex.py; every other arm with run_claude.py.

Restartable: a finished run is skipped; a run left unfinished by an interrupted batch is moved
to $VISP_BENCH_RUNS/discarded and run again, after stopping any runner or worker the earlier
batch left running there (runner.pid, worker.pid). SIGTERM or SIGHUP stops the running runs'
runners and workers before the driver exits. After each run, runfacts.py checks for a usage-limit
stop (in CLI error results, API-error events and VISP's failed reviewer and tester records) and
for a worker failure (the CLI ended a session in error: an API error, no response, a wrapper
exit); such a run gets invalid.json and is never scored. After a usage limit no further runs
start, since the limit applies to every run. --rerun-invalid moves invalid runs to discarded/ and
redoes them. --dry-run prints the queue and what would happen to each run, and changes nothing.

--spend-cap USD starts spend_guard.py as a child: it sums the cost every run's claude-calls.jsonl
logs and, above the cap, sends this driver SIGTERM and writes batches/<name>/stopped-by-spend-guard.json.
The guard finds the driver by the pid recorded in the manifest ("driverPid", written here at the start of
every pass) and checked against /proc, so a stale pid is never signalled. A restart moves an earlier stop
record aside and counts the money already spent toward the cap.

Writes $VISP_BENCH_RUNS/batches/<name>/manifest.json (preset, arms, tasks, the planned runs, driverPid)
and batch.log. report.py reads the manifest.
"""
import argparse
import concurrent.futures
import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import threading
import time

from chains import is_chain, step_files
from common import RUNS, stop_recorded
from judge import CHECKLISTS, GAMES
from presets import preset, split_worker_modes, visp_build, worker_env
from run_carryover import batch_mode, planned_sessions
from runfacts import invalid, invalidity, is_finished, mark_if_invalid
import snapshots

BENCH = pathlib.Path(__file__).resolve().parent
TIMEOUTS = {"visual": 2700, "game": 3600, "carryover": 2700, "chain": 2700, "code": 2700}
log_lock = threading.Lock()
stop = threading.Event()
active, active_lock = set(), threading.Lock()
guard = None


def kind(task):
    task_dir = BENCH / "tasks" / task
    if not task_dir.is_dir():
        raise SystemExit(f"unknown task {task}")
    if task in GAMES:
        return "game"
    if (task_dir / "session1.md").is_file():
        return "carryover"
    if is_chain(task):
        return "chain"
    if task in CHECKLISTS:
        return "visual"
    return "code"


def label(spec):
    if "=" in spec:
        name, arm = spec.split("=", 1)
        return name, arm
    if spec.startswith("visp:"):
        return spec.split(":", 1)[1].replace("+", "-"), spec
    if spec.startswith("visp-codex:"):
        return "codex-" + spec.split(":", 1)[1], spec
    return spec.replace("+", "-"), spec


def worker_note(arm):
    """What a worker mode of the arm sets, for the dry run; "" for none."""
    modes = split_worker_modes(arm)[1]
    return "worker env " + " ".join(f"{key}={value}" for key, value in worker_env(modes).items()) if modes else ""


def plan(args):
    tasks = args.tasks.split(",")
    arms = [label(spec) for spec in args.arms.split(",")]
    for _, arm in arms:
        if split_worker_modes(arm)[1] and split_worker_modes(arm)[0].startswith("visp-codex:"):
            raise SystemExit(f"{arm}: worker modes set Claude Code variables; a Codex worker does not read them")
    if len({name for name, _ in arms}) != len(arms):
        raise SystemExit("two arms share a label; name them as label=arm")
    runs = []
    for rep in range(1, args.reps + 1):
        for index, task in enumerate(tasks):
            task_kind = kind(task)
            if task_kind in ("carryover", "chain") and any(arm.startswith("visp-codex:") for _, arm in arms):
                raise SystemExit(f"{task} has several sessions, which {task_kind} runs make with Claude Code only")
            shift = (rep - 1 + index) % len(arms)
            for name, arm in arms[shift:] + arms[:shift]:
                runs.append({"name": f"{args.batch}-{task}-{name}-{rep}", "task": task, "kind": task_kind,
                             "arm": arm, "label": name, "rep": rep, "timeout": TIMEOUTS[task_kind],
                             "twoSessions": task_kind == "carryover",
                             **({"note": worker_note(arm)} if worker_note(arm) else {}),
                             "mode": batch_mode(task) if task_kind == "carryover" else None})
    return tasks, arms, runs


def log(directory, message):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}"
    with log_lock:
        print(line, flush=True)
        if directory:
            with open(directory / "batch.log", "a") as handle:
                handle.write(line + "\n")


def state(entry, rerun_invalid, record=True):
    """What the batch does with a run: run, skip, rerun (invalid) or redo (unfinished).

    A finished run is checked first for a usage-limit stop or a worker failure (runfacts.py);
    record=False only looks.
    """
    run = RUNS / "runs" / entry["name"]
    if not run.exists():
        return "run"
    if not is_finished(run, entry["twoSessions"]):
        return "redo"
    if (mark_if_invalid if record else lambda run: invalid(run) or invalidity(run))(run):
        return "rerun" if rerun_invalid else "skip-invalid"
    return "skip"


def discard(run, reason):
    target = RUNS / "discarded" / f"{run.name}-{time.strftime('%Y%m%d-%H%M%S')}-{reason}"
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(run), target)
    return target


def prepare(entry, args):
    """Set a run up. Returns the reason it failed, or None.

    An ordinary run is made by setup_arm.py; a snapshot rerun (entry["snapshot"], snapshots.py) is
    made from a finished run's session-1 snapshot.
    """
    if entry.get("snapshot"):
        try:
            snapshots.prepare(RUNS, entry, args.preset)
        except (OSError, ValueError, KeyError, SystemExit) as problem:
            return str(problem)[-500:]
        return None
    setup = subprocess.run([sys.executable, str(BENCH / "setup_arm.py"), entry["task"], entry["arm"], entry["name"],
                            "--preset", args.preset], capture_output=True, text=True)
    return None if setup.returncode == 0 else setup.stderr.strip()[-500:]


def execute(entry, args, directory):
    name, run = entry["name"], RUNS / "runs" / entry["name"]
    action = state(entry, args.rerun_invalid)
    if action.startswith("skip"):
        return name, action
    if stop.is_set():
        return name, "not started (usage limit)"
    if action in ("redo", "rerun"):
        # A driver killed earlier can leave its runner and worker running in this directory.
        stopped = stop_recorded(run)
        if stopped and not gone(stopped):
            log(directory, f"{name}: processes {stopped} of an earlier batch still run; not redone")
            return name, "busy"
        if stopped:
            log(directory, f"{name}: stopped processes {stopped} left by an earlier batch")
        log(directory, f"{name}: moved to {discard(run, 'invalid' if action == 'rerun' else 'unfinished')}")
    problem = prepare(entry, args)
    if problem:
        log(directory, f"{name}: setup failed: {problem}")
        return name, "setup failed"
    timeout = str(entry["timeout"])
    if entry.get("snapshot"):
        argv = [str(BENCH / "snapshot_rerun.py"), "--run", name, "--timeout", timeout]
    elif entry["twoSessions"]:
        argv = [str(BENCH / "run_carryover.py"), name, "--modes", entry["mode"], "--timeout", timeout]
    elif entry["kind"] == "chain":
        argv = [str(BENCH / "run_chain.py"), name, "--timeout", timeout]
    elif entry["arm"].startswith("visp-codex:"):
        argv = [str(BENCH / "run_codex.py"), name, "--timeout", timeout]
    else:
        argv = [str(BENCH / "run_claude.py"), name, "--timeout", timeout]
    started = time.time()
    log(directory, f"{name}: started")
    # Own session, so a signal to the driver's group does not reach it; the driver's handler and a
    # later batch stop it through runner.pid instead.
    runner = subprocess.Popen([sys.executable, *argv], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True, start_new_session=True)
    (run / "runner.pid").write_text(str(runner.pid))
    with active_lock:
        active.add(run)
    stdout, stderr = runner.communicate()
    with active_lock:
        active.discard(run)
    (run / "runner.pid").unlink(missing_ok=True)
    outcome = "finished" if is_finished(run, entry["twoSessions"]) else f"no result (exit {runner.returncode})"
    stopped = mark_if_invalid(run) if outcome == "finished" else None
    if stopped:
        if stopped["reason"] == "usage limit":
            stop.set()
        outcome = f"invalid ({stopped['reason']}): {stopped['source']}: {stopped['match'].strip()[:160]!r}"
    log(directory, f"{name}: {outcome} in {round(time.time() - started)} s {stdout.strip()[-200:]} "
                   f"{stderr.strip()[-300:]}".rstrip())
    return name, outcome


def gone(pids, wait=10):
    """Whether every pid has exited, waiting up to `wait` seconds."""
    deadline = time.time() + wait
    while time.time() < deadline:
        if not any(pathlib.Path(f"/proc/{pid}").exists() for pid in pids):
            return True
        time.sleep(0.2)
    return False


def lock(directory):
    path = directory / "lock"
    if path.exists():
        try:
            os.kill(int(path.read_text()), 0)
            raise SystemExit(f"batch already running (pid {path.read_text()}); {path}")
        except (ProcessLookupError, PermissionError, ValueError):
            # Gone, or the pid now belongs to another user's process: the lock is stale.
            pass
    path.write_text(str(os.getpid()))
    return path


def on_signal(directory, lock_path):
    """On SIGTERM or SIGHUP, stop every running run's runner and worker, then exit."""
    def handle(number, _frame):
        stop.set()
        with active_lock:
            runs = list(active)
        for run in runs:
            log(directory, f"{run.name}: stopped {stop_recorded(run)} on signal {number}")
        stop_guard()
        lock_path.unlink(missing_ok=True)
        os._exit(128 + number)
    for number in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(number, handle)


def start_guard(directory, args):
    """The spend guard as a child process. An earlier stop record is moved aside so the new one is clear."""
    global guard
    earlier = directory / "stopped-by-spend-guard.json"
    if earlier.exists():
        moved = earlier.rename(directory / f"stopped-by-spend-guard-{time.strftime('%Y%m%d-%H%M%S')}.json")
        log(directory, f"an earlier spend-guard stop moved to {moved.name}")
    guard = subprocess.Popen([sys.executable, str(BENCH / "spend_guard.py"), args.batch, "--cap", str(args.spend_cap),
                              "--interval", str(args.spend_interval)])
    log(directory, f"spend guard {guard.pid}: stops this batch above ${args.spend_cap:.2f}, "
                   f"looking every {args.spend_interval:g} s")


def stop_guard():
    if guard and guard.poll() is None:
        guard.terminate()


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--batch", required=True)
    parser.add_argument("--tasks", required=True)
    parser.add_argument("--arms", required=True)
    parser.add_argument("--reps", type=int, default=3)
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--preset", default="default")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--rerun-invalid", action="store_true")
    parser.add_argument("--spend-cap", type=float, metavar="USD",
                        help="stop the batch above this total cost (spend_guard.py); counts runs already made")
    parser.add_argument("--spend-interval", type=float, default=60, help="seconds between the guard's looks")
    args = parser.parse_args()
    tasks, arms, runs = plan(args)
    drive(args, tasks, arms, runs)


def describe(entry):
    """The tail of a dry-run line: sessions, then what sets the run apart (a snapshot's source, worker env)."""
    sessions = f" x{1 + len(planned_sessions(entry['mode']))} sessions" if entry["twoSessions"] else ""
    if entry["kind"] == "chain":
        sessions = f" x{len(step_files(entry['task']))} steps"
    if entry.get("snapshot"):
        sessions = " x1 session (second only)"
    return f"{entry['timeout']} s{sessions}" + (f" {entry['note']}" if entry.get("note") else "")


def drive(args, tasks, arms, runs, extra=None):
    """Run (or, with --dry-run, list) the planned runs; `extra` is added to the manifest.

    args needs batch, jobs, preset, reps, dry_run, rerun_invalid, spend_cap and spend_interval.
    """
    settings = preset(args.preset)
    directory = RUNS / "batches" / args.batch
    manifest_path = directory / "manifest.json"
    previous = json.loads(manifest_path.read_text()) if manifest_path.exists() else None
    if previous and previous["preset"] != args.preset:
        raise SystemExit(f"batch {args.batch} was started with preset {previous['preset']}, not {args.preset}")
    builds = {visp_build(arm)[0] for _, arm in arms if arm.startswith(("visp:", "visp-codex:"))}
    missing = sorted(build for build in builds if not (RUNS / "shims" / build).is_dir())
    if missing:
        message = f"no VISP build for {', '.join(missing)} in {RUNS / 'shims'}; make it with build_visp.sh"
        if not args.dry_run:
            raise SystemExit(message)
        print(f"warning: {message}")
    if args.dry_run:
        print(f"batch {args.batch}, preset {args.preset} (worker {settings['worker']['model']}"
              f" {settings['worker']['effort'] or 'default effort'}), {len(runs)} runs, {args.jobs} at a time")
        if args.spend_cap is not None:
            print(f"spend guard: stops the batch above ${args.spend_cap:.2f}, looking every {args.spend_interval:g} s")
        for entry in runs:
            print(f"{state(entry, args.rerun_invalid, record=False):13} {entry['name']:60} {entry['arm']:30} "
                  f"{entry['kind']:9} {describe(entry)}")
        return
    directory.mkdir(parents=True, exist_ok=True)
    lock_path = lock(directory)
    on_signal(directory, lock_path)
    try:
        known = {entry["name"] for entry in runs}
        kept = [entry for entry in (previous or {}).get("runs", []) if entry["name"] not in known]
        manifest = {"batch": args.batch, "preset": args.preset, "settings": settings, "tasks": tasks,
                    "arms": [{"label": name, "arm": arm} for name, arm in arms], "reps": args.reps,
                    "created": (previous or {}).get("created") or time.strftime("%Y-%m-%dT%H:%M:%S"),
                    "driverPid": os.getpid(), "spendCap": args.spend_cap, "runs": runs + kept, **(extra or {})}
        manifest_path.write_text(json.dumps(manifest, indent=2))
        log(directory, f"batch {args.batch}: {len(runs)} runs, preset {args.preset}, {args.jobs} at a time")
        if args.spend_cap is not None:
            start_guard(directory, args)
        outcomes = {}
        with concurrent.futures.ThreadPoolExecutor(args.jobs) as pool:
            futures = [pool.submit(execute, entry, args, directory) for entry in runs]
            for future in concurrent.futures.as_completed(futures):
                name, outcome = future.result()
                outcomes[name] = outcome
        manifest["lastPass"] = {"finished": time.strftime("%Y-%m-%dT%H:%M:%S"), "outcomes": outcomes}
        manifest_path.write_text(json.dumps(manifest, indent=2))
        if stop.is_set():
            log(directory, "stopped early: a usage limit was hit; run again with --rerun-invalid after it resets")
        log(directory, "batch pass finished")
    finally:
        stop_guard()
        lock_path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
