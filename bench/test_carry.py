"""Unit tests for the carry outcome labels (carry.py) and the report.py --carry table.

Run from the repository root: python3 -m unittest bench/test_carry.py
No models are called. fixtures/carry holds the hidden.json of real co1 and co2 runs of
archive-carryover (the projects are not copied). Those runs are all archive-carryover; no
archive-carryover-raised run exists yet, so the -raised cases are built from the real
archive-carryover check names with the cap 50000 and the check the -raised task adds.
"""
import itertools
import json
import math
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


def brute_force(strata):
    """P(VISP's carried runs summed over the tasks >= the observed sum), by listing every table. Floats."""
    def pmf(n1, n2, carried, k):
        if k < max(0, carried - n2) or k > min(n1, carried):
            return 0.0
        return math.comb(n1, k) * math.comb(n2, carried - k) / math.comb(n1 + n2, carried)

    seen = sum(x1 for x1, _, _, _ in strata)
    ranges = [range(max(0, x1 + x2 - n2), min(n1, x1 + x2) + 1) for x1, n1, x2, n2 in strata]
    total = 0.0
    for counts in itertools.product(*ranges):
        if sum(counts) >= seen:
            total += math.prod(pmf(n1, n2, x1 + x2, k) for k, (x1, n1, x2, n2) in zip(counts, strata))
    return total


class Statistics(unittest.TestCase):
    def test_one_task_is_fishers_exact_test(self):
        # 10 of 10 against 14 of 20: C(20,14) / C(30,24).
        self.assertAlmostEqual(carry.stratified_greater([(10, 10, 14, 20)]), 38760 / 593775)
        self.assertAlmostEqual(carry.stratified_greater([(10, 10, 14, 20)]), 0.0653, places=4)

    def test_equal_rates_give_a_p_near_one_and_a_lower_rate_a_p_above_one_half(self):
        self.assertGreater(carry.stratified_greater([(5, 10, 10, 20)]), 0.5)
        self.assertGreater(carry.stratified_greater([(3, 10, 10, 20)]), 0.9)

    def test_the_p_is_a_probability_and_counts_the_observed_table(self):
        self.assertAlmostEqual(carry.stratified_greater([(0, 5, 0, 5)]), 1.0)
        self.assertAlmostEqual(carry.stratified_greater([(5, 5, 0, 5)]), 1 / 252)

    def test_the_planned_power_case(self):
        # One task: 20 VISP runs all carrying against 40 bare runs at 70%: p is below 0.01.
        self.assertLess(carry.stratified_greater([(20, 20, 28, 40)]), 0.01)

    def test_several_tasks_match_a_listing_of_every_table(self):
        for strata in ([(3, 4, 1, 4), (2, 3, 1, 5)],
                       [(10, 10, 14, 20), (7, 10, 8, 20)],
                       [(4, 6, 2, 6), (1, 5, 3, 5), (6, 8, 3, 7)],
                       [(45, 50, 45, 50), (9, 30, 15, 50)]):
            with self.subTest(strata):
                self.assertAlmostEqual(carry.stratified_greater(strata), brute_force(strata), places=12)

    def test_the_tasks_are_summed_not_pooled(self):
        # The case that fooled the pooled test: equal rates within each task (90% and 30%), but VISP ran
        # mostly the high-rate task and bare mostly the low-rate one.
        strata = [(54, 60, 18, 20), (6, 20, 18, 60)]
        pooled = (sum(s[0] for s in strata), sum(s[1] for s in strata), sum(s[2] for s in strata), sum(s[3] for s in strata))
        self.assertLess(carry.stratified_greater([pooled]), 0.001)
        self.assertAlmostEqual(carry.stratified_greater(strata), 0.5849, places=4)

    def test_a_task_where_every_run_agrees_adds_nothing(self):
        informative = [(3, 4, 1, 4)]
        every_run_carried, none_carried, one_arm_only = (5, 5, 5, 5), (0, 3, 0, 2), (4, 4, 0, 0)
        self.assertAlmostEqual(carry.stratified_greater(informative + [every_run_carried, none_carried, one_arm_only]),
                               carry.stratified_greater(informative))


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
        # One stratum per task: archive-carryover 10/10 against 14/20, -raised 7/10 against 8/20.
        self.assertAlmostEqual(both["p"], carry.stratified_greater([(10, 10, 14, 20), (7, 10, 8, 20)]))
        self.assertAlmostEqual(both["p"], 0.0155, places=4)
        self.assertEqual([(t["task"], t["visp_carried"], t["visp_runs"], t["bare_carried"], t["bare_runs"])
                          for t in both["per_task"]], [(ARCHIVE, 10, 10, 14, 20), (RAISED, 7, 10, 8, 20)])
        self.assertEqual([round(100 * t["delta"]) for t in both["per_task"]], [30, 30])
        self.assertTrue(both["meets"])
        # The norecall arm ran one task, so the bare arm is counted on that task only.
        norecall = pairs["develop-norecall", "bare"]
        self.assertEqual((norecall["tasks"], norecall["visp_runs"], norecall["bare_runs"]), ([ARCHIVE], 10, 20))
        self.assertEqual(len(pairs), 4)
        self.assertFalse(norecall["meets"])

    def test_the_table_prints_the_comparisons(self):
        text = carry.markdown(MANIFEST, self.rows())
        self.assertIn("| develop | bare | archive-carryover, archive-carryover-raised | 17/20 | 22/40 | +30 |", text)
        self.assertIn("one-sided exact p, stratified by task", text)
        self.assertIn("| develop | bare | archive-carryover | 10/10 | 14/20 | +30 |", text)
        self.assertIn("| develop | bare | archive-carryover-raised | 7/10 | 8/20 | +30 |", text)

    def test_unlabelled_runs_are_listed_and_left_out_of_the_comparison(self):
        rows = self.rows() + [row("x-1", "develop", ARCHIVE, None)]
        text = carry.markdown(MANIFEST, rows)
        self.assertIn("- x-1", text)
        pair = next(p for p in carry.comparisons(rows, carry.arms_of(MANIFEST), MANIFEST["tasks"])
                    if (p["visp"], p["bare"]) == ("develop", "bare"))
        self.assertEqual(pair["visp_runs"], 20)

    def test_a_batch_without_carryover_tasks(self):
        self.assertIn("No carryover task", carry.markdown({"tasks": ["rainfall-chart"], "arms": []}, []))


def cells(arm, task, runs, kept):
    """`runs` valid runs of an arm on a task, `kept` of them carried."""
    won, missed = ("carried", "lost") if task == ARCHIVE else ("current", "forgot")
    return [row(f"{arm}-{task}-{i}", arm, task, won if i < kept else missed) for i in range(runs)]


class TaskMix(unittest.TestCase):
    """Runs dropped as invalid change an arm's mix of tasks; the comparison must not read that as a gain."""
    MIX = {"tasks": [ARCHIVE, RAISED],
           "arms": [{"label": "bare", "arm": "bare"}, {"label": "develop", "arm": "visp:develop"}]}

    def pair(self, rows, tasks=None):
        [found] = carry.comparisons(rows, carry.arms_of(self.MIX), tasks or self.MIX["tasks"])
        return found

    def runs(self, bare_archive, bare_raised, visp_archive, visp_raised):
        """Each argument is (valid runs, carried)."""
        return (cells("bare", ARCHIVE, *bare_archive) + cells("bare", RAISED, *bare_raised)
                + cells("develop", ARCHIVE, *visp_archive) + cells("develop", RAISED, *visp_raised))

    def test_identical_rates_with_raised_runs_lost_show_no_gain(self):
        # Both arms carry 90% of archive-carryover and 30% of -raised, 50 runs of each planned (the cells of
        # ten runs, five times over, so the carried counts are whole runs). VISP lost 20 of its -raised runs:
        # pooled it is at 54 of 80 (67.5%) against bare's 60 of 100 (60%), +7.5 points from the mix alone.
        found = self.pair(self.runs((50, 45), (50, 15), (50, 45), (30, 9)))
        self.assertEqual((found["visp_carried"], found["visp_runs"], found["bare_carried"], found["bare_runs"]),
                         (54, 80, 60, 100))
        self.assertAlmostEqual(found["delta"], 0.075)
        self.assertEqual([t["delta"] for t in found["per_task"]], [0, 0])
        self.assertAlmostEqual(found["p"], 0.5777, places=4)
        self.assertFalse(found["meets"])

    def test_a_task_mix_alone_does_not_meet_the_gain_rule(self):
        # The same rates again, VISP with 60 archive-carryover and 20 -raised runs, bare with 20 and 60.
        # Pooled, VISP is 30 points ahead at p 0.0001, which the old rule called a gain.
        rows = self.runs((20, 18), (60, 18), (60, 54), (20, 6))
        found = self.pair(rows)
        self.assertAlmostEqual(found["delta"], 0.30)
        self.assertLess(carry.stratified_greater([(60, 80, 36, 80)]), 0.001)
        self.assertEqual([t["delta"] for t in found["per_task"]], [0, 0])
        self.assertAlmostEqual(found["p"], 0.5849, places=4)
        self.assertFalse(found["meets"])

    def test_a_gain_within_both_tasks_still_meets_the_rule(self):
        found = self.pair(self.runs((10, 5), (10, 4), (10, 10), (10, 9)))
        self.assertAlmostEqual(found["delta"], 0.5)
        self.assertEqual([round(100 * t["delta"]) for t in found["per_task"]], [50, 50])
        self.assertLess(found["p"], 0.001)
        self.assertTrue(found["meets"])

    def test_a_large_gain_that_is_not_significant_does_not_meet_the_rule(self):
        found = self.pair(cells("bare", ARCHIVE, 5, 2) + cells("develop", ARCHIVE, 5, 4), [ARCHIVE])
        self.assertAlmostEqual(found["delta"], 0.4)
        self.assertGreater(found["p"], 0.05)
        self.assertFalse(found["meets"])

    def test_exactly_twenty_points_is_enough(self):
        # 1.0 - 0.8 is 0.19999999999999996 in floating point, so the delta is compared in whole runs.
        found = self.pair(cells("bare", ARCHIVE, 25, 20) + cells("develop", ARCHIVE, 25, 25), [ARCHIVE])
        self.assertLess(found["p"], 0.05)
        self.assertTrue(found["meets"])
        short = self.pair(cells("bare", ARCHIVE, 25, 21) + cells("develop", ARCHIVE, 25, 25), [ARCHIVE])
        self.assertFalse(short["meets"])

    def test_a_task_one_arm_has_no_labelled_run_on_is_not_counted_for_the_other(self):
        rows = (cells("bare", ARCHIVE, 20, 14) + cells("bare", RAISED, 20, 6)
                + cells("develop", ARCHIVE, 20, 18) + [row("develop-unscored", "develop", RAISED, None)])
        found = self.pair(rows)
        self.assertEqual(found["tasks"], [ARCHIVE])
        self.assertEqual((found["visp_carried"], found["visp_runs"], found["bare_carried"], found["bare_runs"]),
                         (18, 20, 14, 20))

    def test_the_table_names_the_stratified_test_and_prints_each_task(self):
        text = carry.markdown(self.MIX, self.runs((50, 45), (50, 15), (50, 45), (30, 9)))
        self.assertIn("| develop | bare | archive-carryover, archive-carryover-raised | 54/80 | 60/100 | +8 | 0.578 | no |", text)
        self.assertIn("| develop | bare | archive-carryover | 45/50 | 45/50 | +0 |", text)
        self.assertIn("| develop | bare | archive-carryover-raised | 9/30 | 15/50 | +0 |", text)


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
