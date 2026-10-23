"""The Claude Code version of a run: recorded in arm.json and each result, and a report warns when arms differ.

Run from the repository root: python3 -m unittest bench/test_versions.py
No model is called; runs are fake directories.
"""
from pathlib import Path
import json
import sys
import tempfile
import unittest
from unittest import mock

BENCH = Path(__file__).resolve().parent
sys.path.insert(0, str(BENCH))
import common  # noqa: E402
import report  # noqa: E402


class Detected(unittest.TestCase):
    def test_the_first_word_of_claude_version(self):
        common.claude_version.cache_clear()
        done = mock.Mock(stdout="2.1.300 (Claude Code)\n")
        with mock.patch.object(common.subprocess, "run", return_value=done):
            self.assertEqual(common.claude_version(), "2.1.300")
        common.claude_version.cache_clear()
        with mock.patch.object(common.subprocess, "run", side_effect=OSError):
            self.assertIsNone(common.claude_version())
        common.claude_version.cache_clear()


class Warnings(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.runs = []
        patch = mock.patch.object(report, "RUNS", self.root)
        patch.start()
        self.addCleanup(patch.stop)

    def tearDown(self):
        self.tmp.cleanup()

    def add(self, label, arm_version=None, result_version=None, restored=False):
        name = f"b-t-{label}-{len(self.runs)}"
        run = self.root / "runs" / name
        (run / "session1").mkdir(parents=True)
        (run / "fresh").mkdir()
        (run / "arm.json").write_text(json.dumps({"claudeVersion": arm_version} if arm_version else {}))
        # A restored first session carries the source's version, which is not this run's.
        first = {"restoredFrom": "x", "claudeVersion": "0.0.1"} if restored else (
            {"claudeVersion": result_version} if result_version else {})
        (run / "session1" / "result.json").write_text(json.dumps(first))
        (run / "fresh" / "result.json").write_text(json.dumps({"claudeVersion": result_version} if result_version else {}))
        self.runs.append({"name": name, "label": label})

    def warnings(self):
        return report.version_warnings({"runs": self.runs})

    def test_one_version_everywhere_is_quiet(self):
        self.add("bare", "2.1.300", "2.1.300")
        self.add("bare-compact100k", "2.1.300", "2.1.300")
        self.assertEqual(self.warnings(), [])

    def test_arms_on_different_versions_warn_and_name_them(self):
        self.add("bare", "2.1.300", "2.1.300")
        self.add("bare-compact100k", "2.1.301", "2.1.301")
        (warning,) = self.warnings()
        self.assertIn("bare: 2.1.300", warning)
        self.assertIn("bare-compact100k: 2.1.301", warning)

    def test_the_version_that_ran_beats_the_one_recorded_at_set_up(self):
        self.add("bare", "2.1.300", "2.1.301")
        self.add("other", "2.1.301", "2.1.301")
        self.assertEqual(self.warnings(), [])

    def test_a_run_without_a_version_counts_as_unrecorded(self):
        self.add("bare")
        self.add("other", "2.1.300", "2.1.300")
        (warning,) = self.warnings()
        self.assertIn("bare: unrecorded", warning)

    def test_the_restored_first_session_of_a_rerun_is_not_counted(self):
        self.add("a", "2.1.300", "2.1.300", restored=True)
        self.add("b", "2.1.300", "2.1.300", restored=True)
        self.assertEqual(self.warnings(), [])


if __name__ == "__main__":
    unittest.main()
