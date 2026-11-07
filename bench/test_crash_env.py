"""VISP crash reporting in bench runs: every run logs VISP's crashes to crashes.jsonl, and with
VISP_BENCH_SENTRY_DSN set they also reach Sentry's bench environment, tagged with the run.

Run from the repository root: python3 -m unittest bench/test_crash_env.py
"""
import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

BENCH = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(BENCH))
import common  # noqa: E402
import runfacts  # noqa: E402


class CrashEnv(unittest.TestCase):
    def test_every_run_logs_crashes_tagged_with_the_run_arm_and_model(self):
        run = pathlib.Path("/runs/b3-visp-1")
        with mock.patch.dict(os.environ, {}, clear=True):
            env = common.crash_env(run, {"arm": "visp:cand+lean"}, "claude-haiku-5-5")
        self.assertEqual(env, {
            "VISP_CRASH_LOG": "/runs/b3-visp-1/crashes.jsonl",
            "VISP_SENTRY_TAGS": "bench_run=b3-visp-1,arm=visp:cand_lean,model=claude-haiku-5-5",
        })

    def test_a_bench_dsn_sends_them_to_sentrys_bench_environment(self):
        with mock.patch.dict(os.environ, {"VISP_BENCH_SENTRY_DSN": "https://k@o1.ingest.sentry.io/2"}):
            env = common.crash_env(pathlib.Path("/runs/r1"), {"arm": "bare"}, "m")
        self.assertEqual(env["VISP_SENTRY_DSN"], "https://k@o1.ingest.sentry.io/2")
        self.assertEqual(env["VISP_SENTRY_ENVIRONMENT"], "bench")


class CrashFacts(unittest.TestCase):
    def test_a_run_counts_its_crashes_by_command(self):
        with tempfile.TemporaryDirectory() as directory:
            run = pathlib.Path(directory)
            self.assertEqual(runfacts.visp_crashes(run), {})
            lines = [{"command": "guard"}, {"command": "guard"}, {"message": "no command"}]
            (run / "crashes.jsonl").write_text("".join(json.dumps(line) + "\n" for line in lines) + "torn")
            self.assertEqual(runfacts.visp_crashes(run), {"guard": 2, "other": 2})


if __name__ == "__main__":
    unittest.main()
