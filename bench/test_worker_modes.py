"""Worker environment modes (presets.WORKER_ENV_MODES): the `+compact100k` arm suffix.

Run from the repository root: python3 -m unittest bench/test_worker_modes.py
No model is called. setup_arm.py and batch.py --dry-run run for real in a temporary $VISP_BENCH_RUNS.
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

BENCH = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(BENCH))
import presets  # noqa: E402
import report  # noqa: E402
import run_claude  # noqa: E402

COMPACT = {"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "100000", "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "90"}


class Parsing(unittest.TestCase):
    def test_the_suffix_is_split_from_the_arm_and_from_vispmodes(self):
        self.assertEqual(presets.split_worker_modes("bare"), ("bare", []))
        self.assertEqual(presets.split_worker_modes("bare+compact100k"), ("bare", ["compact100k"]))
        self.assertEqual(presets.split_worker_modes("visp:cand+lean+compact100k"), ("visp:cand+lean", ["compact100k"]))
        self.assertEqual(presets.split_worker_modes("visp:cand+compact100k+lean"), ("visp:cand+lean", ["compact100k"]))
        with self.assertRaises(SystemExit):
            presets.split_worker_modes("bare+compact100k+compact100k")

    def test_the_variables_are_the_two_the_proposal_names(self):
        self.assertEqual(presets.worker_env(["compact100k"]), COMPACT)
        self.assertEqual(presets.worker_env([]), {})

    def test_vispbuild_and_titles_know_the_suffix(self):
        self.assertEqual(presets.visp_build("visp:develop+compact100k"), ("develop", None))
        self.assertEqual(presets.visp_build("visp:cand+lean+compact100k"), ("cand", "lean"))
        with self.assertRaises(SystemExit):
            presets.visp_build("visp:cand+nope+compact100k")
        self.assertEqual(presets.arm_title("bare+compact100k"), "bare+compact100k")
        self.assertEqual(presets.arm_title("visp:develop+compact100k"), "visp:develop+compact100k")
        self.assertEqual(presets.arm_title("visp:cand+lean+compact100k"), "visp:cand+lean+compact100k")
        self.assertEqual(presets.arm_title("visp:develop"), "visp:develop")

    def test_a_report_says_the_worker_modes_differ(self):
        self.assertEqual(report.pair_note("bare", "bare+compact100k"), "same arm; worker modes none -> compact100k")
        self.assertEqual(report.pair_note("visp:d", "visp:d+compact100k"),
                         "same build and same config keys; worker modes none -> compact100k")
        self.assertEqual(report.pair_note("visp:d+lean", "visp:d+nocritic+compact100k"),
                         "same build, config differs only in: critic.mode unset -> off, workflow.draftFirst visual -> "
                         "unset, workflow.requestGaps required -> unset, workflow.reviewCadence feature -> unset; "
                         "worker modes none -> compact100k")
        self.assertEqual(report.pair_note("visp:d+compact100k", "visp:d+compact100k"), "same build and same config keys")


class WorkerEnvironment(unittest.TestCase):
    def test_the_variables_reach_the_workers_environment_only_when_the_arm_has_them(self):
        with_modes = run_claude.worker_env({"arm": "bare", "workerEnv": COMPACT})
        self.assertEqual({key: with_modes.get(key) for key in COMPACT}, COMPACT)
        without = run_claude.worker_env({"arm": "bare"})
        inherited = {key: os.environ.get(key) for key in COMPACT}
        self.assertEqual({key: without.get(key) for key in COMPACT}, inherited)

    def test_the_auto_memory_arm_keeps_its_memory_setting(self):
        env = run_claude.worker_env({"arm": "bare-automemory", "memory": "auto", "workerEnv": COMPACT})
        self.assertNotIn("CLAUDE_CODE_DISABLE_AUTO_MEMORY", env)
        self.assertEqual(env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"], "100000")


class SetupAndBatch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = {**os.environ, "VISP_BENCH_RUNS": self.tmp.name}

    def tearDown(self):
        self.tmp.cleanup()

    def setup(self, arm, name):
        done = subprocess.run([sys.executable, str(BENCH / "setup_arm.py"), "spreadsheet-cli", arm, name],
                              env=self.env, capture_output=True, text=True)
        return done, pathlib.Path(self.tmp.name) / "runs" / name

    def test_setup_records_the_modes_and_changes_nothing_else(self):
        done, plain = self.setup("bare", "r-plain")
        self.assertEqual(done.returncode, 0, done.stderr)
        done, compact = self.setup("bare+compact100k", "r-compact")
        self.assertEqual(done.returncode, 0, done.stderr)
        arm = json.loads((compact / "arm.json").read_text())
        self.assertEqual((arm["arm"], arm["armSpec"], arm["workerModes"], arm["workerEnv"]),
                         ("bare", "bare+compact100k", ["compact100k"], COMPACT))
        self.assertNotIn("workerEnv", json.loads((plain / "arm.json").read_text()))
        self.assertEqual((compact / "prompt.txt").read_text().replace("r-compact", "r-plain"),
                         (plain / "prompt.txt").read_text())

    def test_a_codex_worker_does_not_take_the_suffix(self):
        done, _ = self.setup("visp-codex:x+compact100k", "r-codex")
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("Codex worker does not read them", done.stderr)

    def test_the_dry_run_shows_the_variables_and_labels_without_plus(self):
        done = subprocess.run([sys.executable, str(BENCH / "batch.py"), "--batch", "c1-dry", "--tasks",
                               "spreadsheet-extend", "--arms", "bare,bare+compact100k,visp:develop,visp:develop+compact100k",
                               "--reps", "1", "--preset", "quality-2026-10", "--dry-run"],
                              env=self.env, capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        lines = [line for line in done.stdout.splitlines() if line.startswith("run ")]
        self.assertEqual(len(lines), 4)
        names = {line.split()[1] for line in lines}
        self.assertEqual(names, {"c1-dry-spreadsheet-extend-bare-1", "c1-dry-spreadsheet-extend-bare-compact100k-1",
                                 "c1-dry-spreadsheet-extend-develop-1", "c1-dry-spreadsheet-extend-develop-compact100k-1"})
        compact = [line for line in lines if "compact100k" in line.split()[1]]
        self.assertEqual(len(compact), 2)
        for line in compact:
            self.assertIn("worker env CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000 CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=90", line)
        self.assertEqual(sum("worker env" in line for line in lines), 2)


if __name__ == "__main__":
    unittest.main()
