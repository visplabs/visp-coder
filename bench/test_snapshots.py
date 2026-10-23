"""Snapshot reruns (snapshots.py, snapshot_rerun.py): eligibility, the README line, naming, preparing a run.

Run from the repository root: python3 -m unittest bench/test_snapshots.py
No model is called; the second session is replaced by a function that records what it was given.
"""
from pathlib import Path
import argparse
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

BENCH = Path(__file__).resolve().parent
sys.path.insert(0, str(BENCH))
import run_carryover  # noqa: E402
import runfacts  # noqa: E402
import snapshot_rerun  # noqa: E402
import snapshots  # noqa: E402

CREATE = ('- `POST /v1/items` `{"sku": "<sku>", "quantity": <int 0..10000>}` → 201 `{"sku"}`; '
          'quantity above 10000 → 422 `invalid_request`.')
ERRORS = "- Errors: 400 `invalid_json`; 422 `invalid_request` (wrong shape, item quantity above 10000)."
GET = "- `GET /v1/items/<sku>` → 200 `{\"sku\"}`. Unknown → 404 `not_found`."


def readme(*extra):
    return "\n".join(["# Inventory", "", "## Contract", "", CREATE, GET, *extra]) + "\n"


def tar_of(path, files):
    with tarfile.open(path, "w") as archive:
        for name, text in files.items():
            data = text.encode()
            info = tarfile.TarInfo(name)
            info.size, info.mtime, info.mode = len(data), 1_700_000_000, 0o644
            archive.addfile(info, io.BytesIO(data))


def code(constant="MAX_QUANTITY"):
    return f"{constant} = 10000\n\ndef item_request(body):\n    return body\n"


class Detector(unittest.TestCase):
    def test_the_create_bullet_alone_is_not_a_scope_line(self):
        self.assertEqual(snapshots.scope_lines(readme()), [])

    def test_the_errors_line_is_one(self):
        self.assertEqual(snapshots.scope_lines(readme(ERRORS)), [ERRORS])

    def test_a_layout_mention_or_the_constant_is_one(self):
        self.assertEqual(len(snapshots.scope_lines("Layout: including the 10000-unit item cap.\n" + CREATE)), 1)
        self.assertEqual(len(snapshots.scope_lines("Limits live in `MAX_ITEM_QUANTITY`.\n" + CREATE)), 1)

    def test_the_constant_is_read_from_the_code(self):
        self.assertEqual(snapshots.constant_name({"inventory/validation.py": code("MAX_ITEM_QUANTITY")}),
                         "MAX_ITEM_QUANTITY")
        self.assertIsNone(snapshots.constant_name({"inventory/validation.py": "LIMIT = 10000\n"}))
        self.assertIsNone(snapshots.constant_name({"README.md": "MAX_QUANTITY = 10000\n"}))


class Sentence(unittest.TestCase):
    def test_it_quotes_the_convention_with_the_constant_and_no_number(self):
        line = snapshots.scope_sentence("MAX_QUANTITY")
        self.assertIn("Items hold at most `MAX_QUANTITY` units: anything that would exceed this is 422 "
                      "`invalid_request`.", line)
        self.assertNotIn("10000", line)
        self.assertEqual(line.count('"'), 2)
        self.assertTrue(line.startswith("- "))

    def test_it_goes_after_the_create_bullet_and_the_detector_then_sees_it(self):
        line = snapshots.scope_sentence("MAX_ITEM_QUANTITY")
        text = snapshots.insert_sentence(readme(ERRORS.replace("10000", "N")), line).split("\n")
        self.assertEqual(text[text.index(CREATE) + 1], line)
        self.assertEqual(snapshots.scope_lines("\n".join(text)), [line])

    def test_without_a_create_bullet_it_is_appended(self):
        text = snapshots.insert_sentence("# Inventory\n", "- X")
        self.assertEqual(text, "# Inventory\n\n- X\n")


class Sources(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.runs = []

    def tearDown(self):
        self.tmp.cleanup()

    def add(self, batch, name, task="archive-carryover", arm="bare", scope=False, constant="MAX_QUANTITY",
            finished=True, invalid=False):
        run = self.root / "runs" / name
        (run / "session1").mkdir(parents=True)
        tar_of(run / "session1" / "snapshot.tar", {"README.md": readme(ERRORS if scope else ""),
                                                   "inventory/validation.py": code(constant), "tests/t.py": "x\n"})
        (run / "session1" / "result.json").write_text(json.dumps({"run": name, "session": 1, "sessionIds": ["s1"]}))
        (run / "session1" / "hidden-stage1.json").write_text("{}")
        (run / "arm.json").write_text(json.dumps({"task": task, "arm": arm, "preset": "quality-2026-10",
                                                  "memory": "auto" if arm == "bare-automemory" else "off"}))
        (run / "prompt2.txt").write_text(f"Your project directory is {run}/project.\n"
                                         f"Memory {run}/memory.\nTask 2\n")
        (run / "claude-calls.jsonl").write_text('{"cost": 1}\n')
        if finished:
            (run / "fresh").mkdir()
            (run / "fresh" / "result.json").write_text("{}")
        if invalid:
            (run / "invalid.json").write_text("{}")
        self.runs.append({"batch": batch, "entry": {"name": name, "task": task, "arm": arm}})

    def manifests(self):
        for batch in {r["batch"] for r in self.runs} | {"b3", "b3-pilot"}:
            directory = self.root / "batches" / batch
            directory.mkdir(parents=True, exist_ok=True)
            (directory / "manifest.json").write_text(json.dumps(
                {"runs": [r["entry"] for r in self.runs if r["batch"] == batch]}))

    def found(self, batches=("b3", "b3-pilot")):
        self.manifests()
        return snapshots.eligible(self.root, batches)

    def test_eligible_runs_are_unfinished_free_of_scope_lines_and_name_a_constant(self):
        self.add("b3", "b3-archive-carryover-bare-1")
        self.add("b3", "b3-archive-carryover-bare-2", scope=True)
        self.add("b3", "b3-archive-carryover-bare-3", finished=False)
        self.add("b3", "b3-archive-carryover-bare-4", invalid=True)
        self.add("b3", "b3-archive-carryover-bare-5", constant="LIMIT")
        self.add("b3", "b3-archive-carryover-raised-bare-automemory-1", task="archive-carryover-raised",
                 arm="bare-automemory", constant="MAX_ITEM_QUANTITY")
        self.add("b3-pilot", "b3-pilot-archive-carryover-bare-1")
        self.add("b3", "b3-other-bare-1", task="spreadsheet-cli")
        self.add("b3", "b3-archive-carryover-visp-1", arm="visp:develop")
        sources, skipped = self.found()
        self.assertEqual([(s["run"], s["constant"]) for s in sources], [
            ("b3-archive-carryover-bare-1", "MAX_QUANTITY"), ("b3-pilot-archive-carryover-bare-1", "MAX_QUANTITY"),
            ("b3-archive-carryover-raised-bare-automemory-1", "MAX_ITEM_QUANTITY")])
        self.assertEqual(skipped, {"scope line": 1, "unfinished or invalid": 2, "no constant": 1})

    def test_names_follow_batch_py_and_do_not_depend_on_the_sample(self):
        for number in range(1, 7):
            self.add("b3", f"b3-archive-carryover-bare-{number}")
        sources, _ = self.found()
        everything = snapshots.entries("sr", sources, sources, ["readme-scope", "control"])
        self.assertEqual(len(everything), 12)
        self.assertEqual(everything[0]["name"], "sr-archive-carryover-bare-readme-scope-1")
        sampled = snapshots.sample(sources, 2, 7)
        small = snapshots.entries("sr", sampled, sources, ["readme-scope", "control"])
        self.assertEqual(len(small), 4)
        self.assertTrue({r["name"] for r in small} <= {r["name"] for r in everything})
        # Both variants of a source share its number; the label is the arm and the variant.
        by_source = {}
        for run in small:
            by_source.setdefault(run["snapshot"]["source"], set()).add(run["rep"])
        self.assertTrue(all(len(reps) == 1 for reps in by_source.values()))
        self.assertEqual({r["label"] for r in small}, {"bare-readme-scope", "bare-control"})
        self.assertTrue(all(r["twoSessions"] and r["kind"] == "carryover" and r["task"] == "archive-carryover"
                            for r in small))

    def test_a_sample_is_reproducible_and_keeps_the_order(self):
        for number in range(1, 11):
            self.add("b3", f"b3-archive-carryover-bare-{number:02d}")
        sources, _ = self.found()
        first = snapshots.sample(sources, 4, 3)
        self.assertEqual(first, snapshots.sample(sources, 4, 3))
        self.assertEqual(first, sorted(first, key=lambda s: s["run"]))
        self.assertNotEqual({s["run"] for s in first}, {s["run"] for s in snapshots.sample(sources, 4, 4)})
        self.assertEqual(snapshots.sample(sources, None, 3), sources)

    def prepared(self, variant, arm="bare"):
        name = f"b3-archive-carryover-{arm}-1"
        self.add("b3", name, arm=arm)
        sources, _ = self.found()
        entry = snapshots.entries("sr", sources, sources, [variant])[0]
        snapshots.prepare(self.root, entry, "quality-2026-10")
        return entry, self.root / "runs" / entry["name"], self.root / "runs" / name

    def test_control_restores_the_snapshot_unchanged(self):
        entry, run, source = self.prepared("control")
        self.assertEqual((run / "session1" / "snapshot.tar").read_bytes(),
                         (source / "session1" / "snapshot.tar").read_bytes())
        self.assertEqual(json.loads((run / "arm.json").read_text())["snapshotRerun"]["sentence"], None)

    def test_readme_scope_changes_only_the_readme(self):
        entry, run, source = self.prepared("readme-scope")
        with tarfile.open(source / "session1" / "snapshot.tar") as old, \
                tarfile.open(run / "session1" / "snapshot.tar") as new:
            self.assertEqual(old.getnames(), new.getnames())
            for member in old.getmembers():
                before, after = old.extractfile(member).read(), new.extractfile(member.name).read()
                self.assertEqual(before == after, member.name != "README.md", member.name)
                self.assertEqual((member.mode, member.mtime), (new.getmember(member.name).mode,
                                                               new.getmember(member.name).mtime))
            sentence = snapshots.scope_sentence("MAX_QUANTITY")
            self.assertEqual(new.extractfile("README.md").read().decode(),
                             snapshots.insert_sentence(old.extractfile("README.md").read().decode(), sentence))

    def test_the_run_is_its_own_directory_with_the_sources_arm_and_prompt(self):
        entry, run, source = self.prepared("control", arm="bare-automemory")
        arm = json.loads((run / "arm.json").read_text())
        self.assertEqual((arm["arm"], arm["preset"], arm["memory"], arm["task"]),
                         ("bare-automemory", "quality-2026-10", "auto", "archive-carryover"))
        self.assertEqual(arm["snapshotRerun"]["source"], source.name)
        prompt = (run / "prompt2.txt").read_text()
        self.assertIn(f"{run}/project", prompt)
        self.assertIn(f"{run}/memory", prompt)
        self.assertNotIn(str(source), prompt)
        self.assertEqual(json.loads((run / "session1" / "result.json").read_text())["restoredFrom"], source.name)
        # No spend of the source is counted again.
        self.assertFalse((run / "claude-calls.jsonl").exists())
        self.assertTrue((run / "project").is_dir())

    def test_a_source_of_another_preset_is_refused(self):
        name = "b3-archive-carryover-bare-1"
        self.add("b3", name)
        sources, _ = self.found()
        entry = snapshots.entries("sr", sources, sources, ["control"])[0]
        with self.assertRaises(ValueError):
            snapshots.prepare(self.root, entry, "default")

    def test_the_second_session_runs_alone_on_the_variants_snapshot(self):
        entry, run, _ = self.prepared("readme-scope")
        seen = []

        def session(project, arm, prompt, model, timeout, resume, effort):
            seen.append((prompt, (Path(project) / "README.md").read_text(), resume, timeout))
            return {"arm": arm["arm"], "seconds": 1, "timedOut": False, "isError": False,
                    "sessionId": None, "sessionIds": []}

        with mock.patch.object(snapshot_rerun, "RUNS", self.root), \
                mock.patch.object(run_carryover, "run_session", session), \
                mock.patch.object(run_carryover, "RUNS", self.root), \
                mock.patch.object(runfacts, "CLAUDE_PROJECTS", self.root / "claude"):
            snapshot_rerun.run_one(entry["name"], 123)
        self.assertEqual(len(seen), 1)
        prompt, text, resume, timeout = seen[0]
        self.assertIn("Task 2", prompt)
        self.assertIn(snapshots.scope_sentence("MAX_QUANTITY"), text)
        self.assertEqual((resume, timeout), (None, 123))
        self.assertTrue((run / "fresh" / "result.json").is_file())
        self.assertTrue(runfacts.is_finished(run, True))
        self.assertEqual(runfacts.final_project(run), run / "fresh" / "project")


class Driver(unittest.TestCase):
    def test_dry_run_lists_the_runs_from_a_runs_directory(self):
        helper = Sources()
        helper.setUp()
        try:
            for number in range(1, 4):
                helper.add("b3", f"b3-archive-carryover-bare-{number}")
            helper.add("b3", "b3-archive-carryover-bare-automemory-1", arm="bare-automemory")
            helper.manifests()
            done = subprocess.run([sys.executable, str(BENCH / "snapshot_rerun.py"), "--batch", "sr-dry", "--limit", "2",
                                   "--seed", "1", "--spend-cap", "5", "--dry-run"],
                                  env={**os.environ, "VISP_BENCH_RUNS": str(helper.root)}, capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, done.stderr)
            out = done.stdout
            self.assertIn("4 eligible snapshots (3 bare, 1 bare-automemory)", out)
            self.assertIn("2 chosen (--limit 2, seed 1)", out)
            self.assertIn("4 runs", out)
            self.assertIn("spend guard: stops the batch above $5.00", out)
            self.assertEqual(out.count("x1 session (second only)"), 4)
            self.assertFalse((helper.root / "runs" / "sr-dry-archive-carryover-bare-control-1").exists())
            self.assertFalse((helper.root / "batches" / "sr-dry").exists())
        finally:
            helper.tearDown()

    def test_the_guard_knows_this_driver(self):
        import spend_guard
        self.assertIn("snapshot_rerun.py", spend_guard.DRIVERS)
        self.assertIn("batch.py", spend_guard.DRIVERS)


if __name__ == "__main__":
    unittest.main()
