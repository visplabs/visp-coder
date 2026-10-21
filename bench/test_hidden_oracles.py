"""Qualify spreadsheet, recurrence and chain acceptance oracles against correct and faulty programs.

Run from the repository root: python3 -m unittest bench/test_hidden_oracles.py
The checks use local reference copies and the standard library; no models are called.
"""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


BENCH = Path(__file__).resolve().parent
sys.path.insert(0, str(BENCH))
from chains import summarize  # noqa: E402

TASKS = (("spreadsheet-cli", "spreadsheet", 38),
         ("spreadsheet-extend", "spreadsheet-extend", 63),
         ("sheet-carryover", "sheet-carryover", 44),
         ("spreadsheet-audit", "spreadsheet-audit", 48),
         ("sheet-chain", "sheet-chain/step5", 67))


class SpreadsheetOracleTests(unittest.TestCase):
    def score(self, task, project):
        completed = subprocess.run(
            [sys.executable, str(BENCH / "tasks" / task / "hidden_test.py"), str(project)],
            capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def copy_reference(self, reference, destination):
        shutil.copytree(BENCH / "reference" / reference, destination,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))

    def test_correct_references_pass_every_acceptance_case(self):
        for task, reference, total in TASKS:
            with self.subTest(task=task), tempfile.TemporaryDirectory() as directory:
                project = Path(directory) / "project"
                self.copy_reference(reference, project)
                score = self.score(task, project)
                self.assertEqual((score["passed"], score["total"]), (total, total))

    def test_matching_output_with_nonzero_exit_fails_acceptance(self):
        for task, reference, total in TASKS:
            with self.subTest(task=task), tempfile.TemporaryDirectory() as directory:
                project = Path(directory) / "project"
                self.copy_reference(reference, project)
                launcher = project / "run.sh"
                launcher.rename(project / "run-original.sh")
                launcher.write_text('#!/bin/sh\n"$(dirname "$0")/run-original.sh"\nexit 42\n')
                launcher.chmod(0o755)
                score = self.score(task, project)
                self.assertEqual((score["passed"], score["total"]), (0, total))
                for result in score["results"]:
                    self.assertIn("42", str(result["detail"]))

    def test_incorrect_division_errors_fail_without_rejecting_all_cases(self):
        for task, reference, total in TASKS:
            with self.subTest(task=task), tempfile.TemporaryDirectory() as directory:
                project = Path(directory) / "project"
                self.copy_reference(reference, project)
                changed = False
                for path in project.rglob("*.py"):
                    original = path.read_text()
                    if "#DIV/0!" in original:
                        path.write_text(original.replace("#DIV/0!", "#BROKEN!"))
                        changed = True
                self.assertTrue(changed)
                score = self.score(task, project)
                self.assertEqual(score["total"], total)
                self.assertGreater(score["passed"], 0)
                self.assertLess(score["passed"], total)

    def test_audit_start_fails_only_the_checks_of_its_deviations(self):
        score = self.score("spreadsheet-audit", BENCH / "tasks" / "spreadsheet-audit" / "start")
        failed = [result["name"] for result in score["results"] if not result["passed"]]
        self.assertEqual(score["passed"], 12)
        self.assertTrue(all(name.startswith("fix: ") for name in failed), failed)


class RecurrenceOracleTests(unittest.TestCase):
    TOTAL = 46

    def score(self, project):
        completed = subprocess.run(
            [sys.executable, str(BENCH / "tasks" / "recurrence-cli" / "hidden_test.py"), str(project)],
            capture_output=True, text=True, timeout=300,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def copy_reference(self, destination):
        shutil.copytree(BENCH / "reference" / "recurrence-cli", destination,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))

    def test_correct_reference_passes_every_acceptance_case(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory) / "project"
            self.copy_reference(project)
            score = self.score(project)
            self.assertEqual((score["passed"], score["total"]), (self.TOTAL, self.TOTAL))

    def test_third_party_date_library_fails_every_case(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory) / "project"
            self.copy_reference(project)
            (project / "tests" / "test_oracle.py").write_text("from dateutil import rrule\n")
            score = self.score(project)
            self.assertEqual((score["passed"], score["total"]), (0, self.TOTAL))

    def test_clamped_short_months_fail_without_rejecting_all_cases(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory) / "project"
            self.copy_reference(project)
            expand = project / "recurrence" / "expand.py"
            original = expand.read_text()
            clamped = original.replace("if day.day not in rule.bymonthday",
                                       "if min(day.day, 28) not in {min(v, 28) for v in rule.bymonthday}")
            self.assertNotEqual(clamped, original)
            expand.write_text(clamped)
            score = self.score(project)
            self.assertEqual(score["total"], self.TOTAL)
            self.assertGreater(score["passed"], 0)
            self.assertLess(score["passed"], self.TOTAL)


def replace(path, old, new):
    text = path.read_text()
    if old not in text:
        raise AssertionError(f"variant source changed: {old!r} not in {path}")
    path.write_text(text.replace(old, new))


class ChainOracleTests(unittest.TestCase):
    """Each step's reference passes every check up to its step; variants that break an earlier
    step's behaviour fail that step's checks, which the chain runner counts as regressions."""

    # Checks in total after each step, the starting contract being step 0.
    TOTALS = {"sheet-chain": (13, 22, 36, 48, 62, 67), "reservations-chain": (39, 48, 65, 75, 84, 94)}

    def score(self, task, project, step):
        completed = subprocess.run(
            [sys.executable, str(BENCH / "tasks" / task / "hidden_test.py"), str(project), "--step", str(step)],
            capture_output=True, text=True, timeout=600,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def project(self, directory, task, step):
        source = BENCH / "tasks" / task / "start" if step == 0 else BENCH / "reference" / task / f"step{step}"
        project = Path(directory) / "project"
        shutil.copytree(source, project, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        return project

    def failed(self, score):
        return {result["name"] for result in score["results"] if not result["passed"]}

    def test_each_step_reference_passes_every_check_up_to_its_step(self):
        for task, totals in self.TOTALS.items():
            for step, total in enumerate(totals):
                with self.subTest(task=task, step=step), tempfile.TemporaryDirectory() as directory:
                    score = self.score(task, self.project(directory, task, step), step)
                    self.assertEqual((score["passed"], score["total"]), (total, total), self.failed(score))
                    self.assertEqual({result["step"] for result in score["results"]}, set(range(step + 1)))

    def test_each_step_needs_its_own_change(self):
        for task in self.TOTALS:
            for step in range(1, 6):
                with self.subTest(task=task, step=step), tempfile.TemporaryDirectory() as directory:
                    score = self.score(task, self.project(directory, task, step - 1), step)
                    failed = {r["name"] for r in score["results"] if not r["passed"]}
                    self.assertTrue(failed)
                    self.assertTrue(all(r["step"] == step for r in score["results"] if not r["passed"]), failed)

    def test_sheet_variants_fail_earlier_steps_checks(self):
        variants = {
            # Step 3 also compares text: step 2 made comparing text #VALUE!.
            "text comparisons": (3, "sheet/engine.py", "    def compare(self, node):\n",
                                 "    def compare(self, node):\n"
                                 "        texts = [self.evaluate(side) for side in (node[2], node[3])]\n"
                                 "        if all(isinstance(value, Text) for value in texts):\n"
                                 "            return Bool(texts[0] == texts[1] if node[1] == '=' else texts[0] < texts[1])\n"),
            # Step 5's value cache survives a row move.
            "stale values after a row move": (5, "sheet/engine.py", "    def move_rows(self, move, deleted_row=None):\n"
                                              "        self.current = None\n", "    def move_rows(self, move, deleted_row=None):\n"),
            # Step 5 keeps the first cycles it found.
            "stale cycles": (5, "sheet/engine.py", "        self.cycles = sheet.cycle_members()\n",
                             "        if not hasattr(sheet, 'known_cycles'):\n"
                             "            sheet.known_cycles = sheet.cycle_members()\n"
                             "        self.cycles = sheet.known_cycles\n"),
        }
        expected = {"text comparisons": ({"s2: comparing text"}, True),
                    "stale values after a row move": ({"s4: delete at range edges shrinks it"}, True),
                    "stale cycles": ({"base: cycles and recovery"}, False)}
        for name, (step, path, old, new) in variants.items():
            with self.subTest(variant=name), tempfile.TemporaryDirectory() as directory:
                project = self.project(directory, "sheet-chain", step)
                replace(project / path, old, new)
                failed = self.failed(self.score("sheet-chain", project, step))
                must_fail, own_step_passes = expected[name]
                self.assertTrue(must_fail <= failed, failed)
                if own_step_passes:
                    self.assertFalse({n for n in failed if n.startswith(f"s{step}: ")}, failed)

    def test_reservation_variants_fail_earlier_steps_checks(self):
        variants = {
            # Step 2 answers a single-SKU reservation in the bundle shape.
            "single answered as a bundle": (2, "inventory/store.py", "            if bundle:\n", "            if True:\n",
                                            "base: reserve shape and expiry"),
            # Step 5 without the store lock, and a pause between the stock check and the hold.
            "no lock": (5, "inventory/store.py", "        self.lock = threading.Lock()\n",
                        "        self.lock = contextlib.nullcontext()\n", "base: concurrent reservations never oversell"),
        }
        for name, (step, path, old, new, must_fail) in variants.items():
            with self.subTest(variant=name), tempfile.TemporaryDirectory() as directory:
                project = self.project(directory, "reservations-chain", step)
                replace(project / path, old, new)
                if name == "no lock":
                    replace(project / path, "import json\n", "import contextlib\nimport json\nimport time\n")
                    replace(project / path, "            reservation_id = uuid.uuid4().hex\n",
                            "            time.sleep(0.05)\n            reservation_id = uuid.uuid4().hex\n")
                failed = self.failed(self.score("reservations-chain", project, step))
                self.assertIn(must_fail, failed)
                if name == "single answered as a bundle":
                    self.assertFalse({n for n in failed if n.startswith("s2: ")}, failed)

    def test_summary_counts_checks_that_passed_before_and_fail_after(self):
        def evaluation(*outcomes):
            return {"results": [{"name": name, "step": step, "passed": passed} for name, step, passed in outcomes]}

        baseline = evaluation(("base: a", 0, True), ("base: b", 0, False))
        steps = [(1, evaluation(("base: a", 0, False), ("base: b", 0, True), ("s1: c", 1, True))),
                 (2, evaluation(("base: a", 0, True), ("base: b", 0, False), ("s1: c", 1, False), ("s2: d", 2, False))),
                 (3, {"results": []})]
        summary = summarize(baseline, steps)
        self.assertEqual([step["regressions"] for step in summary["steps"]],
                         [["base: a"], ["base: b", "s1: c"], ["base: a"]])
        self.assertEqual([step["carried"] for step in summary["steps"]], [1, 2, 1])
        self.assertEqual((summary["carriedChecks"], summary["brokenChecks"], summary["kept"]),
                         (3, ["base: a", "base: b", "s1: c"], 0.0))
        self.assertEqual((summary["regressionEvents"], summary["carriedEvaluations"]), (4, 4))
        self.assertTrue(summary["steps"][2]["noResult"])


if __name__ == "__main__":
    unittest.main()
