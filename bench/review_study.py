"""Review study: does VISP's evidence record help a reviewer catch defects in agent-made changes?

Usage: review_study.py build [--only <case>] [--record C=<build>]   make the review cases from finished runs
       review_study.py run --model <id> --reps N [--effort E] [--jobs J] [--conditions A,B]
       review_study.py grade                          match reviews of seeded cases to their defect
       review_study.py report [--out <file>]          detection, false rejects and cost, A against B

Material: finished VISP runs of brownfield tasks (`reservations-bundles`, `spreadsheet-extend`)
under `$VISP_BENCH_RUNS/runs`, which pass every hidden check. `review_cases.json` names the runs
and, for about half the cases, a seeded defect: exact text edits applied to a copy of the
project. A clean case is the run's product as it is.

Each case is shown to a model reviewer, blind to the condition, with no tools:

- A: the request and the change's diff;
- B: the same, plus the evidence record (`visp pr`, printed by the run's own VISP build);
- C, D, ...: the same with the record another VISP build prints (`build --record C=<build>`, a
  build under `$VISP_BENCH_RUNS/shims`), to try a new record on the same cases. Evidence is bound
  to the build that ran it, so a newer build reads every old check as stale; in a second copy of
  the case's tree the build is installed (`visp install --replace-runtime`, its edits to tracked
  files undone) and runs every slice's checks (`visp verify`) before it prints `visp pr`. Its
  record is printed as is, except the elapsed-time line, which is taken from the build's print
  of the original run so it does not count the days since.

A seeded case's record stays the one VISP produced, as a defect that reaches human review is one
VISP's checks and reviewer missed, with two corrections so it never contradicts the tree shown:
every check command is executed again on the seeded copy and a check that now fails is shown
failed, and the list of changed files is the seeded tree's. A clean case goes through the same
steps, so nothing but the defect tells the two apart.

Everything lands in `$VISP_BENCH_RUNS/review-study/`: `cases/<id>/` (prompt inputs and
`truth.json`), `reviews.jsonl` (one line per call) and `grades.jsonl`. Run contents are data:
they are quoted into prompts and never executed beyond each run's own recorded check commands.
"""
import argparse
import concurrent.futures
import json
import math
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

from common import RUNS
from judge import ask

BENCH = pathlib.Path(__file__).resolve().parent
CASES = BENCH / "review_cases.json"
OUT = RUNS / "review-study"
SHIMS = RUNS / "shims"

# Workflow files are VISP's own state and instructions, not the product change under review.
EXCLUDE = (".visp", ".claude", ".mcp.json", "CLAUDE.md", "AGENTS.md", "AGENTS.visp.md",
           "VISP.commands.md", "visp.yml", ".gitignore")
CHECK_ROW = re.compile(r"^\| (?P<id>[A-Z0-9-]+) \| `(?P<command>.+)` \| (?P<result>.+) \|$")
CHANGE_ROW = re.compile(r"^- (modified|untracked|deleted|added|renamed): .+$")

REVIEW_SCHEMA = {
    "type": "object",
    "properties": {
        "decision": {"type": "string", "enum": ["accept", "reject"]},
        "defects": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"file": {"type": "string"}, "description": {"type": "string"}},
                "required": ["file", "description"],
            },
        },
        "summary": {"type": "string"},
    },
    "required": ["decision", "defects", "summary"],
}
GRADE_SCHEMA = {
    "type": "object",
    "properties": {"found": {"type": "boolean"}, "reason": {"type": "string"}},
    "required": ["found", "reason"],
}


def load_cases():
    return json.loads(CASES.read_text())["cases"]


# ---- building cases ----------------------------------------------------------------------------

def git(project, *args, check=True):
    return subprocess.run(["git", "-c", "core.quotepath=off", *args], cwd=project, check=check,
                          capture_output=True, text=True).stdout


def product_diff(project):
    """The change against the task's start commit, workflow files left out, new files included."""
    git(project, "add", "-A", "--", ".", *[f":(exclude){path}" for path in EXCLUDE])
    return git(project, "diff", "--cached", "--no-color", "HEAD", "--", ".",
               *[f":(exclude){path}" for path in EXCLUDE])


def apply_edits(project, edits):
    """Apply exact text edits; each `old` must occur exactly once in its file."""
    for edit in edits:
        path = project / edit["file"]
        text = path.read_text() if path.exists() else ""
        if "old" in edit:
            count = text.count(edit["old"])
            if count != 1:
                raise ValueError(f"{edit['file']}: expected one match of {edit['old'][:60]!r}, found {count}")
            text = text.replace(edit["old"], edit["new"])
        else:
            text = edit["new"]
        path.write_text(text)


def record_text(run, build):
    """The run's `visp pr` document, printed in place by the VISP build the run used."""
    shim = SHIMS / build / "visp"
    done = subprocess.run([str(shim), "pr"], cwd=RUNS / "runs" / run / "project",
                          capture_output=True, text=True, timeout=120)
    if done.returncode != 0:
        raise RuntimeError(f"visp pr failed for {run}: {done.stderr[-400:]}")
    return done.stdout


def tracked_changes(project):
    return {line[3:] for line in git(project, "status", "--porcelain").splitlines() if line[:2] != "??"}


def fresh_record(project, run, build):
    """`visp pr` from `build` after it re-executes every slice's checks in this copy of the tree."""
    shim = str(SHIMS / build / "visp")
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    before = tracked_changes(project)
    subprocess.run([shim, "install", "--harness", "claude-code", "--replace-runtime"], cwd=project,
                   capture_output=True, text=True, timeout=300, env=env, check=True)
    added = sorted(tracked_changes(project) - before)
    if added:
        git(project, "checkout", "--", *added)
    original = record_text(run, build)
    for task in sorted(set(re.findall(r"\(T\d{3}\)", original))):
        subprocess.run([shim, "verify", "--task", task[1:-1]], cwd=project, capture_output=True,
                       text=True, timeout=900, env=env)
    done = subprocess.run([shim, "pr"], cwd=project, capture_output=True, text=True, timeout=120, env=env)
    if done.returncode != 0:
        raise RuntimeError(f"visp pr failed for {run} with {build}: {done.stderr[-400:]}")
    elapsed = re.search(r"^- Time: .*$", original, re.M)
    return re.sub(r"^- Time: .*$", lambda _: elapsed.group(0), done.stdout, flags=re.M) if elapsed else done.stdout


def check_rows(record):
    return [match.groupdict() for match in map(CHECK_ROW.match, record.splitlines()) if match]


def run_checks(project, rows, timeout=300):
    """{check id: exit code} for each recorded check command, executed in the copy."""
    codes = {}
    for row in rows:
        try:
            done = subprocess.run(row["command"], shell=True, cwd=project, capture_output=True,
                                  text=True, timeout=timeout,
                                  env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
            codes[row["id"]] = done.returncode
        except subprocess.TimeoutExpired:
            codes[row["id"]] = 124
    return codes


def changed_files(project):
    """`visp pr`'s list of uncommitted changes for the tree, sorted by path as VISP prints it."""
    lines = []
    for line in git(project, "status", "--porcelain", "--", ".",
                    *[f":(exclude){path}" for path in EXCLUDE]).splitlines():
        code, path = line[:2], line[3:]
        kind = {"??": "untracked", "A": "untracked", "D": "deleted"}.get(code.strip(), "modified")
        lines.append((path, f"- {kind}: {path}"))
    return [text for _, text in sorted(lines)]


def corrected_record(record, codes, files):
    """The record with failed checks shown failed and the tree's own list of changed files."""
    out, in_changes, failed = [], False, sorted(cid for cid, code in codes.items() if code != 0)
    for line in record.splitlines():
        row = CHECK_ROW.match(line)
        if row and codes.get(row["id"], 0) != 0:
            stamp = re.search(r"\d{4}-\d\d-\d\dT[\d:.]+Z", row["result"])
            when = f", {stamp.group(0)}" if stamp else ""
            line = f"| {row['id']} | `{row['command']}` | failed (exit {codes[row['id']]}{when}) |"
        if line == "Uncommitted changes:":
            in_changes = True
            out.append(line)
            out.append("")
            out.extend(files)
            continue
        if in_changes:
            if not line or CHANGE_ROW.match(line):
                continue
            in_changes = False
            out.append("")
        if failed and line.startswith("Status: "):
            line = f"Status: open. Check{'s' if len(failed) > 1 else ''} {', '.join(failed)} failed on the latest run."
        out.append(line)
    return "\n".join(out) + ("\n" if record.endswith("\n") else "")


def hidden_result(task, project):
    done = subprocess.run([sys.executable, str(BENCH / "tasks" / task / "hidden_test.py"), str(project)],
                          capture_output=True, text=True, timeout=600)
    result = json.loads(done.stdout)
    failed = [r.get("name") or r.get("id") for r in result.get("results", []) if not r.get("passed", r.get("pass"))]
    return {"passed": result["passed"], "total": result["total"], "failed": failed}


def build_case(case, out, records=()):
    """Write the case's inputs; `records` adds (condition, build) records beside the run's own."""
    run = RUNS / "runs" / case["run"]
    arm = json.loads((run / "arm.json").read_text())
    task, build = arm["task"], arm["arm"].split(":", 1)[1]
    record = record_text(case["run"], build)
    rows = check_rows(record)
    target = out / case["id"]
    shutil.rmtree(target, ignore_errors=True)
    target.mkdir(parents=True)
    with tempfile.TemporaryDirectory() as temp:
        project = pathlib.Path(temp) / "project"
        shutil.copytree(run / "project", project, symlinks=True,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        apply_edits(project, case.get("edits", []))
        extra = {}
        for condition, other in records:
            fresh = pathlib.Path(temp) / f"fresh-{condition}"
            shutil.copytree(project, fresh, symlinks=True)
            extra[condition] = fresh_record(fresh, case["run"], other)
        codes = run_checks(project, rows)
        files = changed_files(project)
        diff = product_diff(project)
        hidden = hidden_result(task, project)
    request = (BENCH / "tasks" / task / "task.md").read_text().strip()
    (target / "request.md").write_text(request + "\n")
    (target / "diff.patch").write_text(diff)
    (target / "record.md").write_text(corrected_record(record, codes, files))
    for condition, text in extra.items():
        (target / f"record-{condition}.md").write_text(text)
    truth = {
        "id": case["id"], "run": case["run"], "task": task, "build": build,
        "seeded": bool(case.get("edits")), "kind": case.get("kind"), "defect": case.get("defect"),
        "checks": codes, "checksFailed": sorted(cid for cid, code in codes.items() if code != 0),
        "hidden": hidden, "diffBytes": len(diff),
    }
    (target / "truth.json").write_text(json.dumps(truth, indent=2) + "\n")
    return truth


# ---- reviewing ---------------------------------------------------------------------------------

def review_prompt(case_dir, condition):
    request = (case_dir / "request.md").read_text().strip()
    diff = (case_dir / "diff.patch").read_text()
    parts = [
        "You are reviewing a pull request that a coding agent made in response to the request below. "
        "Decide whether it can be merged as it is (accept) or needs changes first (reject).\n\n"
        "Reject only for a concrete defect: a requirement of the request that is not met or met "
        "wrongly, existing behaviour that the change breaks, an edit outside what the request asks "
        "for, a wrong edge case, or a test weakened or removed so that something passes. Style, "
        "naming or missing polish alone is not a reason to reject. You have no tools; judge from "
        "what is given. List every defect you find with the file it is in; for an accept, the list "
        "is empty.",
        f"<request>\n{request}\n</request>",
    ]
    if condition != "A":
        record = case_dir / ("record.md" if condition == "B" else f"record-{condition}.md")
        parts.append("The agent's workflow tool recorded this evidence record for the change "
                     "(requirements it tracked, checks it executed and their results, scope, review). "
                     "It is the tool's account, not ground truth.\n\n"
                     f"<evidence_record>\n{record.read_text().strip()}\n</evidence_record>")
    parts.append("The diff is against the existing codebase before the change; files the diff "
                 "does not show are unchanged.\n\n"
                 f"<diff>\n{diff}</diff>")
    return "\n\n".join(parts)


def run_reviews(model, effort, reps, jobs, conditions, cases=None):
    OUT.mkdir(parents=True, exist_ok=True)
    log = OUT / "reviews.jsonl"
    done = {(r["case"], r["condition"], r["model"], r["effort"], r["rep"])
            for r in read_jsonl(log) if not r.get("error")}
    work = [(case["id"], condition, rep)
            for rep in range(reps) for case in load_cases() for condition in conditions
            if (not cases or case["id"] in cases)
            and (case["id"], condition, model, effort, rep) not in done]
    lock = threading.Lock()
    scratch = pathlib.Path(tempfile.mkdtemp(prefix="review-study-"))

    def one(item):
        case_id, condition, rep = item
        started = time.time()
        verdict, usage = ask(model, effort, review_prompt(OUT / "cases" / case_id, condition),
                             scratch, REVIEW_SCHEMA, tools="", timeout=900)
        row = {"case": case_id, "condition": condition, "model": model, "effort": effort, "rep": rep,
               "seconds": round(time.time() - started, 1), "verdict": verdict,
               "cost": usage.get("total_cost_usd"), "usage": usage.get("usage"),
               "error": verdict.get("error") or (usage.get("is_error") and usage.get("subtype"))}
        with lock, log.open("a") as handle:
            handle.write(json.dumps(row) + "\n")
        return row

    print(f"{len(work)} reviews to run", file=sys.stderr)
    with concurrent.futures.ThreadPoolExecutor(jobs) as pool:
        for row in pool.map(one, work):
            print(f"{row['case']} {row['condition']} rep {row['rep']}: "
                  f"{row['verdict'].get('decision', row['error'])} ${row['cost'] or 0:.3f} {row['seconds']}s",
                  file=sys.stderr)


def read_jsonl(path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


# ---- grading -----------------------------------------------------------------------------------

def grade_prompt(defect, defects):
    return (
        "A reviewer looked at a code change that contains one known, deliberately seeded defect. "
        "Decide whether any of the reviewer's reported defects identifies that seeded defect: the "
        "same problem in substance (the same wrong behaviour, missing behaviour, out-of-scope edit "
        "or weakened test), even if worded differently or only partly explained. A report about a "
        "different problem in the same file does not count.\n\n"
        f"<seeded_defect>\n{defect}\n</seeded_defect>\n\n"
        f"<reported_defects>\n{json.dumps(defects, indent=2)}\n</reported_defects>"
    )


def grade(model="claude-haiku-5-5", effort="low", jobs=4):
    cases = {case["id"]: case for case in load_cases()}
    graded = {grade_key(g) for g in read_jsonl(OUT / "grades.jsonl")}
    todo = [r for r in read_jsonl(OUT / "reviews.jsonl")
            if not r.get("error") and cases[r["case"]].get("edits") and grade_key(r) not in graded
            and r["verdict"].get("decision") == "reject" and r["verdict"].get("defects")]
    lock = threading.Lock()
    scratch = pathlib.Path(tempfile.mkdtemp(prefix="review-grade-"))

    def one(review):
        verdict, usage = ask(model, effort, grade_prompt(cases[review["case"]]["defect"], review["verdict"]["defects"]),
                             scratch, GRADE_SCHEMA, tools="", timeout=300)
        row = {key: review[key] for key in ("case", "condition", "model", "effort", "rep")}
        row.update(found=verdict.get("found"), reason=verdict.get("reason"), error=verdict.get("error"),
                   cost=usage.get("total_cost_usd"))
        with lock, (OUT / "grades.jsonl").open("a") as handle:
            handle.write(json.dumps(row) + "\n")

    print(f"{len(todo)} reviews to grade", file=sys.stderr)
    with concurrent.futures.ThreadPoolExecutor(jobs) as pool:
        list(pool.map(one, todo))


def grade_key(row):
    return (row["case"], row["condition"], row["model"], row["effort"], row["rep"])


# ---- reporting ---------------------------------------------------------------------------------

def mean_se(values):
    """Mean and standard error over cases (each case's repetitions are averaged first)."""
    values = [v for v in values if v is not None]
    if not values:
        return None, None
    mean = sum(values) / len(values)
    if len(values) < 2:
        return mean, None
    variance = sum((v - mean) ** 2 for v in values) / (len(values) - 1)
    return mean, math.sqrt(variance / len(values))


def outcomes(reviews, grades, cases, visible=frozenset()):
    """Per review: rejected, and for a seeded case whether the seeded defect was found.

    `visible` names the seeded cases whose defect makes a recorded check fail.
    """
    found = {grade_key(g): g.get("found") for g in grades if not g.get("error")}
    rows = []
    for review in reviews:
        if review.get("error"):
            continue
        case = cases[review["case"]]
        rejected = review["verdict"].get("decision") == "reject"
        caught = None
        if case.get("edits"):
            caught = bool(rejected and found.get(grade_key(review)))
        rows.append({**{k: review[k] for k in ("case", "condition", "model", "effort", "rep", "seconds")},
                     "cost": review.get("cost") or 0.0, "rejected": rejected, "caught": caught,
                     "seeded": bool(case.get("edits")), "kind": case.get("kind"),
                     "visible": review["case"] in visible})
    return rows


def per_case(rows, key):
    grouped = {}
    for row in rows:
        grouped.setdefault(row["case"], []).append(row[key])
    return {case: sum(values) / len(values) for case, values in grouped.items()}


def summary(rows):
    seeded = [r for r in rows if r["seeded"]]
    clean = [r for r in rows if not r["seeded"]]
    return {
        "detection": mean_se(list(per_case(seeded, "caught").values())),
        "seededRejects": mean_se(list(per_case(seeded, "rejected").values())),
        "falseRejects": mean_se(list(per_case(clean, "rejected").values())),
        "cost": mean_se(list(per_case(rows, "cost").values())),
        "seconds": mean_se(list(per_case(rows, "seconds").values())),
        "reviews": len(rows),
    }


def paired(rows, key, seeded=None, other="B"):
    """`other` minus A per case, then mean and standard error over cases (seeded None: every case)."""
    subset = [r for r in rows if seeded is None or r["seeded"] == seeded]
    a = per_case([r for r in subset if r["condition"] == "A"], key)
    b = per_case([r for r in subset if r["condition"] == other], key)
    return mean_se([b[c] - a[c] for c in a if c in b])


def fmt(pair, percent=True, money=False):
    mean, se = pair
    if mean is None:
        return "–"
    if money:
        return f"${mean:.3f}" + (f" ± {se:.3f}" if se is not None else "")
    if percent:
        return f"{100 * mean:.0f}%" + (f" ± {100 * se:.0f}" if se is not None else "")
    return f"{mean:.0f}" + (f" ± {se:.0f}" if se is not None else "")


def check_visible_cases():
    """Seeded cases whose defect fails one of the run's own recorded checks."""
    visible = set()
    for case in load_cases():
        truth = OUT / "cases" / case["id"] / "truth.json"
        if case.get("edits") and truth.exists() and json.loads(truth.read_text())["checksFailed"]:
            visible.add(case["id"])
    return visible


def report():
    cases = {case["id"]: case for case in load_cases()}
    rows = outcomes(read_jsonl(OUT / "reviews.jsonl"), read_jsonl(OUT / "grades.jsonl"), cases,
                    check_visible_cases())
    reviewers = sorted({(r["model"], r["effort"]) for r in rows})
    conditions = sorted({r["condition"] for r in rows})
    lines = ["| Reviewer | Condition | Reviews | Seeded defect found | Seeded rejected | "
             "Clean rejected (false) | Cost per review | Seconds per review |",
             "| --- | --- | --- | --- | --- | --- | --- | --- |"]
    result = {}
    for reviewer in reviewers:
        name = f"{reviewer[0]} ({reviewer[1]})"
        mine = [r for r in rows if (r["model"], r["effort"]) == reviewer]
        for condition in conditions:
            s = summary([r for r in mine if r["condition"] == condition])
            result[f"{reviewer[0]}:{reviewer[1]}:{condition}"] = s
            lines.append(f"| {name} | {condition} | {s['reviews']} | {fmt(s['detection'])} | "
                         f"{fmt(s['seededRejects'])} | {fmt(s['falseRejects'])} | {fmt(s['cost'], money=True)} | "
                         f"{fmt(s['seconds'], percent=False)} |")
        for other in conditions[1:]:
            diff = {"detection": paired(mine, "caught", True, other),
                    "seededRejects": paired(mine, "rejected", True, other),
                    "falseRejects": paired(mine, "rejected", False, other),
                    "cost": paired(mine, "cost", None, other), "seconds": paired(mine, "seconds", None, other)}
            result[f"{reviewer[0]}:{reviewer[1]}:{other}-A"] = diff
            lines.append(f"| {name} | {other} − A | | {fmt(diff['detection'])} | {fmt(diff['seededRejects'])} | "
                         f"{fmt(diff['falseRejects'])} | {fmt(diff['cost'], money=True)} | "
                         f"{fmt(diff['seconds'], percent=False)} |")
    lines += ["", "| Reviewer | Seeded group | Cases | " + " | ".join(
                  f"{label} {c}" for label in ("Found", "Rejected") for c in conditions) + " |",
              "| --- | --- | --- | " + " | ".join("---" for _ in range(2 * len(conditions))) + " |"]
    for reviewer in reviewers:
        mine = [r for r in rows if (r["model"], r["effort"]) == reviewer and r["seeded"]]
        groups = [("fails a recorded check", lambda r: r["visible"]),
                  ("passes every recorded check", lambda r: not r["visible"])]
        groups += [(kind, lambda r, kind=kind: r["kind"] == kind) for kind in sorted({r["kind"] for r in mine})]
        for label, keep in groups:
            subset = [r for r in mine if keep(r)]
            cells = [fmt(mean_se(list(per_case([r for r in subset if r["condition"] == c], key).values())))
                     for key in ("caught", "rejected") for c in conditions]
            lines.append(f"| {reviewer[0]} ({reviewer[1]}) | {label} | {len({r['case'] for r in subset})} | "
                         + " | ".join(cells) + " |")
    lines += ["", "Per case: seeded cases count reviews that found the defect, clean cases count rejects.", "",
              "| Case | Seeded | Kind | Check fails | " + " | ".join(
                  f"{m.removeprefix('claude-')} {c}" for m, _ in reviewers for c in conditions) + " |",
              "| --- | --- | --- | --- | " + " | ".join("---" for _ in reviewers for _ in conditions) + " |"]
    visible = check_visible_cases()
    for case_id, case in cases.items():
        cells = []
        for reviewer in reviewers:
            for condition in conditions:
                subset = [r for r in rows if r["case"] == case_id and r["condition"] == condition
                          and (r["model"], r["effort"]) == reviewer]
                key = "caught" if case.get("edits") else "rejected"
                cells.append(f"{sum(bool(r[key]) for r in subset)}/{len(subset)}" if subset else "–")
        lines.append(f"| {case_id} | {'yes' if case.get('edits') else 'no'} | {case.get('kind') or ''} | "
                     f"{'yes' if case_id in visible else ''} | " + " | ".join(cells) + " |")
    text = "\n".join(lines) + "\n"
    (OUT / "report.json").write_text(json.dumps(result, indent=2) + "\n")
    return text


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    b = sub.add_parser("build")
    b.add_argument("--only", action="append")
    b.add_argument("--record", action="append", default=[], metavar="C=BUILD",
                   help="also print each case's record with this VISP build, as condition C")
    r = sub.add_parser("run")
    r.add_argument("--model", required=True)
    r.add_argument("--effort", default="medium")
    r.add_argument("--reps", type=int, default=1)
    r.add_argument("--jobs", type=int, default=4)
    r.add_argument("--conditions", default="A,B")
    r.add_argument("--case", action="append")
    g = sub.add_parser("grade")
    g.add_argument("--jobs", type=int, default=4)
    p = sub.add_parser("report")
    p.add_argument("--out", type=pathlib.Path)
    args = parser.parse_args()
    if args.command == "build":
        for case in load_cases():
            if args.only and case["id"] not in args.only:
                continue
            truth = build_case(case, OUT / "cases", [tuple(r.split("=", 1)) for r in args.record])
            print(f"{truth['id']}: seeded={truth['seeded']} checksFailed={truth['checksFailed']} "
                  f"hidden={truth['hidden']['passed']}/{truth['hidden']['total']} "
                  f"failing={truth['hidden']['failed'][:4]} diff={truth['diffBytes']}B")
    elif args.command == "run":
        run_reviews(args.model, args.effort, args.reps, args.jobs, args.conditions.split(","), args.case)
    elif args.command == "grade":
        grade(jobs=args.jobs)
    else:
        text = report()
        if args.out:
            args.out.write_text(text)
        print(text)


if __name__ == "__main__":
    main()
