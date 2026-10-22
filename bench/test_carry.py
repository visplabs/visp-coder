"""Unit tests for the carry outcome labels (carry.py) and the report.py --carry table.

Run from the repository root: python3 -m unittest bench/test_carry.py
No models are called. fixtures/carry holds the hidden.json of real co1 and co2 runs of
archive-carryover (the projects are not copied). Those runs are all archive-carryover; no
archive-carryover-raised run exists yet, so the -raised cases are built from the real
archive-carryover check names with the cap 50000 and the check the -raised task adds.
"""
import json
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

BENCH = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(BENCH))

import carry  # noqa: E402
import report  # noqa: E402

FIXTURES = BENCH / "fixtures" / "carry"
ARCHIVE = "archive-carryover"
RAISED = "archive-carryover-raised"


def real(name):
    return json.loads((FIXTURES / f"{name}.hidden.json").read_text())["results"]


def raised(base, cap_checks, old_limit):
    """A -raised result list from a real one: cap 50000 in the names, the cap checks set, the added check."""
    results = []
    for result in base:
        name = result["name"].replace("10000", "50000")
        passed = cap_checks.get(next((role for role, fragment in carry.ROLES.items() if fragment in name), None),
                                result["passed"])
        results.append({**result, "name": name, "passed": passed})
    results.append({"name": "memory:restock past the replaced 10000 limit succeeds", "passed": old_limit,
                    "detail": None})
    return results


ALL = {role: True for role in carry.ROLES}
NONE = {role: False for role in carry.ROLES}
PASSING = real("co1-archive-carryover-bare-1")


class RealRuns(unittest.TestCase):
    def test_runs_that_kept_the_cap_are_carried(self):
        for name in ("co1-archive-carryover-bare-1", "co1-archive-carryover-visp-dev-1",
                     "co2-archive-carryover-visp-handoff-1", "co2-archive-carryover-visp-handoff-2"):
            with self.subTest(name):
                found = carry.outcome(ARCHIVE, real(name))
                self.assertEqual(found["carry"], "carried")
                self.assertEqual(sorted(found["capChecks"]), sorted(carry.ROLES))
                self.assertTrue(all(found["capChecks"].values()))

    def test_runs_that_lost_the_cap_are_lost_and_the_four_checks_failed_together(self):
        for name in ("co1-archive-carryover-bare-2", "co1-archive-carryover-visp-dev-2"):
            with self.subTest(name):
                found = carry.outcome(ARCHIVE, real(name))
                self.assertEqual(found["carry"], "lost")
                self.assertFalse(any(found["capChecks"].values()))

    def test_an_unrelated_failure_does_not_change_the_label(self):
        # Every co1 and co2 run fails "bundle line with a malformed SKU", whatever its carry.
        results = real("co2-archive-carryover-visp-handoff-1")
        self.assertFalse(next(r for r in results if "malformed SKU" in r["name"])["passed"])
        self.assertEqual(carry.outcome(ARCHIVE, results)["carry"], "carried")

    def test_hidden_is_not_changed_by_the_label(self):
        before = json.dumps(PASSING)
        carry.outcome(ARCHIVE, PASSING)
        self.assertEqual(json.dumps(PASSING), before)

    def test_for_hidden_reads_a_file(self):
        found = carry.for_hidden(ARCHIVE, FIXTURES / "co1-archive-carryover-bare-2.hidden.json")
        self.assertEqual(found["carry"], "lost")
        self.assertIsNone(carry.for_hidden(ARCHIVE, FIXTURES / "missing.json"))
        self.assertIsNone(carry.for_hidden("reservations-api", FIXTURES / "co1-archive-carryover-bare-2.hidden.json"))


class RaisedLabels(unittest.TestCase):
    def label(self, caps, old, **flip):
        results = raised(PASSING, caps, old)
        for result in results:
            if result["name"] in flip:
                result["passed"] = flip[result["name"]]
        return carry.outcome(RAISED, results)

    def test_current_needs_the_cap_checks_and_the_past_the_old_limit_check(self):
        self.assertEqual(self.label(ALL, True)["carry"], "current")

    def test_stale_enforces_the_old_limit(self):
        # A 10000 cap: it rejects one over 50000 and the quantity cases, cannot grow an item past 15000,
        # and cannot reach 50000 exactly or hold the concurrent restocks to one success.
        stale = {"boundary": False, "at_cap": True, "quantity": True, "concurrent": False}
        found = self.label(stale, False)
        self.assertEqual(found["carry"], "stale")
        self.assertIs(found["oldLimit"], False)

    def test_forgot_enforces_no_cap(self):
        forgot = {"boundary": False, "at_cap": False, "quantity": False, "concurrent": False}
        self.assertEqual(self.label(forgot, True)["carry"], "forgot")

    def test_everything_else_is_partial(self):
        # A cap at 49999 (off by one): the boundary fails, rejection passes, growing past 10000 works.
        self.assertEqual(self.label({**ALL, "boundary": False, "concurrent": False}, True)["carry"], "partial")
        # The cap checks pass but the replaced limit still holds: not current, not stale.
        self.assertEqual(self.label(ALL, False)["carry"], "partial")

    def test_a_restock_that_does_not_work_is_not_called_stale_or_forgot(self):
        broken = {"at_cap": True, "quantity": True, "boundary": False, "concurrent": False}
        results = raised(PASSING, broken, False)
        for result in results:
            if result["name"].startswith("new:restock returns and persists quantity"):
                result["passed"] = False
        self.assertEqual(carry.outcome(RAISED, results)["carry"], "partial")

    def test_a_result_without_the_added_check_cannot_be_told_apart(self):
        self.assertEqual(carry.outcome(RAISED, PASSING)["carry"], "unknown")
        self.assertEqual(carry.outcome(ARCHIVE, [r for r in PASSING if "concurrent" not in r["name"]])["carry"],
                         "unknown")

    def test_another_task_has_no_label(self):
        self.assertIsNone(carry.outcome("reservations-api", PASSING))


class Statistics(unittest.TestCase):
    def test_fisher_matches_the_hypergeometric_by_hand(self):
        # 10 of 10 against 14 of 20: C(20,14) / C(30,24).
        self.assertAlmostEqual(carry.fisher_greater(10, 10, 14, 20), 38760 / 593775)
        self.assertAlmostEqual(carry.fisher_greater(10, 10, 14, 20), 0.0653, places=4)

    def test_equal_rates_give_a_p_near_one_and_a_lower_rate_a_p_above_one_half(self):
        self.assertGreater(carry.fisher_greater(5, 10, 10, 20), 0.5)
        self.assertGreater(carry.fisher_greater(3, 10, 10, 20), 0.9)

    def test_the_p_is_a_probability_and_counts_the_observed_table(self):
        self.assertAlmostEqual(carry.fisher_greater(0, 5, 0, 5), 1.0)
        self.assertAlmostEqual(carry.fisher_greater(5, 5, 0, 5), 1 / 252)

    def test_the_planned_power_case(self):
        # Pooled over two tasks: 20 VISP runs all carrying against 40 bare runs at 70%: p is below 0.01.
        self.assertLess(carry.fisher_greater(20, 20, 28, 40), 0.01)


def row(run, arm, task, label, reruns=None):
    return {"run": run, "arm": arm, "task": task, "carry": label, "carryReruns": reruns}


MANIFEST = {"tasks": [ARCHIVE, RAISED],
            "arms": [{"label": "bare", "arm": "bare"}, {"label": "bare-automemory", "arm": "bare-automemory"},
                     {"label": "develop", "arm": "visp:develop"},
                     {"label": "develop-norecall", "arm": "visp:develop+norecall"}]}


class Table(unittest.TestCase):
    def rows(self):
        rows = []
        for i in range(20):
            rows.append(row(f"b-{i}", "bare", ARCHIVE, "carried" if i < 14 else "lost"))
            rows.append(row(f"a-{i}", "bare-automemory", ARCHIVE, "carried" if i < 16 else "lost"))
        for i in range(10):
            rows.append(row(f"v-{i}", "develop", ARCHIVE, "carried"))
            rows.append(row(f"n-{i}", "develop-norecall", ARCHIVE, "carried" if i < 8 else "lost"))
            rows.append(row(f"vr-{i}", "develop", RAISED, "current" if i < 7 else ("stale" if i < 9 else "forgot"),
                            reruns=1 if i == 0 else 0))
        for i in range(20):
            rows.append(row(f"br-{i}", "bare", RAISED, "current" if i < 8 else "stale"))
            rows.append(row(f"ar-{i}", "bare-automemory", RAISED, "current" if i < 9 else "forgot"))
        return rows

    def test_rates_labels_and_reruns_per_arm_and_task(self):
        text = carry.markdown(MANIFEST, self.rows())
        self.assertIn("| archive-carryover | bare | 20 | 14 | 70% | carried 14, lost 6 | 0 |", text)
        self.assertIn("| archive-carryover-raised | develop | 10 | 7 | 70% | current 7, forgot 1, stale 2 | 1 |", text)
        self.assertIn("| develop | archive-carryover, archive-carryover-raised | 20 | 17 | 85% | 1 |", text)

    def test_visp_against_each_bare_arm_pooled_over_the_tasks_both_ran(self):
        pairs = {(p["visp"], p["bare"]): p for p in carry.comparisons(self.rows(), carry.arms_of(MANIFEST),
                                                                       MANIFEST["tasks"])}
        both = pairs["develop", "bare"]
        self.assertEqual((both["visp_carried"], both["visp_runs"], both["bare_carried"], both["bare_runs"]),
                         (17, 20, 22, 40))
        self.assertAlmostEqual(both["p"], carry.fisher_greater(17, 20, 22, 40))
        self.assertTrue(both["meets"])
        # The norecall arm ran one task, so the bare arm is counted on that task only.
        norecall = pairs["develop-norecall", "bare"]
        self.assertEqual((norecall["tasks"], norecall["visp_runs"], norecall["bare_runs"]), ([ARCHIVE], 10, 20))
        self.assertEqual(len(pairs), 4)
        self.assertFalse(norecall["meets"])

    def test_the_table_prints_the_comparisons(self):
        text = carry.markdown(MANIFEST, self.rows())
        self.assertIn("| develop | bare | archive-carryover, archive-carryover-raised | 17/20 | 22/40 | +30 |", text)
        self.assertIn("one-sided Fisher exact p", text)

    def test_unlabelled_runs_are_listed_and_left_out_of_the_comparison(self):
        rows = self.rows() + [row("x-1", "develop", ARCHIVE, None)]
        text = carry.markdown(MANIFEST, rows)
        self.assertIn("- x-1", text)
        pair = next(p for p in carry.comparisons(rows, carry.arms_of(MANIFEST), MANIFEST["tasks"])
                    if (p["visp"], p["bare"]) == ("develop", "bare"))
        self.assertEqual(pair["visp_runs"], 20)

    def test_a_batch_without_carryover_tasks(self):
        self.assertIn("No carryover task", carry.markdown({"tasks": ["rainfall-chart"], "arms": []}, []))


class ReportFacts(unittest.TestCase):
    """report.facts adds the carry label from hidden.json and the rerun count from intermediate.json."""

    def test_a_scored_two_session_run(self):
        with tempfile.TemporaryDirectory() as root:
            runs = pathlib.Path(root)
            run = runs / "runs" / "b3-archive-carryover-raised-develop-1"
            (run / "session1").mkdir(parents=True)
            mode = run / "intermediate"
            (mode / "project").mkdir(parents=True)
            (run / "session1" / "result.json").write_text(json.dumps({"seconds": 1}))
            (mode / "result.json").write_text(json.dumps({"seconds": 2}))
            (mode / "intermediate.json").write_text(json.dumps({"seconds": 3, "reruns": 1}))
            (mode / "hidden.json").write_text(json.dumps(
                {"passed": 1, "total": 1, "results": raised(PASSING, ALL, True)}))
            entry = {"name": run.name, "task": RAISED, "arm": "visp:develop", "label": "develop", "rep": 1, "twoSessions": True}
            with mock.patch.object(report, "RUNS", runs), mock.patch.object(report, "transcripts", lambda r: []):
                found = report.facts(entry)
            self.assertEqual((found["carry"], found["carryReruns"]), ("current", 1))

    def test_a_run_of_another_task_has_none(self):
        with tempfile.TemporaryDirectory() as root:
            runs = pathlib.Path(root)
            run = runs / "runs" / "q-rainfall-chart-bare-1"
            (run / "project").mkdir(parents=True)
            (run / "result.json").write_text(json.dumps({"seconds": 1}))
            entry = {"name": run.name, "task": "rainfall-chart", "arm": "bare", "label": "bare", "rep": 1, "twoSessions": False}
            with mock.patch.object(report, "RUNS", runs), mock.patch.object(report, "transcripts", lambda r: []):
                found = report.facts(entry)
            self.assertEqual((found["carry"], found["carryReruns"]), (None, None))


if __name__ == "__main__":
    unittest.main()
