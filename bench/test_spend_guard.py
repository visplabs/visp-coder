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

    def driver(self, batch="b3", script_name="batch.py"):
        """A fake driver: `<dir>/batch.py --batch <batch> <marker>`. Returns (process, marker path)."""
        script = self.root / script_name
        script.write_text(DRIVER)
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
