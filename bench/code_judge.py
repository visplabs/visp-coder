"""Blind code-quality judge: score the source a run produced against a fixed, anchored rubric.

Usage: code_judge.py <run_name> [...]
       code_judge.py --project <dir> --task <task> [--out <file>]

Only the product's own files are copied, under an anonymous temporary directory: version control,
workflow state and instructions (.visp, .claude, .codex, .agents, .specify, _bmad*, specs/,
CLAUDE.md, AGENTS*.md, VISP.commands.md, visp.yml), every hidden file, dependencies, caches,
images, binaries and paths that name a workflow are left out, and so are the files VISP's
independent tester wrote (the `file` of each acceptance-tests.json), which are not the worker's.
In every other file, source or document, the names of the workflows (VISP, Spec Kit, BMAD) are
replaced by "workflow", so a README or a test that writes to `.visp/` is still judged and, in a
change, shows only the edits the worker made.

A task with a starting codebase (start/) is judged on the change: the judge gets before/ (the
starting tree, filtered the same way), after/ (the product) and change.diff, and is told to judge
what was added or modified, not the provided code. A chain task is judged on the cumulative
change of all its steps, with every step's request. A new project is copied to product/.

The judge (Opus 5.5 at high effort, or the run's preset code judge) reads the code with Read, Grep
and Glob only and scores six criteria and an overall score from 1 to 10, each with a one-line
justification, against anchors that say what 3, 6 and 9 look like. Writes code_judge.json beside
the project. Runs marked invalid (invalid.json) are skipped.
"""
import argparse
import difflib
import json
import pathlib
import re
import shutil
import sys
import tempfile

from chains import step_files
from common import RUNS
from judge import ask
from presets import CODE_JUDGE
from runfacts import final_project, invalid

BENCH = pathlib.Path(__file__).resolve().parent
SKIP_DIRS = {"node_modules", "__pycache__", "specs", "_bmad", "_bmad-output", "venv", "dist", "build", "coverage"}
SKIP_FILES = {"CLAUDE.md", "AGENTS.md", "AGENTS.visp.md", "VISP.commands.md", "visp.yml", "visp-memory.yaml"}
BINARY = re.compile(r"\.(png|svg|gif|jpe?g|webp|ico|bmp|pdf|zip|tar|gz|pyc|so|db|sqlite3?|log|lock)$", re.I)
SOURCE = re.compile(r"\.(py|js|mjs|cjs|ts|tsx|jsx|html|css|sh|go|rs|java|rb|c|h|cpp)$", re.I)
WORKFLOW = re.compile(r"\bvisp\b|\bVISP_\w+|spec[- ]?kit|speckit|\bbmad\w*|\.specify\b", re.I)
MAX_FILE = 200_000
CRITERIA = {
    "correctness_risks": {
        "asks": "How likely is the code to misbehave? Higher means fewer risks.",
        3: "likely bugs on main paths: cases the request names are wrong or unhandled, shared state is changed "
           "without synchronization where requests run concurrently, errors are swallowed or crash the program",
        6: "main paths look right, but some edge cases or error paths the request names are unhandled or doubtful "
           "(a missing validation, a race on a rare path, a leaked resource)",
        9: "no visible bug; the edge cases and errors the request names are handled; concurrency and resources are "
           "handled deliberately",
    },
    "structure": {
        "asks": "Is the code divided into units with clear responsibilities?",
        3: "most logic sits in one or a few very long functions or one file mixing parsing, rules, I/O and "
           "presentation; duplicated blocks; mutable global state used everywhere",
        6: "a reasonable split into modules and functions, but some functions do too much or responsibilities "
           "leak across layers",
        9: "small cohesive units with clear boundaries; dependencies flow one way; one behaviour changes in one place",
    },
    "readability": {
        "asks": "How easily can a new reader follow the code?",
        3: "hard to follow: deep nesting, long dense functions, unexplained magic numbers, dead or commented-out "
           "code, misleading comments",
        6: "readable with effort; some long or dense parts; comments uneven",
        9: "reads top-down; plain control flow; named constants; comments explain why where it is not obvious",
    },
    "naming": {
        "asks": "Do names say what things are and do?",
        3: "single letters or generic names (data, tmp, x2, handle) for non-trivial things, or misleading names",
        6: "mostly clear names, some vague or inconsistent ones",
        9: "names say what things are and do, consistently, in the request's own domain words",
    },
    "tests": {
        "asks": "Do the project's own tests exercise the behaviour the request specifies?",
        3: "no tests, or tests that only import or run the code, or assert things that are trivially true; the "
           "main behaviour is untested",
        6: "tests exercise the main behaviour but miss important edge cases or errors the request names, or are "
           "brittle",
        9: "tests exercise the specified behaviour, edge cases and errors through real interfaces, and would fail "
           "if that behaviour broke",
    },
    "idiom": {
        "asks": "Is the code idiomatic for its language and platform?",
        3: "fights the language: reimplements the standard library, awkward constructs, inconsistent style",
        6: "mostly idiomatic, with a few awkward constructs or style inconsistencies",
        9: "idiomatic and consistent; uses the standard library and platform well",
    },
}
OVERALL = {3: "would need substantial rework before it could be merged",
           6: "mergeable after a review round with several fixes",
           9: "would be merged as is in a well-run team"}
SCORE = {"type": "object", "properties": {"score": {"type": "integer", "minimum": 1, "maximum": 10},
                                          "justification": {"type": "string"}},
         "required": ["score", "justification"]}
SCHEMA = {"type": "object", "properties": {**{name: SCORE for name in CRITERIA}, "overall": SCORE},
          "required": [*CRITERIA, "overall"]}


def request_text(task):
    task_dir = BENCH / "tasks" / task
    if (task_dir / "session1.md").is_file():
        conventions = (task_dir / "conventions.md").read_text().strip()
        first = (task_dir / "session1.md").read_text().replace("{conventions}", conventions).strip()
        second = (task_dir / "session2.md").read_text().strip()
        return f"First request:\n\n{first}\n\nSecond request, in a later session:\n\n{second}"
    steps = step_files(task)
    if steps:
        return "\n\n".join(f"Request {number}{'' if number == 1 else ', in a later session'}:\n\n{path.read_text().strip()}"
                             for number, path in enumerate(steps, start=1))
    return (task_dir / "task.md").read_text().strip()


def tester_files(project):
    """Files VISP's independent tester wrote (acceptance-tests.json `file`): not the worker's work."""
    files = set()
    for record in project.glob(".visp/features/*/acceptance-tests.json"):
        try:
            data = json.loads(record.read_text())
        except ValueError:
            continue
        if isinstance(data, dict) and data.get("file"):
            files.add(pathlib.PurePath(data["file"]))
    return files


def blind_copy(source, target):
    """Copy the product's own files; returns (files copied, files left out, names redacted).

    The same rules apply to the starting tree, so before/ and after/ differ only by the work.
    """
    tester = tester_files(source)
    copied = left_out = redacted = 0
    for path in sorted(source.rglob("*")):
        relative = path.relative_to(source)
        if not path.is_file():
            continue
        parts = relative.parts
        if any(part.startswith(".") for part in parts) or SKIP_DIRS.intersection(parts) \
                or path.name in SKIP_FILES or BINARY.search(path.name) or path.stat().st_size > MAX_FILE \
                or pathlib.PurePath(relative) in tester or WORKFLOW.search(str(relative)):
            left_out += 1
            continue
        try:
            text = path.read_text()
        except UnicodeDecodeError:
            left_out += 1
            continue
        text, count = WORKFLOW.subn("workflow", text)
        redacted += count
        (target / relative).parent.mkdir(parents=True, exist_ok=True)
        (target / relative).write_text(text)
        copied += 1
    return copied, left_out, redacted


def unified_diff(before, after):
    names = sorted({str(p.relative_to(before)) for p in before.rglob("*") if p.is_file()}
                   | {str(p.relative_to(after)) for p in after.rglob("*") if p.is_file()})
    chunks = []
    for name in names:
        old = (before / name).read_text().splitlines(keepends=True) if (before / name).is_file() else []
        new = (after / name).read_text().splitlines(keepends=True) if (after / name).is_file() else []
        chunks += difflib.unified_diff(old, new, f"before/{name}", f"after/{name}")
    return "".join(chunks)


def rubric():
    lines = []
    for name, criterion in CRITERIA.items():
        lines.append(f"- {name}: {criterion['asks']}\n  3 = {criterion[3]}\n  6 = {criterion[6]}\n  9 = {criterion[9]}")
    lines.append("- overall: your judgement of the code as a whole, not an average.\n"
                 + "\n".join(f"  {score} = {text}" for score, text in OVERALL.items()))
    return "\n".join(lines)


def judge_project(project, task, settings=CODE_JUDGE):
    """Judge one project directory blind; returns the result record (not written)."""
    start = BENCH / "tasks" / task / "start"
    with tempfile.TemporaryDirectory(prefix="review-") as temp:
        directory = pathlib.Path(temp)
        if start.is_dir():
            (directory / "before").mkdir()
            (directory / "after").mkdir()
            blind_copy(start, directory / "before")
            copied, left_out, redacted = blind_copy(project, directory / "after")
            diff = unified_diff(directory / "before", directory / "after")
            (directory / "change.diff").write_text(diff)
            scope = (f"The project started from an existing codebase. {directory}/before/ is the code as provided, "
                     f"{directory}/after/ is the code after the work, and {directory}/change.diff is the difference. "
                     "Judge the change: the code that was added or modified, and the tests for it. Do not credit or "
                     "blame code that was provided and left unchanged, unless the change should have touched it.")
        else:
            (directory / "product").mkdir()
            copied, left_out, redacted = blind_copy(project, directory / "product")
            diff = None
            scope = f"The code is in {directory}/product/. It was written from scratch for the request."
        prompt = (
            "Review the quality of the code a developer wrote for the request below. Read the code with the Read, "
            "Grep and Glob tools; you cannot run it. Read every source and test file before scoring.\n\n"
            f"{scope}\n\nRequest:\n{request_text(task)}\n\n"
            "Score each criterion from 1 to 10 on its own, using the anchors below (use the numbers between them "
            "for code between two anchors, and 1, 2 or 10 only for code clearly beyond them). Base each score on "
            "what you saw in the code. Do not reward length, comments or tests for their own sake, and do not judge "
            "the size of the project. Give a one-line justification per score that names the evidence.\n\n"
            f"{rubric()}"
        )
        verdict, usage = ask(settings["model"], settings["effort"], prompt, directory, SCHEMA,
                             tools="Read,Grep,Glob", timeout=1200)
    scores = {name: (verdict.get(name) or {}).get("score") for name in CRITERIA}
    numbers = [value for value in scores.values() if isinstance(value, int)]
    return {
        "task": task, "judge": f"{settings['model']}:{settings['effort']}",
        "scope": "change" if start.is_dir() else "new", "files": copied, "leftOut": left_out,
        "redacted": redacted, "diffBytes": len(diff) if diff is not None else None,
        "overall": (verdict.get("overall") or {}).get("score"), "criteria": scores,
        "mean": round(sum(numbers) / len(numbers), 2) if numbers else None,
        "error": verdict.get("error") or (None if verdict.get("overall") else "the judge gave no score"),
        "verdict": verdict, "call": usage,
    }


def judge_run(name):
    run = RUNS / "runs" / name
    if invalid(run):
        return {"run": name, "skipped": "invalid run"}
    arm = json.loads((run / "arm.json").read_text())
    settings = (arm.get("settings") or {}).get("codeJudge") or CODE_JUDGE
    project = final_project(run)
    result = {"run": name, **judge_project(project, arm["task"], settings)}
    (project.parent / "code_judge.json").write_text(json.dumps(result, indent=2))
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("runs", nargs="*")
    parser.add_argument("--project", type=pathlib.Path)
    parser.add_argument("--task")
    parser.add_argument("--out", type=pathlib.Path)
    args = parser.parse_args()
    if args.project:
        if not args.task:
            raise SystemExit("--project needs --task")
        result = judge_project(args.project.resolve(), args.task)
        (args.out or args.project.parent / "code_judge.json").write_text(json.dumps(result, indent=2))
        results = [result]
    else:
        results = [judge_run(name) for name in args.runs]
    for result in results:
        print(json.dumps({k: result.get(k) for k in ("run", "task", "overall", "criteria", "error", "skipped")}))
    sys.exit(1 if any(result.get("error") for result in results) else 0)


if __name__ == "__main__":
    main()
