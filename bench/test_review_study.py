"""Unit tests for the review study's case building, prompts and statistics.

Run from the repository root: python3 -m unittest bench/test_review_study.py
No models are called and no benchmark runs are read.
"""
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import review_study as study  # noqa: E402

RECORD = """# Extend the API

Status: accepted. Every required outcome is satisfied.

## Changes

- **T001** Deliver it (closed; may edit inventory/store.py)

Uncommitted changes:

- modified: inventory/store.py
- modified: tests/test_api.py

## Checks

| Check | Command | Latest result |
| --- | --- | --- |
| C001 | `python3 -m unittest discover -s tests` | passed (exit 0, 2026-10-14T17:41:48.041Z) |
| C002 | `python3 -m unittest discover -s tests -k test_bundle` | passed (exit 0, 2026-10-14T17:41:49.000Z) |

## Next
"""


class RecordTests(unittest.TestCase):
    def test_check_rows_read_the_checks_table(self):
        rows = study.check_rows(RECORD)
        self.assertEqual([r["id"] for r in rows], ["C001", "C002"])
        self.assertEqual(rows[1]["command"], "python3 -m unittest discover -s tests -k test_bundle")

    def test_unchanged_tree_keeps_the_record(self):
        files = ["- modified: inventory/store.py", "- modified: tests/test_api.py"]
        self.assertEqual(study.corrected_record(RECORD, {"C001": 0, "C002": 0}, files), RECORD)

    def test_failed_check_and_new_file_are_shown(self):
        files = ["- modified: inventory/store.py", "- modified: server.py", "- modified: tests/test_api.py"]
        text = study.corrected_record(RECORD, {"C001": 0, "C002": 1}, files)
        self.assertIn("Status: open. Check C002 failed on the latest run.", text)
        self.assertIn("| C002 | `python3 -m unittest discover -s tests -k test_bundle` | "
                      "failed (exit 1, 2026-10-14T17:41:49.000Z) |", text)
        self.assertIn("| C001 | `python3 -m unittest discover -s tests` | passed", text)
        self.assertIn("- modified: server.py\n- modified: tests/test_api.py\n\n## Checks", text)
        self.assertEqual(text.count("- modified:"), 3)


class TreeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.project = pathlib.Path(self.directory.name)
        (self.project / "app.py").write_text("LIMIT = 3600\n")
        (self.project / "start.sh").write_text("run\n")
        for args in (["init", "-q"], ["add", "-A"],
                     ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "start"]):
            subprocess.run(["git", *args], cwd=self.project, check=True)

    def tearDown(self):
        self.directory.cleanup()

    def test_edit_must_match_once(self):
        with self.assertRaises(ValueError):
            study.apply_edits(self.project, [{"file": "app.py", "old": "missing", "new": "x"}])
        study.apply_edits(self.project, [{"file": "app.py", "old": "3600", "new": "36000"}])
        self.assertEqual((self.project / "app.py").read_text(), "LIMIT = 36000\n")

    def test_diff_and_changes_leave_workflow_files_out(self):
        study.apply_edits(self.project, [{"file": "app.py", "old": "3600", "new": "60"},
                                         {"file": "new_test.py", "new": "ok\n"},
                                         {"file": "CLAUDE.md", "new": "instructions\n"}])
        (self.project / ".visp").mkdir()
        (self.project / ".visp" / "state.json").write_text("{}")
        self.assertEqual(study.changed_files(self.project),
                         ["- modified: app.py", "- untracked: new_test.py"])
        diff = study.product_diff(self.project)
        self.assertIn("+LIMIT = 60", diff)
        self.assertIn("new_test.py", diff)
        self.assertNotIn("CLAUDE.md", diff)
        self.assertNotIn(".visp", diff)


class PromptTests(unittest.TestCase):
    def test_only_condition_b_shows_the_record(self):
        with tempfile.TemporaryDirectory() as directory:
            case = pathlib.Path(directory)
            (case / "request.md").write_text("Add bundles.\n")
            (case / "diff.patch").write_text("+code\n")
            (case / "record.md").write_text("RECORD-MARKER\n")
            (case / "record-C.md").write_text("NEW-RECORD\n")
            a, b = study.review_prompt(case, "A"), study.review_prompt(case, "B")
            c = study.review_prompt(case, "C")
        self.assertIn("NEW-RECORD", c)
        self.assertNotIn("RECORD-MARKER", c)
        self.assertNotIn("RECORD-MARKER", a)
        self.assertNotIn("evidence", a.lower())
        self.assertIn("RECORD-MARKER", b)
        for prompt in (a, b):
            self.assertIn("Add bundles.", prompt)
            self.assertIn("+code", prompt)
            self.assertNotIn("condition", prompt.lower())


class StatisticsTests(unittest.TestCase):
    CASES = {"s1": {"id": "s1", "edits": [{}], "kind": "edge-case"},
             "s2": {"id": "s2", "edits": [{}], "kind": "edge-case"},
             "c1": {"id": "c1"}}

    def review(self, case, condition, rep, decision, cost=0.1):
        return {"case": case, "condition": condition, "model": "m", "effort": "e", "rep": rep,
                "seconds": 10, "cost": cost, "verdict": {"decision": decision, "defects": []}}

    def test_mean_and_standard_error(self):
        self.assertEqual(study.mean_se([]), (None, None))
        self.assertEqual(study.mean_se([0.5]), (0.5, None))
        mean, se = study.mean_se([0.0, 1.0])
        self.assertEqual(mean, 0.5)
        self.assertAlmostEqual(se, 0.5)

    def test_found_needs_a_reject_and_a_matching_grade(self):
        reviews = [self.review("s1", "A", 0, "reject"), self.review("s1", "A", 1, "reject"),
                   self.review("s1", "B", 0, "accept"), self.review("c1", "A", 0, "reject"),
                   {**self.review("s2", "A", 0, "reject"), "error": "limit"}]
        grades = [{"case": "s1", "condition": "A", "model": "m", "effort": "e", "rep": 0, "found": True},
                  {"case": "s1", "condition": "A", "model": "m", "effort": "e", "rep": 1, "found": False}]
        rows = study.outcomes(reviews, grades, self.CASES, visible={"s1"})
        self.assertEqual(len(rows), 4)
        self.assertEqual([r["caught"] for r in rows], [True, False, False, None])
        self.assertTrue(rows[0]["visible"])
        summary = study.summary([r for r in rows if r["condition"] == "A"])
        self.assertEqual(summary["detection"], (0.5, None))
        self.assertEqual(summary["falseRejects"], (1.0, None))

    def test_paired_difference_is_per_case(self):
        rows = study.outcomes(
            [self.review("s1", "A", 0, "accept"), self.review("s1", "B", 0, "reject"),
             self.review("s2", "A", 0, "reject"), self.review("s2", "B", 0, "reject"),
             self.review("c1", "A", 0, "accept", cost=0.1), self.review("c1", "B", 0, "accept", cost=0.3)],
            [], self.CASES)
        self.assertEqual(study.paired(rows, "rejected", True), (0.5, 0.5))
        mean, _ = study.paired(rows, "cost")
        self.assertAlmostEqual(mean, 0.2 / 3)


class CasesFileTests(unittest.TestCase):
    def test_cases_are_well_formed(self):
        cases = json.loads(study.CASES.read_text())["cases"]
        ids = [case["id"] for case in cases]
        self.assertEqual(len(ids), len(set(ids)))
        for case in cases:
            with self.subTest(case=case["id"]):
                if case.get("edits"):
                    self.assertTrue(case.get("defect") and case.get("kind"))
                    for edit in case["edits"]:
                        self.assertIn("file", edit)
                        self.assertIn("new", edit)
                else:
                    self.assertNotIn("defect", case)


if __name__ == "__main__":
    unittest.main()
