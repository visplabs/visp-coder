"""The constraint paragraph of the benchmark prompts: unchanged for every arm but bare-automemory.

Run from the repository root: python3 -m unittest bench/test_prompts.py
No model is called. setup_arm.py runs for real in a temporary $VISP_BENCH_RUNS (git and the
standard library only).
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
import common  # noqa: E402
import prompts  # noqa: E402
import run_claude  # noqa: E402


def frozen(root):
    """The paragraph as it was before bare-automemory got its own (the text every other arm still gets)."""
    return (
        f"Your project directory is {root}. Run every shell command from that directory "
        f"(start each command with `cd {root} && `) and create or edit files only inside it. "
        "Do not read other directories. No dependency downloads or network APIs; the standard "
        "library is available. Do not ask questions: make reasonable assumptions and continue. "
        "Do not delegate to other agents. Build it, run your tests, and finish with a short report "
        "of what you actually verified."
    )


class CommonParagraph(unittest.TestCase):
    def test_every_arm_but_bare_automemory_gets_the_frozen_text(self):
        for arm in ("bare", "bare-rule-line", "speckit", "bmad", "visp:visp-head", "visp:cand+lean+nocritic", "visp-codex:cand"):
            with self.subTest(arm=arm):
                self.assertEqual(prompts.common("/runs/r1/project", arm), frozen("/runs/r1/project"))

    def test_bare_automemory_may_use_its_memory_directory_and_only_that(self):
        text = prompts.common("/runs/r1/project", "bare-automemory")
        memory = "/runs/r1/memory"
        self.assertIn(f"create or edit files only inside it and in Claude Code's own memory directory {memory}. ", text)
        self.assertIn(f"Do not read other directories except {memory}. ", text)
        # Everything else in the paragraph is the frozen text.
        self.assertEqual(text.replace(f" and in Claude Code's own memory directory {memory}", "")
                         .replace(f" except {memory}", ""), frozen("/runs/r1/project"))

    def test_the_path_is_the_one_run_claude_points_autoMemoryDirectory_at(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = pathlib.Path(tmp) / "runs" / "r1" / "project"
            project.mkdir(parents=True)
            self.assertEqual(prompts.memory_directory(project), run_claude.memory_directory(project))
            setting = run_claude.memory_settings({"memory": "auto"}, project)["autoMemoryDirectory"]
            self.assertIn(setting, prompts.common(project, "bare-automemory"))


class SetupArm(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = {**os.environ, "VISP_BENCH_RUNS": self.tmp.name}

    def tearDown(self):
        self.tmp.cleanup()

    def setup(self, arm, name):
        done = subprocess.run([sys.executable, str(BENCH / "setup_arm.py"), "spreadsheet-cli", arm, name],
                              env=self.env, capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        run = pathlib.Path(self.tmp.name) / "runs" / name
        return run, json.loads((run / "arm.json").read_text())

    def test_the_bare_prompt_is_byte_identical_to_the_frozen_one(self):
        run, arm = self.setup("bare", "p-bare")
        task = (BENCH / "tasks" / "spreadsheet-cli" / "task.md").read_text()
        expected = f"Use ordinary coding: write the code and tests directly.\n\n{frozen(run / 'project')}\n\nTask:\n\n{task}"
        self.assertEqual((run / "prompt.txt").read_text(), expected)
        self.assertNotIn("memoryPrompt", arm)
        self.assertEqual(arm["memory"], "off")

    def test_the_automemory_prompt_differs_only_in_the_memory_clauses(self):
        bare, _ = self.setup("bare", "p-bare")
        auto, arm = self.setup("bare-automemory", "p-auto")
        memory = str(auto / "memory")
        text = (auto / "prompt.txt").read_text()
        self.assertEqual(arm["memory"], "auto")
        self.assertEqual(arm["memoryPrompt"], memory)
        stripped = (text.replace(f" and in Claude Code's own memory directory {memory}", "")
                    .replace(f" except {memory}", "").replace(str(auto / "project"), "@"))
        self.assertEqual(stripped, (bare / "prompt.txt").read_text().replace(str(bare / "project"), "@"))

    def test_the_rule_line_arm_is_bare_plus_a_committed_claude_md(self):
        bare, _ = self.setup("bare", "p-bare")
        rule, arm = self.setup("bare-rule-line", "p-rule")
        self.assertEqual((rule / "prompt.txt").read_text().replace(str(rule / "project"), "@"),
                         (bare / "prompt.txt").read_text().replace(str(bare / "project"), "@"))
        self.assertEqual((rule / "project" / "CLAUDE.md").read_text(), prompts.RULE_LINE)
        self.assertFalse((bare / "project" / "CLAUDE.md").exists())
        tracked = subprocess.run(["git", "ls-files"], cwd=rule / "project", capture_output=True, text=True).stdout
        self.assertIn("CLAUDE.md", tracked.split())
        self.assertEqual((arm["arm"], arm["memory"]), ("bare-rule-line", "off"))

    def test_arm_json_records_the_claude_code_version(self):
        _, arm = self.setup("bare", "p-version")
        self.assertEqual(arm["claudeVersion"], common.claude_version())


if __name__ == "__main__":
    unittest.main()
