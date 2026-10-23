"""Unit tests for the spend guard (spend_guard.py) and its hook in batch.py.

Run from the repository root: python3 -m unittest bench/test_spend_guard.py
No models are called. The runs are fake directories with claude-calls.jsonl files, and the batch
driver is a fake process: a script named batch.py started with `--batch <name>`, which exits on
SIGTERM and writes a marker file, so the guard's signal is observed.
"""
import json
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time
import unittest

BENCH = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(BENCH))

import spend_guard  # noqa: E402

DRIVER = """import pathlib, signal, sys, time
marker = pathlib.Path(sys.argv[-1])
def stop(number, frame):
    marker.write_text("terminated")
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
pathlib.Path(sys.argv[-1] + ".ready").write_text("ready")
time.sleep(60)
"""
# A driver that never leaves on SIGTERM.
STUBBORN_DRIVER = DRIVER.replace("signal.signal(signal.SIGTERM, stop)", "signal.signal(signal.SIGTERM, signal.SIG_IGN)")

# A driver that starts the guard as its child, as batch.py does, and on SIGTERM does what batch.py's
# on_signal does: stops the guard (always, as the old stop_guard did) and exits at once. The marker says
# whether the stop record was on disk when the signal arrived.
GUARDING_DRIVER = """import json, os, pathlib, signal, subprocess, sys, time
bench, root, marker = (pathlib.Path(arg) for arg in sys.argv[3:6])
directory = root / "batches" / "b3"
(directory / "manifest.json").write_text(json.dumps(
    {"batch": "b3", "runs": [{"name": "b3-t-bare-1"}], "driverPid": os.getpid()}))
guard = None
def stop(number, frame):
    marker.write_text("record-present" if (directory / "stopped-by-spend-guard.json").exists() else "record-missing")
    if guard is not None and guard.poll() is None:
        guard.terminate()
    os._exit(128 + number)
signal.signal(signal.SIGTERM, stop)
guard = subprocess.Popen([sys.executable, str(bench / "spend_guard.py"), "b3", "--cap", "5", "--interval", "0.1"])
time.sleep(60)
"""

# The same, with batch.py's own on_signal and start_guard.
BATCH_PY_DRIVER = """import argparse, importlib.util, json, os, pathlib, sys, time
bench, root = (pathlib.Path(arg) for arg in sys.argv[3:5])
sys.path.insert(0, str(bench))
spec = importlib.util.spec_from_file_location("real_batch", bench / "batch.py")
real = importlib.util.module_from_spec(spec)
spec.loader.exec_module(real)
directory = root / "batches" / "b3"
(directory / "manifest.json").write_text(json.dumps(
    {"batch": "b3", "runs": [{"name": "b3-t-bare-1"}], "driverPid": os.getpid()}))
lock = directory / "lock"
lock.write_text(str(os.getpid()))
real.on_signal(directory, lock)
real.start_guard(directory, argparse.Namespace(batch="b3", spend_cap=5.0, spend_interval=0.1))
time.sleep(60)
"""


def call(cost, role="worker"):
    return json.dumps({"at": "2026-10-23T00:00:00", "role": role, "model": "m", "cost": cost, "isError": False})


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.directory = self.root / "batches" / "b3"
        self.directory.mkdir(parents=True)
        self.drivers = []

    def tearDown(self):
        for process in self.drivers:
            if process.poll() is None:
                process.kill()
            process.wait()
            for stream in (process.stdout, process.stderr):
                if stream:
                    stream.close()
        self.tmp.cleanup()

    def run_dir(self, name, *calls, where="claude-calls.jsonl"):
        path = self.root / "runs" / name
        (path / pathlib.Path(where).parent).mkdir(parents=True, exist_ok=True)
        (path / where).write_text("".join(line + "\n" for line in calls))
        return path

    def manifest(self, names, **extra):
        manifest = {"batch": "b3", "runs": [{"name": name} for name in names], **extra}
        (self.directory / "manifest.json").write_text(json.dumps(manifest))
        return manifest

    def driver(self, batch="b3", script_name="batch.py", source=DRIVER):
        """A fake driver: `<dir>/batch.py --batch <batch> <marker>`. Returns (process, marker path)."""
        script = self.root / script_name
        script.write_text(source)
        marker = self.root / f"marker-{len(self.drivers)}"
        process = subprocess.Popen([sys.executable, str(script), "--batch", batch, str(marker)])
        self.drivers.append(process)
        deadline = time.time() + 10
        while not pathlib.Path(f"{marker}.ready").exists() and time.time() < deadline:
            time.sleep(0.02)
        return process, marker


class Spend(Fixture):
    def test_sums_every_call_of_every_run_of_the_batch(self):
        self.run_dir("b3-t-bare-1", call(0.5), call(0.25, "critic"))
        self.run_dir("b3-t-visp-1", call(1.0))
        self.run_dir("other-t-bare-1", call(99))
        manifest = self.manifest(["b3-t-bare-1", "b3-t-visp-1"])
        total, per_run = spend_guard.batch_spend(manifest, self.root)
        self.assertAlmostEqual(total, 1.75)
        self.assertEqual(per_run, {"b3-t-bare-1": 0.75, "b3-t-visp-1": 1.0})

    def test_counts_nested_logs_judge_logs_and_runs_moved_to_discarded_but_not_the_project(self):
        self.run_dir("b3-t-bare-1", call(1.0))
        self.run_dir("b3-t-bare-1", call(2.0), where="fresh/claude-calls.jsonl")
        self.run_dir("b3-t-bare-1", call(4.0), where="claude-calls-judge.jsonl")
        self.run_dir("b3-t-bare-1", call(1000), where="project/claude-calls.jsonl")
        moved = self.root / "discarded" / "b3-t-bare-1-20261023-010101-unfinished"
        moved.mkdir(parents=True)
        (moved / "claude-calls.jsonl").write_text(call(8.0) + "\n")
        (self.root / "discarded" / "b3-t-bare-10-20261023-010101-unfinished").mkdir()
        (self.root / "discarded" / "b3-t-bare-10-20261023-010101-unfinished" / "claude-calls.jsonl").write_text(
            call(500) + "\n")
        total, _ = spend_guard.batch_spend(self.manifest(["b3-t-bare-1"]), self.root)
        self.assertAlmostEqual(total, 15.0)

    def test_bad_lines_and_a_run_that_has_not_started_cost_nothing(self):
        self.run_dir("b3-t-bare-1", "not json", json.dumps({"role": "worker"}), json.dumps({"cost": "1"}),
                     json.dumps({"cost": True}), "[1]", call(0.5), "")
        total, per_run = spend_guard.batch_spend(self.manifest(["b3-t-bare-1", "b3-t-bare-2"]), self.root)
        self.assertEqual((total, per_run), (0.5, {"b3-t-bare-1": 0.5}))

    def test_real_shim_records_are_read(self):
        record = {"at": "2026-10-21T03:45:17", "role": "worker", "model": "claude-haiku-5-5",
                  "cost": 0.01229162, "durationMs": 48908, "turns": 22, "isError": False,
                  "usage": {"input_tokens": 22}}
        self.run_dir("b3-t-bare-1", json.dumps(record))
        total, _ = spend_guard.batch_spend(self.manifest(["b3-t-bare-1"]), self.root)
        self.assertAlmostEqual(total, 0.01229162, places=5)


class Driver(Fixture):
    def test_found_by_the_pid_in_the_manifest(self):
        process, _ = self.driver()
        manifest = self.manifest([], driverPid=process.pid)
        self.assertEqual(spend_guard.driver_pid(manifest, self.directory, "b3"), process.pid)

    def test_found_by_the_lock_file_when_the_manifest_has_no_pid(self):
        process, _ = self.driver()
        (self.directory / "lock").write_text(str(process.pid))
        self.assertEqual(spend_guard.driver_pid(self.manifest([]), self.directory, "b3"), process.pid)

    def test_a_pid_that_is_another_batch_another_program_or_gone_is_not_the_driver(self):
        other, _ = self.driver(batch="other")
        elsewhere, _ = self.driver(script_name="runner.py")
        gone, _ = self.driver()
        gone.kill()
        gone.wait()
        for process in (other, elsewhere, gone):
            self.assertIsNone(spend_guard.driver_pid(self.manifest([], driverPid=process.pid), self.directory, "b3"))
        self.assertIsNone(spend_guard.driver_pid({"driverPid": "12"}, self.directory, "b3"))

    def test_batch_py_records_its_pid_and_the_spend_cap_in_the_manifest(self):
        source = (BENCH / "batch.py").read_text()
        self.assertIn('"driverPid": os.getpid()', source)
        self.assertIn("start_guard(directory, args)", source)
        # The fields it writes are the ones the guard reads.
        self.assertIn("manifest.get(\"driverPid\")", (BENCH / "spend_guard.py").read_text())


class Guard(Fixture):
    def test_over_the_cap_signals_the_driver_and_writes_the_record(self):
        process, marker = self.driver()
        self.run_dir("b3-t-bare-1", call(3.0))
        self.run_dir("b3-t-visp-1", call(2.5), call(0.75, "critic"))
        self.manifest(["b3-t-bare-1", "b3-t-visp-1"], driverPid=process.pid)
        state, record = spend_guard.check("b3", 6.0, self.root, waited=10)
        self.assertEqual(state, "over")
        self.assertEqual((record["signalled"], record["driverExited"], record["driverPid"]), (True, True, process.pid))
        self.assertAlmostEqual(record["total"], 6.25)
        self.assertEqual(marker.read_text(), "terminated")
        self.assertEqual(process.wait(5), 0)
        written = json.loads((self.directory / spend_guard.STOP_FILE).read_text())
        self.assertEqual((written["cap"], written["total"]), (6.0, 6.25))
        self.assertEqual(list(written["perRun"]), ["b3-t-visp-1", "b3-t-bare-1"])  # largest spend first

    def test_a_snapshot_rerun_driver_is_stopped_and_recorded_like_batch_py(self):
        process, marker = self.driver(script_name="snapshot_rerun.py")
        self.run_dir("b3-t-bare-1", call(7.0))
        self.manifest(["b3-t-bare-1"], driverPid=process.pid)
        state, record = spend_guard.check("b3", 6.0, self.root, waited=10)
        self.assertEqual(state, "over")
        self.assertEqual((record["signalled"], record["driverExited"], record["complete"]), (True, True, True))
        self.assertEqual(marker.read_text(), "terminated")
        written = json.loads((self.directory / spend_guard.STOP_FILE).read_text())
        self.assertEqual((written["driverPid"], written["complete"]), (process.pid, True))

    def test_under_the_cap_it_leaves_the_driver_alone(self):
        process, marker = self.driver()
        self.run_dir("b3-t-bare-1", call(3.0))
        self.manifest(["b3-t-bare-1"], driverPid=process.pid)
        self.assertEqual(spend_guard.check("b3", 6.0, self.root), ("running", 3.0))
        self.assertIsNone(process.poll())
        self.assertFalse(marker.exists())
        self.assertFalse((self.directory / spend_guard.STOP_FILE).exists())

    def test_exactly_the_cap_is_not_over(self):
        process, _ = self.driver()
        self.run_dir("b3-t-bare-1", call(6.0))
        self.manifest(["b3-t-bare-1"], driverPid=process.pid)
        self.assertEqual(spend_guard.check("b3", 6.0, self.root)[0], "running")

    def test_over_the_cap_with_no_live_driver_records_it_and_signals_nobody(self):
        process, marker = self.driver(batch="other")
        self.run_dir("b3-t-bare-1", call(9.0))
        self.manifest(["b3-t-bare-1"], driverPid=process.pid)
        state, record = spend_guard.check("b3", 6.0, self.root)
        self.assertEqual((state, record["signalled"], record["driverPid"]), ("over", False, None))
        self.assertIsNone(process.poll())
        self.assertFalse(marker.exists())

    def test_a_finished_driver_ends_the_watch(self):
        self.run_dir("b3-t-bare-1", call(1.0))
        self.manifest(["b3-t-bare-1"], driverPid=999999)
        self.assertEqual(spend_guard.check("b3", 6.0, self.root), ("done", 1.0))

    def test_the_command_line_stops_a_driver_and_exits_2(self):
        process, marker = self.driver()
        self.run_dir("b3-t-bare-1", call(7.0))
        self.manifest(["b3-t-bare-1"], driverPid=process.pid)
        done = subprocess.run([sys.executable, str(BENCH / "spend_guard.py"), "b3", "--cap", "5", "--interval", "0.1"],
                              env={**os.environ, "VISP_BENCH_RUNS": str(self.root)}, capture_output=True, text=True,
                              timeout=60)
        self.assertEqual(done.returncode, 2, done.stderr)
        self.assertIn("over the $5.00 cap", done.stdout)
        self.assertEqual(marker.read_text(), "terminated")
        self.assertTrue((self.directory / spend_guard.STOP_FILE).is_file())

    def test_the_command_line_polls_until_the_cap_is_crossed(self):
        process, marker = self.driver()
        log = self.run_dir("b3-t-bare-1", call(1.0))
        self.manifest(["b3-t-bare-1"], driverPid=process.pid)
        guard = subprocess.Popen([sys.executable, str(BENCH / "spend_guard.py"), "b3", "--cap", "5", "--interval", "0.1"],
                                 env={**os.environ, "VISP_BENCH_RUNS": str(self.root)},
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.drivers.append(guard)
        time.sleep(0.5)
        self.assertIsNone(guard.poll())
        self.assertIsNone(process.poll())
        with open(log / "claude-calls.jsonl", "a") as handle:
            handle.write(call(5.0) + "\n")
        self.assertEqual(guard.wait(30), 2)
        self.assertEqual(marker.read_text(), "terminated")


class Stop(Fixture):
    """What the guard leaves behind when it stops a driver: the record, the log line, the exit result."""

    def over_the_cap(self, **extra):
        process, marker = self.driver(**extra)
        self.run_dir("b3-t-bare-1", call(7.0))
        self.manifest(["b3-t-bare-1"], driverPid=process.pid)
        return process, marker

    def read_record(self, deadline=10):
        """The stop record once it says it is complete, else whatever is there (None if nothing)."""
        record, end = None, time.time() + deadline
        while time.time() < end:
            try:
                record = json.loads((self.directory / spend_guard.STOP_FILE).read_text())
            except (OSError, ValueError):
                record = None
            if record and record.get("complete"):
                break
            time.sleep(0.05)
        return record

    def launch(self, source, *extra):
        """Start a driver script that starts the guard itself; returns (process, marker, guard log path)."""
        script = self.root / "driver" / "batch.py"
        script.parent.mkdir(exist_ok=True)
        script.write_text(source)
        self.run_dir("b3-t-bare-1", call(7.0))
        marker, log = self.root / "marker", self.root / "guard.log"
        with open(log, "w") as out:
            process = subprocess.Popen([sys.executable, str(script), "--batch", "b3", str(BENCH), str(self.root),
                                        str(marker), *extra], stdout=out, stderr=subprocess.STDOUT,
                                       env={**os.environ, "VISP_BENCH_RUNS": str(self.root)})
        self.drivers.append(process)
        process.wait(30)  # it leaves on the guard's SIGTERM
        return process, marker, log

    def test_the_record_and_the_announcement_come_before_the_signal(self):
        process, marker = self.over_the_cap()
        seen = []

        def announce(record):
            seen.append((marker.exists(), record["signalled"], json.loads((self.directory / spend_guard.STOP_FILE).read_text())))

        state, record = spend_guard.check("b3", 6.0, self.root, waited=10, announce=announce)
        self.assertEqual(state, "over")
        self.assertEqual(len(seen), 1)
        signalled_yet, said_so, on_disk = seen[0]
        self.assertFalse(signalled_yet)
        self.assertFalse(said_so)
        self.assertEqual((on_disk["driverPid"], on_disk["total"], on_disk["signalled"], on_disk["complete"]),
                         (process.pid, 7.0, False, False))
        self.assertEqual(marker.read_text(), "terminated")
        finished = json.loads((self.directory / spend_guard.STOP_FILE).read_text())
        self.assertEqual((finished["signalled"], finished["driverExited"], finished["complete"]), (True, True, True))
        self.assertEqual(record, finished)

    def test_a_failing_announcement_does_not_keep_the_driver_running(self):
        process, marker = self.over_the_cap()

        def announce(record):
            raise BrokenPipeError("the log's reader is gone")

        state, record = spend_guard.check("b3", 6.0, self.root, waited=10, announce=announce)
        self.assertEqual((state, record["signalled"], record["driverExited"]), ("over", True, True))
        self.assertEqual(marker.read_text(), "terminated")

    def test_a_driver_that_stays_leaves_a_complete_record_saying_so(self):
        process, _ = self.over_the_cap(source=STUBBORN_DRIVER)
        state, record = spend_guard.check("b3", 6.0, self.root, waited=0.5)
        self.assertEqual((state, record["signalled"], record["driverExited"], record["complete"]),
                         ("over", True, False, True))
        self.assertEqual(json.loads((self.directory / spend_guard.STOP_FILE).read_text()), record)
        self.assertIsNone(process.poll())

    def test_no_live_driver_still_leaves_a_complete_record(self):
        process, _ = self.driver(batch="other")
        self.run_dir("b3-t-bare-1", call(9.0))
        self.manifest(["b3-t-bare-1"], driverPid=process.pid)
        seen = []
        state, record = spend_guard.check("b3", 6.0, self.root, announce=seen.append)
        self.assertEqual((state, record["signalled"], record["complete"]), ("over", False, True))
        self.assertIn("nothing was signalled", seen[0]["note"])
        self.assertEqual(json.loads((self.directory / spend_guard.STOP_FILE).read_text()), record)

    def test_sigterm_is_ignored_only_while_stopping(self):
        process, _ = self.over_the_cap()
        before = signal.getsignal(signal.SIGTERM)
        during = []
        spend_guard.check("b3", 6.0, self.root, waited=10, announce=lambda record: during.append(signal.getsignal(signal.SIGTERM)))
        self.assertEqual(during, [signal.SIG_IGN])
        self.assertEqual(signal.getsignal(signal.SIGTERM), before)

    def test_a_driver_that_stops_its_guard_on_sigterm_still_gets_the_record_and_the_log_line(self):
        # The case of the spend-guard stop of batch b2: batch.py's handler terminated the guard
        # while it waited for the driver to leave, so neither the record nor the line appeared.
        process, marker, log = self.launch(GUARDING_DRIVER)
        record = self.read_record()
        self.assertIsNotNone(record, "no stop record was written")
        self.assertEqual((record["driverPid"], record["total"], record["signalled"], record["driverExited"],
                          record["complete"]), (process.pid, 7.0, True, True, True))
        self.assertEqual(marker.read_text(), "record-present")
        text = log.read_text()
        self.assertIn(f"$7.00 is over the $5.00 cap; stopping driver {process.pid}", text)
        self.assertIn(f"driver {process.pid} exited", text)

    def test_batch_pys_own_handler_leaves_the_record_and_the_log_line(self):
        process, _, log = self.launch(BATCH_PY_DRIVER)
        record = self.read_record()
        self.assertIsNotNone(record, "no stop record was written")
        self.assertEqual((record["driverPid"], record["signalled"], record["driverExited"], record["complete"]),
                         (process.pid, True, True, True))
        self.assertIn("is over the $5.00 cap; stopping driver", log.read_text())
        self.assertFalse((self.directory / "lock").exists())  # the handler ran to its end


class Hook(unittest.TestCase):
    """batch.py's --spend-cap, without starting a run."""

    def test_the_dry_run_names_the_guard(self):
        done = subprocess.run([sys.executable, str(BENCH / "batch.py"), "--batch", "b3-dry", "--tasks",
                               "archive-carryover", "--arms", "bare", "--reps", "1", "--dry-run", "--spend-cap", "20"],
                              capture_output=True, text=True, timeout=60,
                              env={**os.environ, "VISP_BENCH_RUNS": tempfile.mkdtemp()})
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("spend guard: stops the batch above $20.00, looking every 60 s", done.stdout)

    def test_the_driver_signal_handler_is_the_one_the_guard_relies_on(self):
        source = (BENCH / "batch.py").read_text()
        self.assertIn("for number in (signal.SIGTERM, signal.SIGHUP):", source)
        self.assertEqual(signal.SIGTERM.value, 15)


if __name__ == "__main__":
    unittest.main()
