"""Run a two-session task: one first session, then the second request under several memory modes.

Usage: run_carryover.py <run_name> [--modes wiped,fresh,oracle] [--model ...] [--effort ...] [--timeout 2700]
                        [--dry-run]

The run must be prepared by setup_arm.py with a two-session task. The first session runs once;
its project is snapshotted, and every mode restores that snapshot at the same path before its
second session, so the modes are paired on one first session. Modes:

- wiped:  new session; the project keeps its code, tests and README, but everything the
          workflow kept about the first session is reset: .visp/ goes back to its state before
          the first session (no features, prompt log or memory notes), and CLAUDE.md and
          AGENTS.md back to the scaffold. Git history is kept; carriers.json records whether
          the first session committed VISP records.
- fresh:  new session on the project exactly as the first session left it.
- oracle: like fresh, with the first session's conventions restated in the request.
- resume: the second request continues the first session's conversation.
- noisy:  like memory, with the store first holding the earlier feature requests in the
          task's noise.md (unrelated features and near-miss traps), recorded as VISP would;
          Visp Memory's keyword selection alone chooses what the request carries.
- gated:  noisy, with the reviewer's model choosing among the candidates.
- intermediate: a session between the first and second, with the task's intermediate.md as its
          request (it raises the item limit), run as a real worker session of the arm like the
          other two, then verified (verify_intermediate); the second session follows on the
          project as that session left it. The run is invalid, and the second session not run,
          if the intermediate session ends in a CLI error or the raised limit does not hold.
          Score with the task's -raised variant.
- outdated, outdated-kw: intermediate, with the store holding the ten noisy features, the first
          request and, after the session, the intermediate one, recorded in that order as VISP
          would have (Visp Memory's model choice, keyword choice).
- recall, recall-outdated: gated and outdated with VISP's own store (no memory.service): the
          same earlier requests are written to .visp/state/request-history.json, and the
          reviewer's model chooses among every recorded note. VISP records the intermediate
          request itself in its session.
- memory: like fresh, with Visp Memory as VISP's long-term store (`memory.service`, set up
          before the second session; needs $VISP_BENCH_RUNS/visp-memory-venv and a VISP build
          that supports it).

Claude Code's auto memory is off unless the arm is bare-automemory (arm.json "memory": "auto"; see
run_claude.py). Its directory is <run>/memory: session 1 fills it, memory.tar keeps it, and every
mode starts from that copy, so the modes are paired on one first session and never share memory.

An intermediate session that ends in a CLI error (not a usage limit), or whose raised limit does
not hold, is run again once from the first session's snapshot (MAX_INTERMEDIATE_RERUNS). The failed
attempt is kept as intermediate-attempt<k>.json; the count is in intermediate.json ("reruns") and in
the second session's result.json ("intermediateReruns"). A second failure makes the run invalid as before.

A VISP arm's second result.json also has "recall": whether the session ran `visp feature`, whether
the store holds a note that mentions the item cap, and whether recall returned memories (recall_facts).

Writes session1/ (result.json, carriers.json, hidden-stage1.json, snapshot.tar, memory.tar,
visp-scaffold.tar) and <mode>/ (result.json, intermediate.json for the intermediate session, memory/
when auto memory is on, the finished project) under the run. Score each mode with
score.py <task> <run>/<mode> after the batch. --dry-run prints the sessions each mode would run.
"""
import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile

from common import RUNS
from run_claude import memory_directory, memory_setting, run_session
from runfacts import mark_if_invalid

BENCH = pathlib.Path(__file__).resolve().parent
MODES = ("wiped", "fresh", "oracle", "resume", "memory", "noisy", "gated",
         "intermediate", "outdated", "outdated-kw", "recall", "recall-outdated")
# Modes with a session of the intermediate request between the first and the second.
INTERMEDIATE_MODES = ("intermediate", "outdated", "outdated-kw", "recall-outdated")
MEMORY = RUNS / "visp-memory-venv" / "bin" / "visp-memory"
NOTES = ("CLAUDE.md", "AGENTS.md")
# Where each first-session convention could have been written down. C1 and C2 are also visible
# in the code the first session wrote; C3 and C4 are not, until the second session needs them.
MARKERS = {
    "C3 money": re.compile(r"Cents"),
    "C4 deletion": re.compile(r"\bgone\b|hard[- ]delet", re.IGNORECASE),
}
SKIP = {".git", "node_modules", "__pycache__", ".pytest_cache"}
# At most one automatic rerun of a failed intermediate session; a second failure makes the run invalid.
MAX_INTERMEDIATE_RERUNS = 1
# A recorded note states the item cap when it names the number: 10000 (session 1) or 50000 (intermediate).
CAP_VALUE = re.compile(r"\b(10|50)[,_ ]?000\b")


def git(project, *argv):
    return subprocess.run(["git", *argv], cwd=project, capture_output=True, text=True).stdout


def mentions(project):
    """Count each convention's markers per file, outside version control and caches."""
    counts = {}
    for path in sorted(project.rglob("*")):
        if not path.is_file() or SKIP.intersection(path.relative_to(project).parts):
            continue
        try:
            text = path.read_text()
        except (UnicodeDecodeError, OSError):
            continue
        for name, pattern in MARKERS.items():
            counts[name, str(path.relative_to(project))] = len(pattern.findall(text))
    return counts


def carriers(before, after):
    """Files where the first session added mentions of a convention the code does not yet show."""
    found = {name: [] for name in MARKERS}
    for (name, path), count in after.items():
        if count > before.get((name, path), 0):
            found[name].append(path)
    return found


def restore(project, snapshot):
    shutil.rmtree(project)
    project.mkdir()
    with tarfile.open(snapshot) as archive:
        archive.extractall(project)


def wipe_notes(project, workflow_state):
    """Reset what the workflow kept about earlier sessions, keeping code, tests and README."""
    shutil.rmtree(project / ".visp", ignore_errors=True)
    if workflow_state.is_file():
        with tarfile.open(workflow_state) as archive:
            archive.extractall(project)
    scaffold = git(project, "rev-list", "--max-parents=0", "HEAD").strip()
    for name in NOTES:
        original = subprocess.run(["git", "show", f"{scaffold}:{name}"], cwd=project,
                                  capture_output=True, text=True)
        if original.returncode == 0:
            (project / name).write_text(original.stdout)
        else:
            (project / name).unlink(missing_ok=True)


def enable_memory(project, select="model"):
    """Visp Memory with its defaults (SQLite, keyword recall); only its own files are committed."""
    subprocess.run([str(MEMORY), "init", "--no-mine"], cwd=project, check=True, capture_output=True)
    config = (project / "visp.yml").read_text()
    (project / "visp.yml").write_text(
        config.replace("memory:\n", f"memory:\n  service:\n    command: {MEMORY}\n    select: {select}\n", 1))
    git(project, "add", "visp.yml", ".gitignore", "visp-memory.yaml")
    git(project, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "Enable Visp Memory")


def request_chunks(request):
    """Paragraphs and list items, as VISP records a request (src/memory/memory-service.ts)."""
    chunks = []
    for block in re.split(r"\n\s*\n", request):
        items = [line.strip() for line in block.split("\n") if re.match(r"^\s*(?:[-*•]|\d+[.)])\s+\S", line)]
        chunks += items or [re.sub(r"\s+", " ", block).strip()]
    return [chunk[:1000] for chunk in chunks if len(chunk) >= 20]


def seed_noise(project, task):
    """Earlier feature requests, recorded in Visp Memory the way VISP records them."""
    noise = (BENCH / "tasks" / task / "noise.md").read_text()
    for index, request in enumerate(noise.split("\n---\n"), start=1):
        goal = request.strip().splitlines()[0].removeprefix("Feature:").strip()
        body = request.strip().split("\n", 1)[1]
        for chunk in request_chunks(body):
            subprocess.run([str(MEMORY), "decision", chunk, f"Stated by the user for feature n{index:02d}: {goal}"],
                           cwd=project, check=True, capture_output=True)


def record_request(project, request, label, goal):
    for chunk in request_chunks(request):
        subprocess.run([str(MEMORY), "decision", chunk, f"Stated by the user for feature {label}: {goal}"],
                       cwd=project, check=True, capture_output=True)


def noise_requests(task):
    for index, request in enumerate((BENCH / "tasks" / task / "noise.md").read_text().split("\n---\n"), start=1):
        yield f"n{index:02d}", request.strip().splitlines()[0].removeprefix("Feature:").strip(), request.strip().split("\n", 1)[1]


def seed_history(project, requests):
    """Earlier feature requests in VISP's own store, oldest first, as VISP records them."""
    state = project / ".visp" / "state" / "request-history.json"
    state.parent.mkdir(parents=True, exist_ok=True)
    history = json.loads(state.read_text()) if state.exists() else {"version": 1, "requests": []}
    history["requests"] += [{"feature": label, "goal": goal, "notes": request_chunks(body)}
                            for label, goal, body in requests]
    state.write_text(json.dumps(history, indent=2) + "\n")


def first_feature(project):
    first = next((project / ".visp" / "features").iterdir())
    intent = json.loads((first / "intent.json").read_text())
    return first.name, intent["goal"], intent["sourceBrief"]


class IntermediateFailed(RuntimeError):
    pass


def verify_intermediate(project, mode):
    """The raised limit must hold before the second session, or the mode would be confounded."""
    scored = subprocess.run([sys.executable, str(BENCH / "tasks" / "archive-carryover-raised" / "hidden_test.py"),
                             str(project), "--stage", "1"], capture_output=True, text=True, timeout=600)
    try:
        results = json.loads(scored.stdout)["results"]
    except (ValueError, KeyError):
        raise IntermediateFailed(f"{mode}: the raised-limit check produced no result") from None
    limit = [r for r in results if r["name"].startswith(("create above 50000", "create exactly 50000"))]
    if len(limit) != 2 or not all(r["passed"] for r in limit):
        raise IntermediateFailed(f"{mode}: the intermediate session did not raise the item limit to 50000: {limit}")


def seed_first_request(project, remember):
    """The first request in the store the mode uses, as VISP would have recorded it."""
    if remember == "builtin":
        seed_history(project, [first_feature(project)])
    elif remember:
        first = next((project / ".visp" / "features").iterdir())
        intent = json.loads((first / "intent.json").read_text())
        record_request(project, intent["sourceBrief"], first.name, intent["goal"])
        state = project / ".visp" / "state" / "memory-service.json"
        state.parent.mkdir(parents=True, exist_ok=True)
        state.write_text(json.dumps({"version": 1, "recorded": [first.name]}))


def record_intermediate(project, task):
    """The intermediate request in Visp Memory after its session (VISP no longer writes there)."""
    request = (BENCH / "tasks" / task / "intermediate.md").read_text()
    goal = request.strip().splitlines()[0].removeprefix("Feature:").strip()
    record_request(project, request.strip().split("\n", 1)[1], "n11", goal)


def refresh_install(project, arm):
    """A kept first session carries the old build's hooks, which a newer build refuses."""
    env = {**os.environ, "PATH": f"{arm['shim']}:{os.environ['PATH']}"}
    subprocess.run(["visp", "install", "--harness", "claude-code", "--json"], cwd=project, env=env,
                   check=True, capture_output=True)
    installed = [path for path in (".claude", ".visp/hooks", "CLAUDE.md", "AGENTS.md", ".mcp.json")
                 if (project / path).exists()]
    git(project, "add", "-A", *installed)
    git(project, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "Refresh VISP install")


def read_prompt(run, name, arm):
    """A prepared request; with --build, its `export PATH=<shim>` names the new build's shim."""
    prompt = (run / name).read_text()
    if arm.get("oldShim") and arm["oldShim"] != arm["shim"]:
        prompt = prompt.replace(f"export PATH={arm['oldShim']}:", f"export PATH={arm['shim']}:")
    return prompt


def second_prompt(run, mode, arm):
    return read_prompt(run, "prompt2-oracle.txt" if mode == "oracle" else "prompt2.txt", arm)


def batch_mode(task):
    """The mode batch.py runs for a two-session task: the intermediate session for a -raised task."""
    return "intermediate" if task.endswith("-raised") else "fresh"


def planned_sessions(mode):
    """The worker sessions a mode runs after the first, in order."""
    return ["intermediate request", "second request"] if mode in INTERMEDIATE_MODES else ["second request"]


def check_plan(run, arm, modes):
    """Fail before the first session, not after it, when a mode cannot run on this prepared run."""
    if set(modes) & set(INTERMEDIATE_MODES) and not (run / "prompt-intermediate.txt").is_file():
        raise SystemExit(f"{run.name} has no prompt-intermediate.txt: setup_arm.py writes it for a task "
                         f"with intermediate.md, and {arm['task']} has none")


def snapshot_memory(project, path):
    """The run's auto memory after the first session; an empty archive when there is none."""
    with tarfile.open(path, "w") as archive:
        if memory_directory(project).is_dir():
            archive.add(memory_directory(project), arcname="memory")


def restore_memory(project, path):
    """The run's auto memory as the first session left it, for the next mode."""
    shutil.rmtree(memory_directory(project), ignore_errors=True)
    if path.is_file():
        with tarfile.open(path) as archive:
            archive.extractall(memory_directory(project).parent)


def keep_memory(project, out):
    """Move a mode's auto memory beside its project, if the arm has any."""
    if memory_directory(project).is_dir():
        shutil.move(str(memory_directory(project)), out / "memory")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("run")
    parser.add_argument("--modes", default="wiped,fresh,oracle")
    parser.add_argument("--model", help="default: the worker of the arm's preset")
    parser.add_argument("--effort", help="default: the worker effort of the arm's preset")
    parser.add_argument("--timeout", type=int, default=2700)
    parser.add_argument("--reuse", metavar="LABEL",
                        help="reuse the run's first session and write each mode to <mode>-LABEL")
    parser.add_argument("--build", help="with --reuse, run the second sessions on this VISP build")
    parser.add_argument("--dry-run", action="store_true", help="print the sessions each mode would run; run none")
    args = parser.parse_args()
    modes = args.modes.split(",")
    unknown = set(modes) - set(MODES)
    if unknown:
        raise SystemExit(f"unknown modes: {sorted(unknown)}")

    # Visp Memory without an embedding provider; only the memory mode calls it.
    os.environ.setdefault("VISP_MEMORY_EMBEDDING_PROVIDER", "noop")
    run = RUNS / "runs" / args.run
    project = run / "project"
    arm = json.loads((run / "arm.json").read_text())
    if args.build:
        # The prepared prompts name the old shim; the second sessions' copies name the new one.
        arm["oldShim"], arm["shim"] = arm.get("shim"), str(RUNS / "shims" / args.build)
    first = run / "session1"
    check_plan(run, arm, modes)
    if args.dry_run:
        print(json.dumps({"run": args.run, "arm": arm["arm"], "autoMemory": memory_setting(arm),
                          "first": [] if args.reuse else ["first request"],
                          "modes": {mode: planned_sessions(mode) for mode in modes}}))
        return
    if args.reuse:
        run_modes(args, run, project, arm, first, json.loads((first / "result.json").read_text()), modes)
        return
    first.mkdir(exist_ok=False)

    before = mentions(project)
    # The workflow's own state before the first session, restored by the wiped mode.
    workflow_state = first / "visp-scaffold.tar"
    if (project / ".visp").is_dir():
        with tarfile.open(workflow_state, "w") as archive:
            archive.add(project / ".visp", arcname=".visp")
    result = run_session(project, arm, (run / "prompt.txt").read_text(), args.model, args.timeout,
                         effort=args.effort)
    (first / "result.json").write_text(json.dumps({"run": args.run, "session": 1, **result}, indent=2))
    carried = carriers(before, mentions(project))
    carried["committed VISP records"] = sorted(set(
        git(project, "log", "--format=", "--name-only", "--", ".visp/features", ".visp/memory").split()))
    (first / "carriers.json").write_text(json.dumps(carried, indent=2))
    scored = subprocess.run([sys.executable, str(BENCH / "tasks" / arm["task"] / "hidden_test.py"),
                             str(project), "--stage", "1"], capture_output=True, text=True, timeout=600)
    (first / "hidden-stage1.json").write_text(scored.stdout)
    try:
        stage1 = json.loads(scored.stdout)
        stage1 = f"{stage1['passed']}/{stage1['total']}"
    except (ValueError, KeyError):
        stage1 = "no result"
    snapshot = first / "snapshot.tar"
    with tarfile.open(snapshot, "w") as archive:
        for path in project.iterdir():
            archive.add(path, arcname=path.name)
    snapshot_memory(project, first / "memory.tar")
    print(json.dumps({"run": args.run, "session": 1, "seconds": result["seconds"],
                      "timedOut": result["timedOut"], "stage1": stage1, "carriers": carried}))

    run_modes(args, run, project, arm, first, result, modes)


def prepare_mode(args, run, project, arm, first, mode):
    """The project and memory as a mode starts: session 1's snapshot, then the mode's own store."""
    restore(project, first / "snapshot.tar")
    restore_memory(project, first / "memory.tar")
    if args.build:
        refresh_install(project, arm)
    if mode == "wiped":
        wipe_notes(project, first / "visp-scaffold.tar")
    if mode in ("memory", "noisy", "gated", "outdated", "outdated-kw"):
        enable_memory(project, "keyword" if mode in ("noisy", "outdated-kw") else "model")
    if mode in ("noisy", "gated", "outdated", "outdated-kw"):
        seed_noise(project, arm["task"])
    if mode.startswith("recall"):
        seed_history(project, noise_requests(arm["task"]))


def intermediate_session(args, run, project, arm, mode, out, reruns):
    """The intermediate session, recorded in out/intermediate.json, and its checks.

    Returns (problem, invalid), problem None when the session held. A run that is invalid already
    (a usage limit, a worker failure) is reported with its record; an unverified raised limit is
    written to invalid.json here.
    """
    seed_first_request(project, "builtin" if mode == "recall-outdated" else mode != "intermediate")
    middle = run_session(project, arm, read_prompt(run, "prompt-intermediate.txt", arm), args.model,
                         args.timeout, None, args.effort)
    (out / "intermediate.json").write_text(json.dumps(
        {"run": args.run, "mode": mode, "reruns": reruns, **middle}, indent=2))
    if mode in ("outdated", "outdated-kw"):
        record_intermediate(project, arm["task"])
    invalid = mark_if_invalid(run)
    if invalid:
        return f"{mode}: the run is invalid ({invalid['reason']}: {invalid['source']})", invalid
    try:
        verify_intermediate(project, mode)
    except IntermediateFailed as failure:
        invalid = {"reason": "intermediate feature not verified", "source": f"{mode} intermediate session",
                   "match": str(failure)}
        (run / "invalid.json").write_text(json.dumps(invalid, indent=2))
        return str(failure), invalid
    return None, None


def rerunnable(invalid):
    """Whether running the intermediate session again could help: not a usage limit, not session 1's failure."""
    return invalid["reason"] != "usage limit" and not str(invalid.get("source", "")).startswith("session1")


def run_intermediate(args, run, project, arm, first, mode, out):
    """The intermediate session, run again at most MAX_INTERMEDIATE_RERUNS times when it failed.

    Returns (problem, reruns). Every attempt starts from session 1's snapshot (prepare_mode), so a
    failed one leaves only its record, intermediate-attempt<k>.json, and its cost in
    claude-calls.jsonl. intermediate.json is the last attempt's, with the rerun count.
    """
    reruns = 0
    while True:
        problem, invalid = intermediate_session(args, run, project, arm, mode, out, reruns)
        if not problem or reruns >= MAX_INTERMEDIATE_RERUNS or not rerunnable(invalid):
            return problem, reruns
        reruns += 1
        record = json.loads((out / "intermediate.json").read_text())
        (out / f"intermediate-attempt{reruns}.json").write_text(json.dumps({**record, "problem": problem}, indent=2))
        (out / "intermediate.json").unlink()
        (run / "invalid.json").unlink(missing_ok=True)
        print(json.dumps({"run": args.run, "mode": mode, "intermediateRerun": reruns, "because": problem}))
        prepare_mode(args, run, project, arm, first, mode)


def feature_ids(project):
    directory = project / ".visp" / "features"
    return sorted(path.name for path in directory.iterdir()) if directory.is_dir() else []


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def strings(value):
    """Every string in parsed JSON."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)


def cap_values(texts):
    """The cap values (10000, 50000) the texts name."""
    return sorted({f"{match.group(1)}000" for text in texts for match in CAP_VALUE.finditer(text)})


def recall_facts(project, features_before):
    """What VISP's recall did in the second session, from the project's state (nothing in the transcript is read).

    - ranFeature: the session started a feature (`visp feature` adds a directory to .visp/features
      beyond the ones in features_before).
    - earlierBriefHoldsCap: an earlier feature's recorded request names the cap. VISP keeps it
      whether or not recall is on, so it separates "never recorded" from "recorded, not recalled".
    - storeNotes, storeHoldsCap: the notes in .visp/state/request-history.json (and in
      .visp/state/project-memory.json if a build keeps one). Recall records the earlier requests
      there when it runs, so `memory.recall: false` leaves it empty.
    - recallReturned, recallMemories, recallMentionsCap: the new features' project-memory.json
      (develop writes it only when the gate returned memories). A reviewer-model call that fails
      returns none without a record, so "returned none" cannot tell a failed call from a judgement
      that nothing applied.
    """
    state = project / ".visp" / "state"
    features = project / ".visp" / "features"
    new = [feature for feature in feature_ids(project) if feature not in features_before]
    briefs = [(read_json(features / feature / "intent.json") or {}).get("sourceBrief") or ""
              for feature in features_before]
    notes = list(strings([read_json(state / "request-history.json"), read_json(state / "project-memory.json")]))
    history = [note for request in (read_json(state / "request-history.json") or {}).get("requests", [])
               for note in request.get("notes", [])]
    memories = [text for feature in new
                for text in strings((read_json(features / feature / "project-memory.json") or {}).get("memories"))]
    return {"ranFeature": bool(new), "newFeatures": new,
            "earlierBriefHoldsCap": bool(cap_values(briefs)),
            "storeNotes": len(history), "storeHoldsCap": bool(cap_values(notes)), "storeCapValues": cap_values(notes),
            "recallReturned": bool(memories), "recallMemories": len(memories),
            "recallMentionsCap": bool(cap_values(memories)), "recallCapValues": cap_values(memories)}


def run_modes(args, run, project, arm, first, result, modes):
    project.mkdir(exist_ok=True)
    failed = []
    for mode in modes:
        resume = result["sessionId"] if mode == "resume" else None
        if mode == "resume" and not resume:
            # Checked before restoring, so a skipped mode leaves no restored tree behind.
            print(json.dumps({"run": args.run, "mode": mode, "skipped": "first session has no id"}))
            continue
        prepare_mode(args, run, project, arm, first, mode)
        out = run / (f"{mode}-{args.reuse}" if args.reuse else mode)
        out.mkdir()
        reruns = None
        if mode in INTERMEDIATE_MODES:
            problem, reruns = run_intermediate(args, run, project, arm, first, mode, out)
            if problem:
                # The run is invalid: the second session would not measure carryover. Keep the project to inspect.
                failed.append(problem)
                print(json.dumps({"run": args.run, "mode": mode, "error": problem, "intermediateReruns": reruns}))
                keep_memory(project, out)
                shutil.move(str(project), out / "project")
                project.mkdir()
                continue
        features_before = feature_ids(project)
        second = run_session(project, arm, second_prompt(run, mode, arm), args.model, args.timeout, resume,
                             args.effort)
        extra = {} if reruns is None else {"intermediateReruns": reruns}
        if arm["arm"].startswith("visp"):
            extra["recall"] = recall_facts(project, features_before)
        (out / "result.json").write_text(json.dumps({"run": args.run, "mode": mode, **second, **extra}, indent=2))
        keep_memory(project, out)
        shutil.move(str(project), out / "project")
        project.mkdir()
        print(json.dumps({"run": args.run, "mode": mode, "seconds": second["seconds"],
                          "timedOut": second["timedOut"], "isError": second["isError"]}))
    # Empty after a finished mode; still session 1's tree if every mode was skipped (it is in the snapshot).
    shutil.rmtree(project)
    if failed:
        raise SystemExit("modes not run:\n" + "\n".join(failed))


if __name__ == "__main__":
    main()
