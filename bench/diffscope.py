"""Diff scope: how much a change edited, against the reference change for the same request.

Both changes are compared over the product's own files, filtered as the code judge filters them
(code_judge.blind_copy: no version control, workflow files or caches). Per change:

- lines: lines added plus removed outside tests; referenceLines, the same for the reference; and
  their ratio. Tests are counted apart (testLines), since the references have few tests.
- unneededEdits: files that existed before, outside tests, which the worker changed or deleted
  and the reference left unchanged.

A chain task (chains.py) is measured per step, against reference/<task>/step<k>, from the step
before (the task's start/ for step 1); a brownfield task with a reference in REFERENCES, from
start/ to the final project.
"""
import difflib
import pathlib
import re
import tarfile
import tempfile

from chains import BENCH, is_chain, step_files
from code_judge import blind_copy

# Brownfield tasks whose reference/ directory holds the whole changed project.
REFERENCES = {
    "reservations-bundles": "bundles", "spreadsheet-extend": "spreadsheet-extend",
    "spreadsheet-audit": "spreadsheet-audit", "sheet-carryover": "sheet-carryover",
    "archive-carryover": "archive-carryover", "conventions-carryover": "carryover",
    "conventions-carryover-prose": "carryover",
}
TEST = re.compile(r"(^|/)(tests?/|test_[^/]*$|[^/]*_test\.\w+$|[^/]*\.test\.\w+$)")


def product_files(source, temp):
    """{relative path: lines} of a directory or snapshot tar, as the code judge sees it."""
    source = pathlib.Path(source)
    if source.suffix == ".tar":
        unpacked = pathlib.Path(tempfile.mkdtemp(dir=temp))
        with tarfile.open(source) as archive:
            archive.extractall(unpacked)
        source = unpacked
    copy = pathlib.Path(tempfile.mkdtemp(dir=temp))
    blind_copy(source, copy)
    return {str(path.relative_to(copy)): path.read_text().splitlines() for path in copy.rglob("*") if path.is_file()}


def changed_lines(before, after):
    """{path: lines added plus removed} for every file that differs."""
    changes = {}
    for name in sorted(set(before) | set(after)):
        old, new = before.get(name), after.get(name)
        if old == new:
            continue
        diff = difflib.unified_diff(old or [], new or [], lineterm="", n=0)
        changes[name] = sum(1 for line in diff if line[:1] in "+-" and not line.startswith(("+++", "---")))
    return changes


def scope(before, after, reference_before, reference_after):
    """The diff-scope facts of one change against its reference change."""
    with tempfile.TemporaryDirectory(prefix="diffscope-") as temp:
        trees = [product_files(tree, temp) for tree in (before, after, reference_before, reference_after)]
    worker, reference = changed_lines(trees[0], trees[1]), changed_lines(trees[2], trees[3])
    lines = sum(count for name, count in worker.items() if not TEST.search(name))
    reference_lines = sum(count for name, count in reference.items() if not TEST.search(name))
    return {
        "lines": lines, "referenceLines": reference_lines,
        "ratio": round(lines / reference_lines, 2) if reference_lines else None,
        "testLines": sum(count for name, count in worker.items() if TEST.search(name)),
        "unneededEdits": sorted(name for name in worker if name in trees[0] and name not in reference
                                and not TEST.search(name)),
    }


def run_scope(run, task, project):
    """{"steps": [...] for a chain, "total": {...}} for a run, or None without a reference."""
    start = BENCH / "tasks" / task / "start"
    if is_chain(task):
        reference = BENCH / "reference" / task
        steps, before, reference_before = [], start, start
        for number in range(1, len(step_files(task)) + 1):
            after = run / f"step{number}" / "snapshot.tar"
            if not after.is_file():
                break
            steps.append({"step": number, **scope(before, after, reference_before, reference / f"step{number}")})
            before, reference_before = after, reference / f"step{number}"
        if not steps:
            return None
        total = {key: sum(step[key] for step in steps) for key in ("lines", "referenceLines", "testLines")}
        total["ratio"] = round(total["lines"] / total["referenceLines"], 2) if total["referenceLines"] else None
        total["unneededEdits"] = sum(len(step["unneededEdits"]) for step in steps)
        return {"steps": steps, "total": total}
    if task in REFERENCES and start.is_dir() and project.is_dir():
        found = scope(start, project, start, BENCH / "reference" / REFERENCES[task])
        return {"total": {**found, "unneededEdits": len(found["unneededEdits"])}, "files": found["unneededEdits"]}
    return None
