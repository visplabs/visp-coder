"""Snapshot reruns (snapshots.py, snapshot_rerun.py): eligibility, the variants, naming, preparing a run.

Run from the repository root: python3 -m unittest bench/test_snapshots.py
No model is called; the second session is replaced by a function that records what it was given.
"""
from pathlib import Path
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
PLAIN_ERRORS = "- Errors: 400 `invalid_json`; 422 `invalid_request` (wrong shape or values)."
GET = "- `GET /v1/items/<sku>` → 200 `{\"sku\"}`. Unknown → 404 `not_found`."
LINE = "- Limits: item quantity above 10000 (`MAX_QUANTITY`) is 422 `invalid_request`."


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


def read(path, name):
    with tarfile.open(path) as archive:
        return archive.extractfile(name).read().decode()


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


class Lines(unittest.TestCase):
    def test_the_limit_line_is_natural_and_says_nothing_about_which_operations(self):
        line = snapshots.limit_line("MAX_QUANTITY")
        self.assertEqual(line, LINE)
        for word in ("every", "operation", "restock", "adds", "add", "anything", "creating"):
            self.assertNotIn(word, line)
        self.assertEqual(snapshots.scope_lines(line), [line])

    def test_it_goes_after_the_errors_line(self):
        text = snapshots.insert_line(readme(PLAIN_ERRORS, "- Concurrent reservations never overdraw."), LINE).split("\n")
        self.assertEqual(text[text.index(PLAIN_ERRORS) + 1], LINE)
        self.assertEqual(snapshots.scope_lines("\n".join(text)), [LINE])

    def test_without_an_errors_line_it_goes_after_the_create_bullet_else_at_the_end(self):
        text = snapshots.insert_line(readme(), LINE).split("\n")
        self.assertEqual(text[text.index(CREATE) + 1], LINE)
        self.assertEqual(snapshots.insert_line("# Inventory\n", "- X"), "# Inventory\n\n- X\n")

    def test_claude_md_is_new_or_appended(self):
        self.assertEqual(snapshots.claude_md(None, "MAX_QUANTITY"), f"# Project notes\n\n## Limits\n\n{LINE}\n")
        self.assertEqual(snapshots.claude_md("# Mine\n\nText.\n", "MAX_QUANTITY"),
                         f"# Mine\n\nText.\n\n## Limits\n\n{LINE}\n")

    def test_the_oracle_prompt_is_the_second_prompt_plus_the_plain_tasks_conventions(self):
        conventions = (BENCH / "tasks" / "archive-carryover" / "conventions.md").read_text().strip()
        self.assertEqual(snapshots.oracle_prompt("Task:\n\nSecond.\n"), f"Task:\n\nSecond.\n\n{conventions}\n")
        self.assertIn("at most 10000 units", conventions)

    def test_the_oracle_prompt_equals_the_one_setup_arm_writes_for_the_plain_task(self):
        with tempfile.TemporaryDirectory() as tmp:
            done = subprocess.run([sys.executable, str(BENCH / "setup_arm.py"), "archive-carryover", "bare", "o1"],
                                  env={**os.environ, "VISP_BENCH_RUNS": tmp}, capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, done.stderr)
            run = Path(tmp) / "runs" / "o1"
            self.assertEqual(snapshots.oracle_prompt((run / "prompt2.txt").read_text()),
                             (run / "prompt2-oracle.txt").read_text())


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
        tar_of(run / "session1" / "snapshot.tar", {"README.md": readme(ERRORS if scope else PLAIN_ERRORS),
                                                   "inventory/validation.py": code(constant), "tests/t.py": "x\n"})
        (run / "session1" / "result.json").write_text(json.dumps({"run": name, "session": 1, "sessionIds": ["s1"]}))
        (run / "session1" / "hidden-stage1.json").write_text("{}")
        (run / "arm.json").write_text(json.dumps({"task": task, "arm": arm, "preset": "quality-2026-10",
                                                  "memory": "auto" if arm == "bare-automemory" else "off"}))
        (run / "prompt.txt").write_text(f"Your project directory is {run}/project.\nTask 1\n")
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

    def test_eligible_runs_are_finished_free_of_scope_lines_and_name_a_constant(self):
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
        everything = snapshots.entries("sr", sources, sources, ["control", "oracle"])
        self.assertEqual(len(everything), 12)
        self.assertEqual(everything[0]["name"], "sr-archive-carryover-bare-control-1")
        sampled = snapshots.sample(sources, 2, 7)
        small = snapshots.entries("sr", sampled, sources, ["control", "oracle"])
        self.assertEqual(len(small), 4)
        self.assertTrue({r["name"] for r in small} <= {r["name"] for r in everything})
        # Variants of a source share its number; the label is the arm and the variant.
        by_source = {}
        for run in small:
            by_source.setdefault(run["snapshot"]["source"], set()).add(run["rep"])
        self.assertTrue(all(len(reps) == 1 for reps in by_source.values()))
        self.assertEqual({r["label"] for r in small}, {"bare-control", "bare-oracle"})
        self.assertTrue(all(r["twoSessions"] and r["kind"] == "carryover" and r["task"] == "archive-carryover"
                            for r in small))

    def test_control_and_oracle_are_queued_before_the_other_variants_and_oracle_asks_for_its_mode(self):
        self.add("b3", "b3-archive-carryover-bare-1")
        self.add("b3", "b3-archive-carryover-bare-2")
        sources, _ = self.found()
        runs = snapshots.entries("sr", sources, sources, list(snapshots.VARIANTS))
        self.assertEqual([r["snapshot"]["variant"] for r in runs],
                         ["control", "oracle", "control", "oracle", "readme-natural", "claudemd-line",
                          "readme-natural", "claudemd-line"])
        self.assertEqual({r["snapshot"]["variant"]: r["mode"] for r in runs},
                         {"control": "fresh", "oracle": "oracle", "readme-natural": "fresh", "claudemd-line": "fresh"})

    def test_a_sample_is_reproducible_and_keeps_the_order(self):
        for number in range(1, 11):
            self.add("b3", f"b3-archive-carryover-bare-{number:02d}")
        sources, _ = self.found()
        first = snapshots.sample(sources, 4, 3)
        self.assertEqual(first, snapshots.sample(sources, 4, 3))
        self.assertEqual(first, sorted(first, key=lambda s: s["run"]))
        self.assertNotEqual({s["run"] for s in first}, {s["run"] for s in snapshots.sample(sources, 4, 4)})
        self.assertEqual(snapshots.sample(sources, None, 3), sources)

    def prepared(self, variant, arm="bare", task="archive-carryover"):
        name = f"b3-{task}-{arm}-1"
        self.add("b3", name, arm=arm, task=task)
        sources, _ = self.found()
        entry = snapshots.entries("sr", sources, sources, [variant])[0]
        snapshots.prepare(self.root, entry, "quality-2026-10", version="9.9.9")
        return entry, self.root / "runs" / entry["name"], self.root / "runs" / name

    def test_control_and_oracle_restore_the_snapshot_unchanged(self):
        for variant in ("control", "oracle"):
            with self.subTest(variant=variant):
                entry, run, source = self.prepared(variant)
                self.assertEqual((run / "session1" / "snapshot.tar").read_bytes(),
                                 (source / "session1" / "snapshot.tar").read_bytes())
                self.assertIsNone(json.loads((run / "arm.json").read_text())["snapshotRerun"]["added"])
                shutil_rm(run)
                shutil_rm(source)

    def test_oracle_has_the_conventions_in_its_second_prompt_only(self):
        entry, run, source = self.prepared("oracle", task="archive-carryover-raised")
        text = (run / "prompt2-oracle.txt").read_text()
        conventions = (BENCH / "tasks" / "archive-carryover" / "conventions.md").read_text().strip()
        self.assertTrue(text.startswith((run / "prompt2.txt").read_text()))
        self.assertTrue(text.endswith(f"\n{conventions}\n"))
        self.assertNotIn("50000", text)
        self.assertEqual(json.loads((run / "arm.json").read_text())["snapshotRerun"]["mode"], "oracle")

    def test_readme_natural_changes_only_the_readme(self):
        entry, run, source = self.prepared("readme-natural")
        with tarfile.open(source / "session1" / "snapshot.tar") as old, \
                tarfile.open(run / "session1" / "snapshot.tar") as new:
            self.assertEqual(old.getnames(), new.getnames())
            for member in old.getmembers():
                before, after = old.extractfile(member).read(), new.extractfile(member.name).read()
                self.assertEqual(before == after, member.name != "README.md", member.name)
                self.assertEqual((member.mode, member.mtime), (new.getmember(member.name).mode,
                                                               new.getmember(member.name).mtime))
            self.assertEqual(new.extractfile("README.md").read().decode(),
                             snapshots.insert_line(old.extractfile("README.md").read().decode(), LINE))

    def test_claudemd_line_adds_a_claude_md_and_leaves_the_readme(self):
        entry, run, source = self.prepared("claudemd-line")
        old, new = source / "session1" / "snapshot.tar", run / "session1" / "snapshot.tar"
        self.assertEqual(read(new, "README.md"), read(old, "README.md"))
        self.assertEqual(read(new, "CLAUDE.md"), f"# Project notes\n\n## Limits\n\n{LINE}\n")
        with tarfile.open(old) as before, tarfile.open(new) as after:
            self.assertEqual(sorted(after.getnames()), sorted([*before.getnames(), "CLAUDE.md"]))

    def test_the_run_is_its_own_directory_with_the_sources_arm_prompt_and_version(self):
        entry, run, source = self.prepared("control", arm="bare-automemory")
        arm = json.loads((run / "arm.json").read_text())
        self.assertEqual((arm["arm"], arm["preset"], arm["memory"], arm["task"]),
                         ("bare-automemory", "quality-2026-10", "auto", "archive-carryover"))
        self.assertEqual((arm["claudeVersion"], arm["sourceClaudeVersion"]), ("9.9.9", None))
        self.assertEqual(arm["snapshotRerun"]["source"], source.name)
        for name in ("prompt.txt", "prompt2.txt", "prompt2-oracle.txt"):
            prompt = (run / name).read_text()
            self.assertIn(f"{run}/project", prompt)
            self.assertNotIn(str(source), prompt)
        self.assertIn(f"{run}/memory", (run / "prompt2.txt").read_text())
        self.assertEqual(json.loads((run / "session1" / "result.json").read_text())["restoredFrom"], source.name)
        # No spend of the source is counted again.
        self.assertFalse((run / "claude-calls.jsonl").exists())
        self.assertTrue((run / "project").is_dir())

    def test_a_source_of_another_preset_or_an_unknown_variant_is_refused(self):
        name = "b3-archive-carryover-bare-1"
        self.add("b3", name)
        sources, _ = self.found()
        entry = snapshots.entries("sr", sources, sources, ["control"])[0]
        with self.assertRaises(ValueError):
            snapshots.prepare(self.root, entry, "default")
        entry["snapshot"]["variant"] = "nope"
        with self.assertRaises(ValueError):
            snapshots.prepare(self.root, entry, "quality-2026-10")

    def run_one(self, variant):
        entry, run, _ = self.prepared(variant)
        seen = []

        def session(project, arm, prompt, model, timeout, resume, effort):
            project = Path(project)
            seen.append({"prompt": prompt, "readme": (project / "README.md").read_text(), "resume": resume,
                         "timeout": timeout, "claude": (project / "CLAUDE.md").exists()})
            return {"arm": arm["arm"], "seconds": 1, "timedOut": False, "isError": False,
                    "sessionId": None, "sessionIds": []}

        with mock.patch.object(snapshot_rerun, "RUNS", self.root), \
                mock.patch.object(run_carryover, "run_session", session), \
                mock.patch.object(run_carryover, "RUNS", self.root), \
                mock.patch.object(runfacts, "CLAUDE_PROJECTS", self.root / "claude"):
            snapshot_rerun.run_one(entry["name"], 123)
        return run, seen

    def test_the_second_session_runs_alone_on_the_variants_snapshot(self):
        run, seen = self.run_one("readme-natural")
        self.assertEqual(len(seen), 1)
        self.assertIn("Task 2", seen[0]["prompt"])
        self.assertNotIn("Items hold at most", seen[0]["prompt"])
        self.assertIn(LINE, seen[0]["readme"])
        self.assertEqual((seen[0]["resume"], seen[0]["timeout"], seen[0]["claude"]), (None, 123, False))
        self.assertTrue((run / "fresh" / "result.json").is_file())
        self.assertTrue(runfacts.is_finished(run, True))
        self.assertEqual(runfacts.final_project(run), run / "fresh" / "project")

    def test_the_oracle_session_gets_the_conventions_and_writes_the_oracle_directory(self):
        run, seen = self.run_one("oracle")
        self.assertEqual(len(seen), 1)
        self.assertIn("Items hold at most 10000 units", seen[0]["prompt"])
        self.assertNotIn(LINE, seen[0]["readme"])
        self.assertTrue((run / "oracle" / "result.json").is_file())
        self.assertEqual(runfacts.final_project(run), run / "oracle" / "project")

    def test_the_claude_md_variant_puts_the_file_in_the_project(self):
        run, seen = self.run_one("claudemd-line")
        self.assertTrue(seen[0]["claude"])
        self.assertNotIn(LINE, seen[0]["readme"])


def shutil_rm(path):
    import shutil
    shutil.rmtree(path, ignore_errors=True)


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
            self.assertIn("8 runs", out)
            self.assertIn("spend guard: stops the batch above $5.00", out)
            self.assertEqual(out.count("x1 session (second only)"), 8)
            for variant in snapshots.VARIANTS:
                self.assertEqual(out.count(f"{variant} of b3-"), 2, variant)
            self.assertFalse((helper.root / "runs" / "sr-dry-archive-carryover-bare-control-1").exists())
            self.assertFalse((helper.root / "batches" / "sr-dry").exists())
        finally:
            helper.tearDown()

    def test_a_later_pass_with_fewer_variants_keeps_the_arms_of_the_runs_it_keeps(self):
        import argparse
        import batch
        with tempfile.TemporaryDirectory() as tmp:
            args = argparse.Namespace(batch="sr", jobs=1, preset="quality-2026-10", reps=1, dry_run=False,
                                      rerun_invalid=False, spend_cap=None, spend_interval=60)

            def run(label, variant):
                return {"name": f"sr-{label}", "task": "archive-carryover", "kind": "carryover", "arm": "bare",
                        "label": label, "rep": 1, "timeout": 1, "twoSessions": True, "mode": "fresh",
                        "snapshot": {"source": "s", "variant": variant, "constant": "MAX_QUANTITY"}}

            with mock.patch.object(batch, "RUNS", Path(tmp)), \
                    mock.patch.object(batch, "execute", lambda entry, *_: (entry["name"], "finished")), \
                    mock.patch.object(batch, "claude_version", lambda: "2.1.300"):
                batch.drive(args, ["archive-carryover"], [("bare-control", "bare"), ("bare-oracle", "bare")],
                            [run("bare-control", "control"), run("bare-oracle", "oracle")])
                batch.drive(args, ["archive-carryover"], [("bare-readme-natural", "bare")],
                            [run("bare-readme-natural", "readme-natural")])
            manifest = json.loads((Path(tmp) / "batches" / "sr" / "manifest.json").read_text())
        self.assertEqual([arm["label"] for arm in manifest["arms"]],
                         ["bare-readme-natural", "bare-control", "bare-oracle"])
        self.assertEqual(len(manifest["runs"]), 3)
        self.assertEqual(manifest["claudeVersion"], "2.1.300")

    def test_the_guard_knows_this_driver(self):
        import spend_guard
        self.assertIn("snapshot_rerun.py", spend_guard.DRIVERS)
        self.assertIn("batch.py", spend_guard.DRIVERS)


if __name__ == "__main__":
    unittest.main()
