"""Carryover runs: the intermediate session, and Claude Code's auto memory per arm.

Run from the repository root: python3 -m unittest bench/test_run_carryover.py
Standard library only; no model is called. The worker sessions are replaced by functions that
record what they were given, so the order of the sessions, the memory each one sees and the
settings handed to the CLI are checked offline.
"""
from pathlib import Path
import argparse
import json
import shutil
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

BENCH = Path(__file__).resolve().parent
sys.path.insert(0, str(BENCH))
import run_carryover  # noqa: E402
import run_claude  # noqa: E402
import runfacts  # noqa: E402


def arm(memory="off", name="bare"):
    return {"task": "archive-carryover-raised", "arm": name, "shim": None, "memory": memory}


class MemorySettings(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.project = Path(self.root.name) / "runs" / "r1" / "project"
        self.project.mkdir(parents=True)

    def tearDown(self):
        self.root.cleanup()

    def test_off_by_default_in_settings_and_environment(self):
        self.assertEqual(run_claude.memory_settings({"arm": "bare"}, self.project), {"autoMemoryEnabled": False})
        with mock.patch.dict("os.environ", {}, clear=False):
            self.assertEqual(run_claude.worker_env({"arm": "bare"})["CLAUDE_CODE_DISABLE_AUTO_MEMORY"], "1")

    def test_on_points_at_the_runs_own_directory_and_clears_the_disable_variable(self):
        settings = run_claude.memory_settings(arm("auto"), self.project)
        self.assertEqual(settings, {"autoMemoryEnabled": True,
                                    "autoMemoryDirectory": str(self.project.parent.resolve() / "memory")})
        with mock.patch.dict("os.environ", {"CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1"}):
            self.assertNotIn("CLAUDE_CODE_DISABLE_AUTO_MEMORY", run_claude.worker_env(arm("auto")))

    def test_session_passes_the_settings_and_records_them(self):
        calls = []

        def fake(argv, cwd, env, timeout, pid_file, stdin=None):
            calls.append((argv, env))
            (self.project.parent / "memory" / "MEMORY.md").write_text("- note\n")
            return 0, json.dumps({"session_id": "s1", "num_turns": 1, "result": "done"}), "", False

        for setting, enabled in (("off", False), ("auto", True)):
            calls.clear()
            with mock.patch.object(run_claude, "run_worker", fake), \
                    mock.patch.object(run_claude, "CLAUDE_PROJECTS", Path(self.root.name) / "claude"):
                (self.project.parent / "memory").mkdir(exist_ok=True)
                result = run_claude.run_session(self.project, arm(setting), "prompt", "m", 60)
            argv, env = calls[0]
            passed = json.loads(argv[argv.index("--settings") + 1])
            self.assertEqual(passed["autoMemoryEnabled"], enabled)
            self.assertEqual("CLAUDE_CODE_DISABLE_AUTO_MEMORY" in env, not enabled)
            record = result["autoMemory"]
            self.assertEqual((record["setting"], record["enabled"]), (setting, enabled))
            self.assertEqual(record["filesBefore"], [])
            self.assertEqual(record["filesAfter"], ["MEMORY.md"] if enabled else [])
            self.assertEqual(record["outsideFiles"], [])
            (self.project.parent / "memory" / "MEMORY.md").unlink(missing_ok=True)

    def test_a_stale_default_directory_stops_an_auto_memory_session(self):
        claude = Path(self.root.name) / "claude"
        stale = claude / runfacts.project_key(self.project.resolve()) / "memory"
        stale.mkdir(parents=True)
        (stale / "MEMORY.md").write_text("- from an earlier run\n")
        with mock.patch.object(run_claude, "CLAUDE_PROJECTS", claude), \
                mock.patch.object(run_claude, "run_worker") as worker:
            with self.assertRaises(SystemExit):
                run_claude.run_session(self.project, arm("auto"), "prompt", "m", 60)
            worker.assert_not_called()


class Intermediate(unittest.TestCase):
    """run_modes with replaced sessions."""

    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.run = Path(self.root.name) / "runs" / "r1"
        self.project = self.run / "project"
        self.first = self.run / "session1"
        self.first.mkdir(parents=True)
        self.project.mkdir()
        (self.project / "app.py").write_text("LIMIT = 10000\n")
        with tarfile.open(self.first / "snapshot.tar", "w") as archive:
            archive.add(self.project / "app.py", arcname="app.py")
        (self.run / "prompt2.txt").write_text("second")
        (self.run / "prompt-intermediate.txt").write_text("middle")
        self.seen = []

    def tearDown(self):
        self.root.cleanup()

    def run_modes(self, modes, memory="off", verify=None):
        memory_dir = self.run / "memory"
        if memory == "auto":
            memory_dir.mkdir()
            (memory_dir / "first.md").write_text("from session 1\n")
        run_carryover.snapshot_memory(self.project, self.first / "memory.tar")
        shutil.rmtree(memory_dir, ignore_errors=True)

        def session(project, arm_, prompt, model, timeout, resume, effort):
            held = sorted(path.name for path in memory_dir.glob("*")) if memory_dir.is_dir() else []
            self.seen.append((prompt, held))
            if memory_dir.is_dir():
                (memory_dir / f"{prompt}.md").write_text("learned\n")
            return {"arm": arm_["arm"], "seconds": 1, "timedOut": False, "isError": False,
                    "sessionId": None, "sessionIds": []}

        args = argparse.Namespace(run="r1", build=None, reuse=None, model=None, timeout=60, effort=None)
        with mock.patch.object(run_carryover, "run_session", session), \
                mock.patch.object(run_carryover, "verify_intermediate", verify or (lambda project, mode: None)), \
                mock.patch.object(runfacts, "CLAUDE_PROJECTS", Path(self.root.name) / "claude"):
            try:
                run_carryover.run_modes(args, self.run, self.project, arm(memory), self.first, {}, modes)
            except SystemExit as stop:
                return str(stop)

    def test_intermediate_mode_runs_a_session_before_the_second(self):
        self.run_modes(["intermediate"])
        self.assertEqual([prompt for prompt, _ in self.seen], ["middle", "second"])
        out = self.run / "intermediate"
        self.assertTrue((out / "intermediate.json").is_file() and (out / "result.json").is_file())
        self.assertEqual([label for label, _ in runfacts.sessions(self.run)],
                         ["intermediate intermediate", "intermediate"])
        self.assertEqual(runfacts.final_project(self.run), out / "project")
        self.assertTrue(runfacts.is_finished(self.run, two_sessions=True))
        self.assertIsNone(runfacts.invalid(self.run))

    def test_other_modes_run_one_session_and_the_scripted_edit_is_gone(self):
        self.run_modes(["fresh"])
        self.assertEqual([prompt for prompt, _ in self.seen], ["second"])
        self.assertFalse((self.run / "fresh" / "intermediate.json").exists())
        self.assertFalse(hasattr(run_carryover, "apply_intermediate"))
        self.assertFalse(hasattr(run_carryover, "raise_limit"))

    def test_failed_verification_makes_the_run_invalid_and_skips_the_second_session(self):
        def refuse(project, mode):
            raise run_carryover.IntermediateFailed(f"{mode}: limit still 10000")

        stopped = self.run_modes(["intermediate"], verify=refuse)
        self.assertIn("limit still 10000", stopped)
        self.assertEqual([prompt for prompt, _ in self.seen], ["middle"])
        self.assertFalse((self.run / "intermediate" / "result.json").exists())
        self.assertEqual(runfacts.invalid(self.run)["reason"], "intermediate feature not verified")
        self.assertTrue(runfacts.is_finished(self.run, two_sessions=True))
        self.assertTrue((self.run / "intermediate" / "project" / "app.py").is_file())

    def test_a_cli_error_in_the_intermediate_session_makes_the_run_invalid(self):
        def failing(project, arm_, prompt, model, timeout, resume, effort):
            self.seen.append(prompt)
            return {"arm": "bare", "seconds": 1, "timedOut": False, "isError": True, "report": "API Error: 500"}

        args = argparse.Namespace(run="r1", build=None, reuse=None, model=None, timeout=60, effort=None)
        with mock.patch.object(run_carryover, "run_session", failing), \
                mock.patch.object(runfacts, "CLAUDE_PROJECTS", Path(self.root.name) / "claude"):
            with self.assertRaises(SystemExit):
                run_carryover.run_modes(args, self.run, self.project, arm(), self.first, {}, ["intermediate"])
        self.assertEqual(self.seen, ["middle"])
        self.assertEqual(runfacts.invalid(self.run)["reason"], "worker failure")

    def test_every_mode_starts_from_session_ones_memory(self):
        self.run_modes(["intermediate", "fresh"], memory="auto")
        by_prompt = self.seen
        # The intermediate mode: session 1's note, then its own intermediate note for the second session.
        self.assertEqual(by_prompt[0], ("middle", ["first.md"]))
        self.assertEqual(by_prompt[1], ("second", ["first.md", "middle.md"]))
        # The next mode sees none of that.
        self.assertEqual(by_prompt[2], ("second", ["first.md"]))
        self.assertEqual(sorted(path.name for path in (self.run / "intermediate" / "memory").glob("*")),
                         ["first.md", "middle.md", "second.md"])
        self.assertEqual(sorted(path.name for path in (self.run / "fresh" / "memory").glob("*")),
                         ["first.md", "second.md"])
        self.assertFalse((self.run / "memory").exists())

    def test_off_arm_keeps_no_memory(self):
        self.run_modes(["intermediate"])
        self.assertFalse((self.run / "memory").exists())
        self.assertFalse((self.run / "intermediate" / "memory").exists())

    def test_planned_sessions_and_the_batch_mode(self):
        self.assertEqual(run_carryover.planned_sessions("intermediate"), ["intermediate request", "second request"])
        self.assertEqual(run_carryover.planned_sessions("fresh"), ["second request"])
        self.assertEqual(run_carryover.batch_mode("archive-carryover-raised"), "intermediate")
        self.assertEqual(run_carryover.batch_mode("sheet-carryover"), "fresh")


if __name__ == "__main__":
    unittest.main()
