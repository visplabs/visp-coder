"""Qualify the reviewer probes (bench/probe.py, bench/probekit.py, bench/tasks/<task>/probes) and their report column.

Run from the repository root: python3 -m unittest bench/test_probes.py
The checks use copies of the bench references and the standard library; no models are called.

- The unmodified reference implementation passes every `request` probe and fails every `refgap` probe.
- The reference with a minimal fix of the gap passes every probe.
- Faulty variants fail the probes written for them.
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

BENCH = Path(__file__).resolve().parent
sys.path.insert(0, str(BENCH))
import probe  # noqa: E402
import probekit  # noqa: E402
import report  # noqa: E402

TASKS = {"reservations-bundles": "bundles", "spreadsheet-extend": "spreadsheet-extend"}

BUNDLE_FIX = [("inventory/validation.py",
               '        if not isinstance(sku, str) or not is_int(quantity) or quantity < 1:\n'
               '            raise ApiError(422, "invalid_request")\n        parsed.append',
               '        if not isinstance(sku, str) or not SKU.fullmatch(sku) or not is_int(quantity) or quantity < 1:\n'
               '            raise ApiError(422, "invalid_request")\n        parsed.append')]
SHEET_FIX = [("sheet/engine.py", "        return left ** right\n",
              "        try:\n            result = left ** right\n        except ZeroDivisionError:\n"
              '            return Err("#DIV/0!")\n        except OverflowError:\n            return Err("#VALUE!")\n'
              '        return Err("#VALUE!") if isinstance(result, complex) else result\n')]
FIXES = {"reservations-bundles": BUNDLE_FIX, "spreadsheet-extend": SHEET_FIX}


def prepare(task, directory, edits=()):
    """A copy of the task's reference in `directory` with the (file, old, new) edits applied."""
    import shutil

    project = Path(directory) / "project"
    shutil.copytree(BENCH / "reference" / TASKS[task], project, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    for name, old, new in edits:
        path = project / name
        text = path.read_text()
        assert old in text, f"{name}: {old[:50]!r} not found"
        path.write_text(text.replace(old, new, 1))
    return project


def script(task):
    return BENCH / "tasks" / task / "probes" / "probes.py"


def run_probes(task, project, only=None):
    command = [sys.executable, str(script(task)), str(project)] + (["--only", ",".join(only)] if only else [])
    done = subprocess.run(command, capture_output=True, text=True, timeout=300)
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


def by_name(result):
    return {r["name"]: r for r in result["results"]}


class RegistryTests(unittest.TestCase):
    def listing(self, task):
        done = subprocess.run([sys.executable, str(script(task)), "--list"], capture_output=True, text=True, check=True)
        return [line.split("\t") for line in done.stdout.splitlines()]

    def test_every_probe_names_its_clause_group_and_finding(self):
        for task in TASKS:
            rows = self.listing(task)
            with self.subTest(task=task):
                self.assertGreaterEqual(len(rows), 40)
                self.assertEqual(len({row[0] for row in rows}), len(rows), "probe ids are unique")
                for pid, group, finding, clause in rows:
                    self.assertIn(group, probekit.GROUPS, pid)
                    self.assertGreater(len(clause), 20, f"{pid} quotes the request or README")

    def test_findings_are_covered(self):
        found = {task: {row[2] for row in self.listing(task)} - {"-"} for task in TASKS}
        self.assertEqual(found["reservations-bundles"], {"sku-422", "sku-newline"})
        self.assertEqual(found["spreadsheet-extend"], {"sum-empty", "pow-crash"})

    def test_probe_cli_lists_a_task(self):
        done = subprocess.run([sys.executable, str(BENCH / "probe.py"), "--list", "spreadsheet-extend"],
                              capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("pow-zero-to-negative-power", done.stdout)


class ProbeKitTests(unittest.TestCase):
    def test_a_crashing_probe_fails_without_stopping_the_others(self):
        registry = probekit.Registry()
        registry.case("fine", "a clause", lambda: (True, None))
        registry.case("bad", "a clause", lambda: 1 / 0, "refgap", "f1")
        registry.case("late", "a clause", lambda: (False, {"x": 1}))
        results = probekit.execute(registry.probes)
        self.assertEqual([(r["name"], r["passed"]) for r in results], [("fine", True), ("bad", False), ("late", False)])
        self.assertIn("ZeroDivisionError", results[1]["detail"])
        self.assertEqual((results[1]["group"], results[1]["finding"]), ("refgap", "f1"))
        self.assertEqual(results[2]["detail"], {"x": 1})
        self.assertEqual([r["name"] for r in probekit.execute(registry.probes, only={"late"})], ["late"])

    def test_duplicate_ids_and_unknown_groups_are_refused(self):
        registry = probekit.Registry()
        registry.case("one", "c", lambda: (True, None))
        with self.assertRaises(AssertionError):
            registry.case("one", "c", lambda: (True, None))
        with self.assertRaises(AssertionError):
            registry.case("two", "c", lambda: (True, None), "elsewhere")


class SummaryTests(unittest.TestCase):
    RESULT = {"results": [
        {"name": "a", "passed": True, "group": "request", "finding": None},
        {"name": "b", "passed": False, "group": "refgap", "finding": "sku-422"},
        {"name": "c", "passed": True, "group": "refgap", "finding": "sku-422"},
        {"name": "d", "passed": False, "group": "request", "finding": None},
    ]}

    def test_counts_groups_findings_and_failures(self):
        s = probe.summarize(self.RESULT)
        self.assertEqual((s["passed"], s["total"], s["text"]), (2, 4, "2/4"))
        self.assertEqual((s["findingsPassed"], s["findingsTotal"]), (1, 2))
        self.assertEqual(s["groups"], {"request": {"passed": 1, "total": 2}, "refgap": {"passed": 1, "total": 2}})
        self.assertEqual(s["failed"], ["b", "d"])
        self.assertEqual(s["rate"], 0.5)

    def test_missing_or_empty_results_score_zero(self):
        self.assertEqual(probe.summarize({})["rate"], 0.0)
        self.assertEqual(probe.summarize(None)["total"], 0)
        self.assertIn("no result", probe.line("run", {"error": "boom"}))
        self.assertIn("probes 2/4", probe.line("run", self.RESULT))

    def test_score_project_reports_a_script_that_prints_no_json(self):
        with tempfile.TemporaryDirectory() as directory:
            fake = Path(directory) / "probes.py"
            fake.write_text("import sys\nprint('oops', file=sys.stderr)\n")
            original = probe.probe_script
            probe.probe_script = lambda task: fake
            try:
                result = probe.score_project("any", directory)
            finally:
                probe.probe_script = original
        self.assertIn("no result", result["error"])
        self.assertIn("oops", result["error"])

    def test_score_project_refuses_a_task_without_probes(self):
        with self.assertRaises(SystemExit):
            probe.score_project("lighthouse-pixel", "/nonexistent")

    def test_project_without_a_launcher_fails_one_check(self):
        with tempfile.TemporaryDirectory() as directory:
            for task, launcher in (("reservations-bundles", "start.sh"), ("spreadsheet-extend", "run.sh")):
                result = run_probes(task, directory)
                self.assertEqual((result["passed"], result["total"]), (0, 1), launcher)

    def test_cli_scores_a_directory_and_writes_the_out_file(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "out.json"
            done = subprocess.run([sys.executable, str(BENCH / "probe.py"), "spreadsheet-extend", "--project",
                                   directory, "--out", str(out)], capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertIn("probes 0/1", done.stdout)
            self.assertEqual(json.loads(out.read_text())["total"], 1)


class ReportTests(unittest.TestCase):
    def test_probe_score_reads_probes_json_and_ignores_tasks_without_probes(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            project = run / "project"
            project.mkdir()
            (run / "probes.json").write_text(json.dumps(SummaryTests.RESULT))
            rate, text, findings, findings_text = report.probe_score("reservations-bundles", project)
            self.assertEqual((rate, text, findings, findings_text), (0.5, "2/4", 0.5, "1/2"))
            self.assertEqual(report.probe_score("lighthouse-pixel", project), (None, None, None, None))
            (run / "probes.json").write_text(json.dumps({"error": "timed out"}))
            self.assertEqual(report.probe_score("reservations-bundles", project), (None, None, None, None))
            (run / "probes.json").unlink()
            self.assertEqual(report.probe_score("reservations-bundles", project), (None, None, None, None))

    def rows(self, probes):
        base = {"run": "r", "kept": None, "hidden": 1.0, "hiddenText": "60/60", "judge": None, "checklist": None,
                "code": 5.0, "wall": 100, "idle": None, "model": None, "visp": None, "own": None, "legacyIdle": None,
                "reviewed": 0, "unavailable": 0, "pictures": 0, "refusals": 0, "timedOut": False, "cost": None,
                "criticCost": None, "problems": [], "chain": None, "diffScope": None, "stage1": None,
                "checklistText": None, "probes": probes[0], "probesText": probes[1], "probeFindings": probes[2],
                "probeFindingsText": probes[3]}
        return [base]

    def test_probes_are_a_separate_column_and_never_change_hidden(self):
        manifest = {"batch": "b", "preset": "p", "settings": {"worker": {"model": "m", "effort": None}}}
        for probes, expect in (((0.5, "2/4", 0.25, "1/4"), True), ((None, None, None, None), False)):
            rows = self.rows(probes)
            groups = {("reservations-bundles", "bare"): report.summarize(rows, ["hidden"])}
            text = report.markdown(manifest, rows, groups, {}, [], [], True)
            self.assertEqual("Probes from findings" in text, expect)
            self.assertIn("100.0%", text)
            summary = groups[("reservations-bundles", "bare")]
            self.assertEqual(summary["hidden"], 1.0)
            self.assertEqual(summary["required"], ["hidden"])
            if expect:
                self.assertEqual((summary["probes"], summary["probeFindings"]), (0.5, 0.25))
                self.assertIn("50.0%", text)
                self.assertIn("2/4", text)
                header = [line for line in text.splitlines() if line.startswith("| Task |")][0]
                self.assertEqual(header.count("|"), text.splitlines()[text.splitlines().index(header) + 1].count("|"))

    def test_probes_do_not_make_a_task_incomplete_or_enter_the_verdict(self):
        base = report.summarize(self.rows((1.0, "4/4", 1.0, "1/1")), ["hidden"])
        candidate = report.summarize(self.rows((0.0, "0/4", 0.0, "0/1")), ["hidden"])
        base["idle"] = candidate["idle"] = None
        verdict = report.compare(base, candidate, "bare", "visp")
        self.assertEqual(verdict["status"], "pass")
        self.assertEqual([check[0] for check in verdict["checks"]], ["hidden", "wall", "idle"])


class ReferenceTests(unittest.TestCase):
    def check_task(self, task):
        with tempfile.TemporaryDirectory() as plain, tempfile.TemporaryDirectory() as fixed:
            result = run_probes(task, prepare(task, plain))
            results = by_name(result)
            for name, r in results.items():
                if r["group"] == "request":
                    self.assertTrue(r["passed"], f"{task}: the unmodified reference fails {name}: {r['detail']}")
                else:
                    self.assertFalse(r["passed"], f"{task}: the unmodified reference passes refgap probe {name}")
            self.assertTrue(any(r["group"] == "refgap" for r in results.values()))
            repaired = run_probes(task, prepare(task, fixed, FIXES[task]))
            self.assertEqual(repaired["passed"], repaired["total"],
                             [(r["name"], r["detail"]) for r in repaired["results"] if not r["passed"]])
            self.assertEqual(repaired["total"], result["total"])
        return result

    def test_reservations_bundles_reference(self):
        result = self.check_task("reservations-bundles")
        self.assertEqual(result["total"], 47)

    def test_spreadsheet_extend_reference(self):
        result = self.check_task("spreadsheet-extend")
        self.assertEqual(result["total"], 74)


class FaultyVariantTests(unittest.TestCase):
    def failed(self, task, edits, only):
        with tempfile.TemporaryDirectory() as directory:
            project = prepare(task, directory, list(FIXES[task]) + list(edits))
            result = run_probes(task, project, only)
        return {r["name"] for r in result["results"] if not r["passed"]}, {r["name"] for r in result["results"]}

    def test_bundle_confirm_that_reduces_only_the_first_line_fails_its_probes(self):
        edit = [("inventory/store.py", "            for sku, quantity in reservation[\"lines\"]:\n                self.items[sku] -= quantity\n",
                 "            sku, quantity = reservation[\"lines\"][0]\n            self.items[sku] -= quantity\n")]
        only = ["bundle-confirm-reduces-every-line", "bundle-delete-confirmed-404", "line-sku-malformed", "single-response-unchanged"]
        failed, ran = self.failed("reservations-bundles", edit, only)
        self.assertEqual(ran, set(only))
        self.assertIn("bundle-confirm-reduces-every-line", failed)
        self.assertIn("bundle-delete-confirmed-404", failed)
        self.assertNotIn("line-sku-malformed", failed)
        self.assertNotIn("single-response-unchanged", failed)

    def test_single_response_with_lines_fails_its_probe_only(self):
        edit = [("inventory/store.py", '"sku": sku, "quantity": quantity, "expiresAt": iso(expires)}',
                 '"sku": sku, "quantity": quantity, "lines": [], "expiresAt": iso(expires)}')]
        only = ["single-response-unchanged", "bundle-response-keys", "line-sku-malformed"]
        failed, _ = self.failed("reservations-bundles", edit, only)
        self.assertEqual(failed, {"single-response-unchanged"})

    def test_unknown_sku_checked_on_the_first_line_only_fails_all_or_nothing(self):
        edit = [("inventory/store.py", "            if any(sku not in self.items for sku, _ in lines):\n                raise ApiError(404, \"not_found\")\n",
                 "            if any(sku not in self.items for sku, _ in lines[:1]):\n                raise ApiError(404, \"not_found\")\n")]
        only = ["unknown-last-line-holds-nothing", "unknown-wellformed-sku-404", "bundle-response-keys"]
        failed, _ = self.failed("reservations-bundles", edit, only)
        self.assertIn("unknown-last-line-holds-nothing", failed)
        self.assertNotIn("bundle-response-keys", failed)

    def test_integer_empty_sum_in_a_strict_compare_fails_the_empty_sum_probe(self):
        edit = [("sheet/engine.py", "        op = node[1]\n        result = {",
                 "        if type(left) is not type(right):\n            return Err(\"#VALUE!\")\n        op = node[1]\n        result = {")]
        only = ["cmp-sum-of-empty-range", "cmp-every-operator-on-numbers", "cmp-sum-of-text-range", "text-literal-special-characters"]
        failed, _ = self.failed("spreadsheet-extend", edit, only)
        self.assertIn("cmp-sum-of-empty-range", failed)
        self.assertNotIn("text-literal-special-characters", failed)
        self.assertNotIn("cmp-every-operator-on-numbers", failed)

    def test_if_that_evaluates_both_branches_fails_the_lazy_branch_probes(self):
        edit = [("sheet/engine.py", "            return self.evaluate(node[2][1] if chosen else node[2][2])\n",
                 "            first, second = self.evaluate(node[2][1]), self.evaluate(node[2][2])\n"
                 "            if isinstance(first, Err):\n                return first\n"
                 "            if isinstance(second, Err):\n                return second\n"
                 "            return first if chosen else second\n")]
        only = ["if-untaken-branch-ignored", "if-nested-and-as-operand", "text-literal-special-characters"]
        failed, _ = self.failed("spreadsheet-extend", edit, only)
        self.assertEqual(failed, {"if-untaken-branch-ignored"})

    def test_copy_that_ignores_the_column_distance_fails_the_column_probes(self):
        edit = [("sheet/cli.py", "ord(target[0]) - ord(cell[0]), int(target[1:])", "0, int(target[1:])")]
        only = ["copy-moves-columns-only", "copy-moves-rows-only", "copy-each-dollar-part", "formula-prints-raw-content"]
        failed, _ = self.failed("spreadsheet-extend", edit, only)
        self.assertEqual(failed, {"copy-moves-columns-only", "copy-each-dollar-part"})


if __name__ == "__main__":
    unittest.main()
