"""Stop a batch whose spend passes a cap.

Usage: spend_guard.py <batch> --cap <usd> [--interval 60] [--once]
       batch.py ... --spend-cap <usd>      starts this as a child, so one launch command covers both

Every `claude` call a run makes (the worker, and VISP's reviewer and tester) is logged with its
reported cost in <run>/claude-calls.jsonl (claude_shim). The guard sums the `cost` of every such
file under the runs listed in $VISP_BENCH_RUNS/batches/<batch>/manifest.json, and under
discarded/<run>-* (a run moved aside by a restart or --rerun-invalid has spent its money too). A
file named claude-calls*.jsonl anywhere in a run counts, so a judge or scoring call is included if a
build logs it; today judge.py and code_judge.py call `claude` without the shim and are not logged.

Above the cap it writes batches/<batch>/stopped-by-spend-guard.json with the total and prints its log
line, then sends SIGTERM to the batch driver, which stops every run's runner and worker and exits
(batch.py on_signal), then waits for the driver to go and completes the record ("complete": true,
"driverExited"). The record comes first because the driver's handler also terminates its guard; the
guard ignores SIGTERM from the first write until the record is complete, so a record that says
"complete": false means the guard was cut off by something else (SIGKILL, a reboot).
The driver is the pid batch.py records in the manifest ("driverPid"), or failing that in the batch's
lock file; the guard signals it only if /proc shows a live process whose command line is a batch.py
run for this batch, so a recycled pid is left alone. It checks every `interval` seconds and exits when
the driver is gone. A restart with the same cap is stopped again at once; raise the cap, or move the
stop record aside (batch.py does when it starts).

Exit status: 0 when the driver ended with the spend under the cap, 2 after stopping the batch.
"""
import argparse
import contextlib
import json
import os
import pathlib
import signal
import time

from common import RUNS

STOP_FILE = "stopped-by-spend-guard.json"
# Directories of a run that hold a worker's project, never a call log.
PRUNE = {"project", ".git", "node_modules", "memory", "__pycache__"}


def call_cost(line):
    """The cost one log line reports, 0 for anything that is not a priced call."""
    try:
        cost = json.loads(line).get("cost")
    except (ValueError, AttributeError):
        return 0.0
    return float(cost) if isinstance(cost, (int, float)) and not isinstance(cost, bool) else 0.0


def log_files(run):
    """Every claude-calls*.jsonl under a run directory, without walking into the worker's project."""
    for directory, names, files in os.walk(run):
        names[:] = [name for name in names if name not in PRUNE]
        for name in files:
            if name.startswith("claude-calls") and name.endswith(".jsonl"):
                yield pathlib.Path(directory) / name


def run_spend(run):
    total = 0.0
    for path in log_files(run):
        try:
            total += sum(call_cost(line) for line in path.read_text(errors="replace").splitlines())
        except OSError:
            continue
    return total


def run_directories(manifest, root):
    """The directories whose logs belong to the batch: its runs, and the ones moved to discarded/."""
    found = []
    for entry in manifest.get("runs", []):
        found.append(root / "runs" / entry["name"])
        found += sorted((root / "discarded").glob(f"{entry['name']}-*"))
    return found


def batch_spend(manifest, root):
    """(total, {run directory name: cost}) over the batch's runs."""
    per_run = {}
    for run in run_directories(manifest, root):
        if run.is_dir():
            per_run[run.name] = round(run_spend(run), 6)
    return round(sum(per_run.values()), 6), per_run


def is_driver(pid, batch):
    """Whether pid is a live `batch.py ... --batch <batch>` process."""
    try:
        argv = pathlib.Path(f"/proc/{pid}/cmdline").read_bytes().decode(errors="replace").split("\0")
    except OSError:
        return False
    if not any(pathlib.PurePath(word).name == "batch.py" for word in argv):
        return False
    return any(word == f"--batch={batch}" or (word == "--batch" and argv[i + 1:i + 2] == [batch])
               for i, word in enumerate(argv))


def driver_pid(manifest, directory, batch):
    """The live driver of the batch: the manifest's driverPid, else the lock file's pid, else None."""
    candidates = [manifest.get("driverPid")]
    try:
        candidates.append(int((directory / "lock").read_text()))
    except (OSError, ValueError):
        pass
    for pid in candidates:
        if isinstance(pid, int) and pid > 0 and is_driver(pid, batch):
            return pid
    return None


def read_manifest(directory):
    try:
        return json.loads((directory / "manifest.json").read_text())
    except (OSError, ValueError):
        return None


def write_record(directory, record):
    """Replace the stop record in one step, so nobody reads half of it."""
    temporary = directory / f"{STOP_FILE}.tmp"
    temporary.write_text(json.dumps(record, indent=2))
    os.replace(temporary, directory / STOP_FILE)


@contextlib.contextmanager
def ignoring_sigterm():
    """The driver's handler terminates its guard on the way out; the guard must outlive it to record the stop."""
    previous = signal.signal(signal.SIGTERM, signal.SIG_IGN)
    try:
        yield
    finally:
        signal.signal(signal.SIGTERM, previous)


def stop(directory, batch, cap, total, per_run, pid, waited=30, announce=None):
    """Record why, SIGTERM the driver, wait for it to exit, and complete the record. Returns the record.

    The record is on disk and announce(record) has been called before the driver is signalled.
    """
    record = {"batch": batch, "cap": cap, "total": total, "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
              "driverPid": pid, "signalled": False, "driverExited": None, "complete": False,
              "perRun": dict(sorted(per_run.items(), key=lambda item: -item[1])[:20])}
    if pid is None:
        record["note"] = "no live driver was found; nothing was signalled"
    with ignoring_sigterm():
        write_record(directory, record)
        if announce:
            try:
                announce(record)
            except OSError:
                pass  # a log whose reader is gone must not keep the batch running
        if pid is not None:
            try:
                os.kill(pid, signal.SIGTERM)
                record["signalled"] = True
            except OSError as problem:
                record["note"] = f"could not signal {pid}: {problem}"
            deadline = time.time() + waited
            # An exited process that its parent has not reaped has an empty command line, so is_driver is False.
            while record["signalled"] and time.time() < deadline and is_driver(pid, batch):
                time.sleep(0.2)
            record["driverExited"] = record["signalled"] and not is_driver(pid, batch)
        record["complete"] = True
        write_record(directory, record)
    return record


def check(batch, cap, root, waited=30, announce=None):
    """One look: ("over", record) after stopping the batch, ("running", total) or ("done", total)."""
    directory = root / "batches" / batch
    manifest = read_manifest(directory)
    if manifest is None:
        raise SystemExit(f"no manifest at {directory / 'manifest.json'}")
    total, per_run = batch_spend(manifest, root)
    pid = driver_pid(manifest, directory, batch)
    if total > cap:
        return "over", stop(directory, batch, cap, total, per_run, pid, waited, announce)
    return ("running" if pid else "done"), total


def say(message):
    print(f"{time.strftime('%H:%M:%S')} spend guard: {message}", flush=True)


def announce(record):
    """The log line for a stop, printed before the driver is signalled."""
    say(f"${record['total']:.2f} is over the ${record['cap']:.2f} cap; "
        + (f"stopping driver {record['driverPid']}" if record["driverPid"] else record["note"]))


def closing(record):
    """What became of the driver, for the line after the wait (None when there was no driver)."""
    if record["driverPid"] is None:
        return None
    if record["driverExited"]:
        return f"driver {record['driverPid']} exited"
    return record["note"] if not record["signalled"] else f"driver {record['driverPid']} is still running"


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("batch")
    parser.add_argument("--cap", type=float, required=True, help="USD; the batch is stopped above it")
    parser.add_argument("--interval", type=float, default=60, help="seconds between looks (default 60)")
    parser.add_argument("--once", action="store_true", help="look once and exit")
    args = parser.parse_args()
    while True:
        state, value = check(args.batch, args.cap, RUNS, announce=announce)
        if state == "over":
            if closing(value):
                say(closing(value))
            raise SystemExit(2)
        say(f"${value:.2f} of ${args.cap:.2f}" + ("" if state == "running" else "; driver gone"))
        if state == "done" or args.once:
            return
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
