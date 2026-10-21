"""Run ChainSWE chains: real repository issues in date order, each a fresh worker session.

Usage:
  chainswe.py export <parquet dir>          the dataset's splits as $VISP_BENCH_RUNS/chainswe/chains.jsonl
  chainswe.py list [--repo django/django]   chains and their labels
  chainswe.py run --batch <name> --chains <label,...> --arms bare,visp:<build>+gate  (controls: gold, none)
                  [--reps 1] [--jobs 4] [--preset quality-2026-10] [--timeout 2700] [--rerun-invalid] [--dry-run]
  chainswe.py score <run> [--step k]        score a step again (default: every finished step)
  chainswe.py before --batch <name>         score finished steps' before-states that have none
  chainswe.py report --batch <name> [--runs] [--md FILE]

ChainSWE (arXiv 2607.02606; data https://huggingface.co/datasets/C-lister/ChainSWE, MIT) orders
SWE-bench-family issues of one repository by date. Each row is a chain with one base commit and
one Docker image; `bug_fixes` holds the ordered issues with their gold and test patches, test
command, FAIL_TO_PASS and PASS_TO_PASS tests. `export` needs pyarrow; nothing else does.

A run starts from the chain image's /testbed copied into a fresh git repository (tag swe-base),
with the arm installed as setup_arm.py installs it and a ./swe-test client for the local test
service (swe_env/testsvc.py, which must be running). Step k is a fresh run_claude.py session
given issue k, on the project exactly as step k-1 left it, as ChainSWE's sequential mode: the
worker never sees a hidden test, and after each session the runner commits everything as the
user, as ChainSWE does. A `python`, `python3` and `pytest` on the worker's PATH send test runs to
the image (swe_env/python), so a test command anyone runs, VISP's regression gate included, sees
the project's dependencies.

After step k, a fresh container from the image gets the worker's whole change since swe-base
(without the bench scaffold, the files test patches 1..k touch, and setup.py, tox.ini,
pyproject.toml and uv.lock, which ChainSWE also drops), then test patches 1..k (without their
changes to those files: the image already set up the environment), and runs each
distinct test command of issues 1..k with no network (the dataset's `pip install -e .` prefix is
dropped: the image already has the project installed in place, and pip needs the network). Every
listed test becomes a check named by its canonical id whose step is the first issue that lists
it; chains.py then counts regressions: a check of an earlier issue that passed after step k-1 and
fails after step k, unless issue k lists it in FAIL_TO_PASS (its test patch rewrote that test).
The same tests are also scored on the change as step k-1 left it (before.json): a test that passes
there and fails after step k is one step k broke, the regression gate's own question. Issue k is resolved at step k when all its FAIL_TO_PASS and PASS_TO_PASS tests
pass; ChainSWE's strict sequential score also needs every earlier issue still resolved and the
step before strictly resolved. ChainSWE's own validator further fails an issue when any other test
in its command fails or the bug was already fixed before its step; neither is applied here.

Writes per run: arm.json, prompt-step<k>.txt, step<k>/{result.json, hidden.json, before.json,
step.patch, model.patch}, baseline.json (empty: no check exists before issue 1), chain.json once finished,
claude-calls.jsonl, and visp-state.tgz; the working copy is removed at the end.
"""
import argparse
import concurrent.futures
import json
import os
import pathlib
import re
import shlex
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import time

from chains import summarize
from common import RUNS, stop_recorded
from presets import critic_yaml, preset, visp_build, workflow_yaml
from run_claude import run_session
from runfacts import mark_if_invalid
from swe_tests import PRIORITY, canonical_test_id, members, parse_test_results, passes

BENCH = pathlib.Path(__file__).resolve().parent
DATA = RUNS / "chainswe"
DOCKER = {**os.environ, "DOCKER_HOST": os.environ.get("DOCKER_HOST", "unix:///var/run/docker.sock")}
PORT = os.environ.get("SWE_TEST_PORT", "8766")
BASE_TAG = "swe-base"
# Workflow scaffolding and the test client: never part of the scored change.
SCAFFOLD = [".visp", ".specify", ".claude", ".codex", ".agents", "_bmad", "_bmad-output", "specs", "acceptance",
            "AGENTS.md", "AGENTS.visp.md", "VISP.commands.md", "CLAUDE.md", "visp.yml", "swe-test"]
# Environment files ChainSWE drops from a model patch.
ENV_FILES = ["pyproject.toml", "tox.ini", "setup.py", "uv.lock"]
PIP_PREFIX = re.compile(r"\{\s*python -m pip install -e [^\n]*\n\}\s*&&\s*")
REPOS = {"django/django": "dj", "sphinx-doc/sphinx": "sp", "pylint-dev/pylint": "pl", "pytest-dev/pytest": "pt",
         "pydata/xarray": "xa", "sympy/sympy": "sy", "matplotlib/matplotlib": "mp"}
EXAMPLES = {"django/django": "./tests/runtests.py --parallel 1 <app_label or test path>"}
TEST_TIMEOUT = 900
log_lock, base_lock = threading.Lock(), threading.Lock()


def sh(argv, cwd=None, env=None, timeout=1800, stdin=None):
    done = subprocess.run(argv, cwd=cwd, env=env or os.environ, input=stdin, capture_output=True, text=True,
                          timeout=timeout)
    if done.returncode:
        raise RuntimeError(f"{argv[:4]}: {(done.stderr or done.stdout)[-1500:]}")
    return done.stdout


def label_of(chain):
    prefix = REPOS.get(chain["repo"]) or re.sub(r"[^a-z0-9]", "", chain["repo"].split("/")[-1].lower())[:4]
    first = chain["bug_fixes"][0]["swebench_instance_id"].rsplit("-", 1)[-1][:10]
    return f"{prefix}{first}-{len(chain['bug_fixes'])}"


# ---------------------------------------------------------------- data


def export(parquet_dir):
    import pyarrow.parquet as pq  # only this step reads parquet

    seen = {}
    for split in ("unique", "len_3", "len_4", "len_5"):
        path = pathlib.Path(parquet_dir) / f"{split}.parquet"
        if not path.exists():
            continue
        for row in pq.read_table(path).to_pylist():
            row["label"] = label_of(row)
            seen.setdefault(row["continuous_id"], row)
    labels = [row["label"] for row in seen.values()]
    for row in seen.values():  # two chains with one first issue and length: add the id's suffix
        if labels.count(row["label"]) > 1:
            row["label"] += "-" + row["continuous_id"].rsplit("_", 1)[-1][:4]
    DATA.mkdir(parents=True, exist_ok=True)
    with (DATA / "chains.jsonl").open("w") as handle:
        for row in seen.values():
            handle.write(json.dumps(row, default=str) + "\n")
    print(f"{len(seen)} chains -> {DATA / 'chains.jsonl'}")


def load_chains():
    path = DATA / "chains.jsonl"
    if not path.exists():
        raise SystemExit(f"no {path}; run `chainswe.py export <parquet dir>` first")
    chains = [json.loads(line) for line in path.open()]
    return {chain["label"]: chain for chain in chains}


def find(chains, key):
    for chain in chains.values():
        if key in (chain["label"], chain["continuous_id"]):
            return chain
    raise SystemExit(f"unknown chain {key}")


def patch_files(patch):
    return re.findall(r"^diff --git a/(\S+) b/", patch or "", re.M)


# ---------------------------------------------------------------- setup


def base_copy(chain):
    """The chain image's /testbed at the chain's base commit, as a fresh git repository (shared, read-only)."""
    target = DATA / "base" / chain["label"]
    with base_lock:
        if (target / ".git" / "refs" / "tags" / BASE_TAG).exists():
            return target
        shutil.rmtree(target, ignore_errors=True)
        target.parent.mkdir(parents=True, exist_ok=True)
        cid = sh(["docker", "create", chain["docker_image"]], env=DOCKER).strip()
        try:
            sh(["docker", "cp", f"{cid}:/testbed", str(target)], env=DOCKER)
        finally:
            sh(["docker", "rm", cid], env=DOCKER)
        shutil.rmtree(target / ".git")
        for argv in (["git", "init", "-q", "-b", "main"], ["git", "config", "user.name", "Bench"],
                     ["git", "config", "user.email", "bench@localhost"], ["git", "add", "-A"],
                     ["git", "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "Repository at the chain's base commit"],
                     ["git", "tag", BASE_TAG]):
            sh(argv, cwd=target)
        return target


def install_arm(root, arm, settings, preset_name, env):
    """The arm's workflow, installed as setup_arm.py does; returns (prompt line, VISP shim or None)."""
    if arm == "bare":
        return "Use ordinary coding: write the code and tests directly.", None
    if arm in ("gold", "none"):  # no worker: each step applies the gold patch, or nothing (controls)
        return "", None
    if not arm.startswith("visp:"):
        raise SystemExit(f"unsupported arm {arm}: chainswe runs bare and visp:<build>[+mode]")
    build, mode = visp_build(arm)
    shim = RUNS / "shims" / build
    env["PATH"] = f"{shim}:{env['PATH']}"
    sh(["visp", "init", "--harness", "claude-code", "--json"], cwd=root, env=env)
    config = (root / "visp.yml").read_text()
    critic = critic_yaml(settings["critic"])
    config = config.replace("critic:\n  harness: claude-code", critic)
    if preset_name != "default" and critic not in config:
        raise SystemExit(f"setup failed: visp.yml has no critic block to replace for preset {preset_name}")
    (root / "visp.yml").write_text(workflow_yaml(config, mode))
    sh(["visp", "install", "--harness", "claude-code", "--json"], cwd=root, env=env)
    return ("This project uses VISP. Read CLAUDE.md and the VISP instructions it references before starting, "
            f"and follow them. Run every command with `export PATH={shim}:$PATH` first so `visp` is the "
            "project's build."), str(shim)


def install_python(run):
    """The worker's python, python3 and pytest: test runs go to the image (swe_env/python)."""
    real = shutil.which("python3", path="/usr/bin:/bin") or shutil.which("python3")
    directory = run / "bin"
    directory.mkdir()
    shim = directory / "python"
    shim.write_text((BENCH / "swe_env" / "python").read_text().replace("__REAL_PYTHON__", real))
    shim.chmod(0o755)
    for name in ("python3", "pytest"):
        (directory / name).symlink_to("python")
    return str(directory)


def prompt(chain, bug, workflow, root):
    example = EXAMPLES.get(chain["repo"], "python -m pytest -x tests/test_<area>.py")
    common = (
        f"Your project directory is {root}. Run every shell command from that directory "
        f"(start each command with `cd {root} && `) and create or edit files only inside it. "
        "Do not read other directories. No dependency downloads or network APIs. The local Python "
        "does not have this project's dependencies: run the project's tests with `./swe-test <command>`, "
        "which applies your current changes to the repository inside its prepared environment and runs "
        f"<command> from the repository root (for example `./swe-test {example}`). "
        "Do not ask questions: make reasonable assumptions and continue. Do not delegate to other "
        "agents. Fix the issue, run the relevant tests, and finish with a short report of what you "
        "actually verified.")
    issue = (f"Resolve this GitHub issue in the {chain['repo']} repository (its source is in the project "
             "directory). Change the project's source so the reported problem is fixed. Hidden tests will "
             "check the fix, and the existing tests must keep passing.\n\n" + bug["problem_statement"])
    return f"{workflow}\n\n{common}\n\nTask:\n\n{issue}"


def setup(run, chain, arm, preset_name):
    settings = preset(preset_name)
    root = run / "project"
    run.mkdir(parents=True)
    sh(["git", "clone", "-q", "--local", str(base_copy(chain)), str(root)])
    for argv in (["git", "config", "user.name", "Bench"], ["git", "config", "user.email", "bench@localhost"],
                 ["git", "remote", "remove", "origin"]):
        sh(argv, cwd=root)
    env = dict(os.environ)
    workflow, shim = install_arm(root, arm, settings, preset_name, env)
    client = (BENCH / "swe_env" / "swe-test").read_text().replace("__IMAGE__", chain["docker_image"]).replace(
        "__EXCLUDE__", json.dumps(SCAFFOLD)).replace("__PORT__", PORT)
    (root / "swe-test").write_text(client)
    (root / "swe-test").chmod(0o755)
    sh(["git", "add", "-A"], cwd=root)
    sh(["git", "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "Benchmark scaffold"], cwd=root)
    for number, bug in enumerate(chain["bug_fixes"], start=1):
        (run / f"prompt-step{number}.txt").write_text(prompt(chain, bug, workflow, root))
    (run / "arm.json").write_text(json.dumps({
        "task": chain["label"], "chain": chain["continuous_id"], "image": chain["docker_image"], "arm": arm,
        "shim": shim, "extraPath": [install_python(run)], "skills": [], "preset": preset_name, "settings": settings}))


# ---------------------------------------------------------------- scoring


def change(root, exclude=()):
    """The working tree's change since swe-base (new files included), without the scaffold and `exclude`."""
    spec = ["--", ".", *[f":(exclude){path}" for path in [*SCAFFOLD, *exclude]]]
    with tempfile.TemporaryDirectory() as tmp:
        env = {**os.environ, "GIT_INDEX_FILE": os.path.join(tmp, "index")}
        sh(["git", "read-tree", BASE_TAG], cwd=root, env=env)
        sh(["git", "add", "-A", *spec], cwd=root, env=env)
        return sh(["git", "diff", "--cached", "--binary", BASE_TAG, *spec], cwd=root, env=env)


def checks(chain, step):
    """{canonical test id: (first issue listing it, kind)} for issues 1..step, with each issue's tests."""
    found, per_bug = {}, []
    for number, bug in enumerate(chain["bug_fixes"][:step], start=1):
        listed = {"FAIL_TO_PASS": [], "PASS_TO_PASS": []}
        for kind in listed:
            for test in bug[kind]:
                key = canonical_test_id(test)
                if key not in listed[kind]:
                    listed[kind].append(key)
                found.setdefault(key, (number, kind))
        per_bug.append(listed)
    return found, per_bug


class Container:
    """One scoring container from the chain image, removed on exit."""

    def __init__(self, image):
        self.image = image

    def __enter__(self):
        self.id = sh(["docker", "run", "-d", "--network", "none", "--cpus", "2", "--memory", "6g",
                      "--entrypoint", "tail", self.image, "-f", "/dev/null"], env=DOCKER).strip()
        return self

    def write(self, path, text):
        subprocess.run(["docker", "exec", "-i", self.id, "bash", "-c", f"cat > {shlex.quote(path)}"], input=text,
                       env=DOCKER, capture_output=True, text=True, check=True)

    def run(self, command, timeout=TEST_TIMEOUT):
        try:
            done = subprocess.run(["docker", "exec", "-w", "/testbed", self.id, "bash", "-c", command], env=DOCKER,
                                  capture_output=True, text=True, timeout=timeout + 60)
            return done.returncode, done.stdout + "\n" + done.stderr
        except subprocess.TimeoutExpired as error:
            return 124, str(error.stdout or "")[-2000:] + "\nTIMEOUT"

    def __exit__(self, *_):
        subprocess.run(["docker", "rm", "-f", self.id], env=DOCKER, capture_output=True)


def touched_by_tests(chain, step):
    return sorted({path for bug in chain["bug_fixes"][:step] for path in patch_files(bug["test_patch"])})


def score_step(run, chain, step):
    """hidden.json for the project after `step`: every listed test of issues 1..step, run in the image."""
    model = change(run / "project", [*touched_by_tests(chain, step), *ENV_FILES])
    (run / f"step{step}" / "model.patch").write_text(model)
    return score_change(chain, step, model)


def score_before(run, chain, step):
    """before.json: the same tests as step's hidden.json, on the change as step-1 left it (step.patch's
    parent state), so a test that passes there and fails after the step is one the step broke."""
    previous = run / f"step{step - 1}" / "model.patch"
    return score_change(chain, step, previous.read_text() if step > 1 else "", touched_by_tests(chain, step))


def added_tests(chain, step):
    """Test functions test patches 1..step add: hidden from the worker, so no gate can run them."""
    return {name for bug in chain["bug_fixes"][:step]
            for name in re.findall(r"^\+\s*(?:async\s+)?def (test\w*)\(", bug["test_patch"], re.M)}


def test_function(name):
    """`path::Class::test_x[a-b]` or `pkg.Class.test_x` -> `test_x`."""
    return re.split(r"::|\.", name.split("[", 1)[0])[-1]


def broken_by(before, after):
    """Tests that pass before a step and fail after it, both scored with the step's test patches."""
    passed = {r["name"] for r in (before or {}).get("results") or [] if r["passed"]}
    return sorted(r["name"] for r in (after or {}).get("results") or [] if not r["passed"] and r["name"] in passed)


def score_change(chain, step, model, exclude=()):
    """Every listed test of issues 1..step on `model` (a change since swe-base, `exclude` files left out)."""
    bugs = chain["bug_fixes"][:step]
    listed, per_bug = checks(chain, step)
    statuses, commands, error = {}, [], None
    started = time.time()
    with Container(chain["docker_image"]) as box:
        for name, text in [("model", model), *[(f"test-{n}", bug["test_patch"]) for n, bug in enumerate(bugs, 1)]]:
            if not text:
                continue
            box.write(f"/tmp/{name}.patch", text)
            # The image already fixed the environment files a test patch may pin dependencies in.
            skip = " ".join(f"--exclude={path}" for path in (exclude if name == "model" else ENV_FILES))
            code, output = box.run(f"git apply --whitespace=nowarn {skip} /tmp/{name}.patch", timeout=120)
            if code:
                error = f"{name} patch does not apply: {output.strip()[-800:]}"
                break
        if not error:
            for command in dict.fromkeys(PIP_PREFIX.sub("", bug["test_cmds"]) for bug in bugs):
                begun = time.time()
                code, output = box.run(f"timeout {TEST_TIMEOUT} bash -c {shlex.quote(command)}")
                found = parse_test_results(output)
                for key, status in found.items():
                    if PRIORITY[status] >= PRIORITY.get(statuses.get(key), -1):
                        statuses[key] = status
                commands.append({"command": command[-200:], "exit": code, "tests": len(found),
                                 "seconds": round(time.time() - begun), "tail": output[-1500:] if not found else ""})
    results = [{"name": key, "step": origin, "kind": kind, "passed": passes(statuses, key),
                "status": ",".join(sorted({statuses[m] for m in members(statuses, key)})) or "MISSING"}
               for key, (origin, kind) in listed.items()]
    resolved = []
    for number, (bug, tests) in enumerate(zip(bugs, per_bug), start=1):
        f2p = [passes(statuses, key) for key in tests["FAIL_TO_PASS"]]
        p2p = [passes(statuses, key) for key in tests["PASS_TO_PASS"]]
        resolved.append({"issue": number, "instance": bug["swebench_instance_id"], "resolved": all(f2p + p2p),
                         "f2p": [sum(f2p), len(f2p)], "p2p": [sum(p2p), len(p2p)]})
    scored = {"passed": sum(r["passed"] for r in results), "total": len(results), "results": results,
              "issues": resolved, "commands": commands, "seconds": round(time.time() - started),
              "modelPatchBytes": len(model)}
    if error:
        scored["error"] = error
    return scored


# ---------------------------------------------------------------- running


def commit_step(root, step, instance):
    """Commit everything the session left, as the user would between issues (ChainSWE commits each patch)."""
    sh(["git", "add", "-A"], cwd=root)
    sh(["git", "-c", "core.hooksPath=/dev/null", "commit", "-q", "--allow-empty", "--no-verify", "-m",
        f"Step {step}: {instance}"], cwd=root)
    return sh(["git", "diff", "--binary", "HEAD~1", "HEAD", "--", ".", *[f":(exclude){p}" for p in SCAFFOLD]], cwd=root)


def strict(evaluations):
    """ChainSWE's sequential score per step: this and every earlier issue resolved now, and the step before strict."""
    out, previous = [], True
    for _, scored in evaluations:
        now = previous and not scored.get("error") and all(issue["resolved"] for issue in scored.get("issues", []))
        out.append(now)
        previous = now
    return out


def unchanged_passing(chain):
    """{step: tests that pass on the unchanged repository with test patches 1..step}, from the newest
    finished `none` run of this chain, or None when there is none (run it with --arms none)."""
    runs = sorted(RUNS.glob(f"runs/*-{chain['label']}-none-*/chain.json"), key=lambda path: path.stat().st_mtime)
    if not runs:
        return None
    passing = {}
    for path in runs[-1].parent.glob("step*/hidden.json"):
        passing[int(path.parent.name[4:])] = {r["name"] for r in json.loads(path.read_text())["results"] if r["passed"]}
    return passing


def chain_facts(run, chain, evaluations, befores=None):
    redefined = {step: {canonical_test_id(test) for test in bug["FAIL_TO_PASS"]}
                 for step, bug in enumerate(chain["bug_fixes"], start=1)}
    summary = summarize({"results": []}, evaluations, redefined)
    per_step, existing, unchanged = [], set(), unchanged_passing(chain)
    for (step, scored), facts, is_strict in zip(evaluations, summary["steps"], strict(evaluations)):
        issues = scored.get("issues") or []
        own = next((issue for issue in issues if issue["issue"] == step), None)
        earlier_broken = [issue["issue"] for issue in issues if issue["issue"] < step and not issue["resolved"]]
        # Existing tests broken: tests only ever listed as PASS_TO_PASS that pass on the unchanged repository
        # (with test patches 1..step) and fail after the worker's changes so far, whether or not an earlier
        # step saw them pass. A FAIL_TO_PASS test failing later is a carried regression, or its issue unfixed.
        fixes = set().union(*(redefined[number] for number in range(1, step + 1)))
        failing = {r["name"] for r in scored.get("results") or [] if not r["passed"]} - fixes
        broken = sorted(failing & unchanged.get(step, set())) if unchanged is not None else None
        existing.update(broken or [])
        before = (befores or {}).get(step)
        by_step = broken_by(before, scored) if before else None
        hidden = added_tests(chain, step)
        per_step.append({**facts, "resolved": bool(own and own["resolved"]), "strict": is_strict,
                         "unresolvedEarlier": earlier_broken, "existingBroken": broken, "brokenByStep": by_step,
                         "brokenVisible": None if by_step is None else
                         [name for name in by_step if test_function(name) not in hidden],
                         "error": scored.get("error")})
    final = evaluations[-1][1].get("issues") or [] if evaluations else []
    return {**summary, "steps": per_step, "resolvedAtStep": sum(s["resolved"] for s in per_step),
            "strictResolved": sum(s["strict"] for s in per_step), "resolvedAtEnd": sum(i["resolved"] for i in final),
            "existingBrokenTests": sorted(existing) if unchanged is not None else None,
            "existingBrokenSteps": sum(bool(s["existingBroken"]) for s in per_step) if unchanged is not None else None,
            "breakingSteps": sum(bool(s["brokenByStep"]) for s in per_step)
            if all(s["brokenByStep"] is not None for s in per_step) else None,
            "visibleBreakingSteps": sum(bool(s["brokenVisible"]) for s in per_step)
            if all(s["brokenVisible"] is not None for s in per_step) else None,
            "testsBrokenBySteps": sum(len(s["brokenByStep"] or []) for s in per_step)}


def run_chain(name, chain, timeout, directory=None):
    run = RUNS / "runs" / name
    root = run / "project"
    arm = json.loads((run / "arm.json").read_text())
    (run / "baseline.json").write_text(json.dumps({"results": [], "note": "no check exists before issue 1"}))
    evaluations, befores = [], {}
    for step, bug in enumerate(chain["bug_fixes"], start=1):
        out = run / f"step{step}"
        out.mkdir(exist_ok=False)
        if arm["arm"] in ("gold", "none"):
            if arm["arm"] == "gold":
                sh(["git", "apply", "--whitespace=nowarn", "-"], cwd=root, stdin=bug["patch"])
            result = {"arm": arm["arm"], "seconds": 0, "timedOut": False, "isError": False, "turns": 0}
        else:
            result = run_session(root, arm, (run / f"prompt-step{step}.txt").read_text(), None, timeout)
        (out / "result.json").write_text(json.dumps({"run": name, "step": step, "instance": bug["swebench_instance_id"],
                                                     **result}, indent=2))
        (out / "step.patch").write_text(commit_step(root, step, bug["swebench_instance_id"]))
        scored = score_step(run, chain, step)
        (out / "hidden.json").write_text(json.dumps(scored, indent=1))
        befores[step] = score_before(run, chain, step)
        (out / "before.json").write_text(json.dumps(befores[step], indent=1))
        evaluations.append((step, scored))
        facts = chain_facts(run, chain, evaluations, befores)["steps"][-1]
        log(directory, json.dumps({"run": name, "step": step, "seconds": result["seconds"], "timedOut": result["timedOut"],
                              "isError": result["isError"], "resolved": facts["resolved"], "strict": facts["strict"],
                              "carried": facts["carried"], "regressions": len(facts["regressions"]),
                              "brokenByStep": len(facts["brokenByStep"] or []),
                              "scoreSeconds": scored["seconds"], "error": scored.get("error")}))
        if result["isError"]:
            break
    shutil.copyfile(run / f"step{evaluations[-1][0]}" / "hidden.json", run / "hidden.json")
    (run / "chain.json").write_text(json.dumps({"run": name, "task": chain["label"], "chain": chain["continuous_id"],
                                                "steps": len(chain["bug_fixes"]), "completed": len(evaluations),
                                                "committedSteps": True, **chain_facts(run, chain, evaluations, befores)},
                                               indent=2))


def log(directory, message):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}"
    with log_lock:
        print(line, flush=True)
        if directory:
            with open(directory / "batch.log", "a") as handle:
                handle.write(line + "\n")


def finish(run):
    """Keep VISP's state and the patches; drop the large working copy."""
    root = run / "project"
    if (root / ".visp").is_dir():
        sh(["tar", "-czf", str(run / "visp-state.tgz"), "-C", str(root), ".visp"])
    shutil.rmtree(root, ignore_errors=True)


def execute(entry, args, chains, directory):
    name = entry["name"]
    run = RUNS / "runs" / name
    invalid = (run / "invalid.json").exists()
    if (run / "chain.json").exists() and not (invalid and args.rerun_invalid):
        return name, "skip"
    if run.exists():
        stop_recorded(run)
        target = RUNS / "discarded" / f"{name}-{time.strftime('%Y%m%d-%H%M%S')}-{'invalid' if invalid else 'unfinished'}"
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(run), target)
        log(directory, f"{name}: {'invalid' if invalid else 'unfinished'} run moved to {target}")
    chain = chains[entry["chain"]]
    started = time.time()
    try:
        setup(run, chain, entry["arm"], args.preset)
        log(directory, f"{name}: started")
        run_chain(name, chain, args.timeout, directory)
    except Exception as error:  # noqa: BLE001 - one failed run must not stop the batch
        log(directory, f"{name}: FAIL {str(error)[-600:]}")
        return name, "failed"
    stopped = mark_if_invalid(run)
    if not args.keep_projects:
        finish(run)
    outcome = f"invalid ({stopped['reason']})" if stopped else "finished"
    log(directory, f"{name}: {outcome} in {round(time.time() - started)} s")
    return name, outcome


def plan(args, chains):
    arms = [(spec.split(":", 1)[1].replace("+", "-") if spec.startswith("visp:") else spec, spec)
            for spec in args.arms.split(",")]
    labels = [find(chains, key)["label"] for key in args.chains.split(",")]
    runs = []
    for rep in range(1, args.reps + 1):
        for index, label in enumerate(labels):
            shift = (rep - 1 + index) % len(arms)
            for arm_label, arm in arms[shift:] + arms[:shift]:
                runs.append({"name": f"{args.batch}-{label}-{arm_label}-{rep}", "chain": label, "arm": arm,
                             "label": arm_label, "rep": rep})
    return labels, arms, runs


def command_run(args):
    chains = load_chains()
    preset(args.preset)
    labels, arms, runs = plan(args, chains)
    missing = sorted({visp_build(arm)[0] for _, arm in arms if arm.startswith("visp:")} -
                     {path.name for path in (RUNS / "shims").glob("*")})
    if missing:
        raise SystemExit(f"no VISP build for {', '.join(missing)} in {RUNS / 'shims'}; make it with build_visp.sh")
    if args.dry_run:
        for entry in runs:
            chain = chains[entry["chain"]]
            run = RUNS / "runs" / entry["name"]
            state = "run" if not (run / "chain.json").exists() else (
                "rerun" if (run / "invalid.json").exists() and args.rerun_invalid else "skip")
            print(f"{state:5} {entry['name']:44} {entry['arm']:22} {len(chain['bug_fixes'])} issues  {chain['docker_image']}")
        return
    images = sorted({chains[label]["docker_image"] for label in labels})
    absent = [image for image in images if subprocess.run(["docker", "image", "inspect", image], env=DOCKER,
                                                          capture_output=True).returncode]
    if absent:
        raise SystemExit(f"pull these images first: {' '.join(absent)}")
    directory = RUNS / "batches" / args.batch
    directory.mkdir(parents=True, exist_ok=True)
    lock = directory / "lock"
    try:
        os.kill(int(lock.read_text()), 0)
        raise SystemExit(f"batch {args.batch} already running (pid {lock.read_text()})")
    except (OSError, ValueError):
        lock.write_text(str(os.getpid()))  # no lock, or its driver is gone
    manifest = {"batch": args.batch, "kind": "chainswe", "preset": args.preset, "settings": preset(args.preset),
                "chains": labels, "arms": [{"label": a, "arm": b} for a, b in arms], "reps": args.reps,
                "timeout": args.timeout, "runs": runs}
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2))
    log(directory, f"batch {args.batch}: {len(runs)} chain runs, preset {args.preset}, {args.jobs} at a time")
    with concurrent.futures.ThreadPoolExecutor(args.jobs) as pool:
        outcomes = dict(pool.map(lambda entry: execute(entry, args, chains, directory), runs))
    manifest["lastPass"] = {"finished": time.strftime("%Y-%m-%dT%H:%M:%S"), "outcomes": outcomes}
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2))
    lock.unlink(missing_ok=True)
    log(directory, "batch pass finished")


def command_before(args):
    """Score every finished step's before-state that has no before.json (from the saved model patches)."""
    chains = load_chains()
    manifest = json.loads((RUNS / "batches" / args.batch / "manifest.json").read_text())
    jobs = []
    for entry in manifest["runs"]:
        run = RUNS / "runs" / entry["name"]
        if (run / "chain.json").exists():
            jobs += [(run, chains[entry["chain"]], int(p.parent.name[4:])) for p in run.glob("step*/hidden.json")
                     if not (p.parent / "before.json").exists()]

    def one(job):
        run, chain, step = job
        (run / f"step{step}" / "before.json").write_text(json.dumps(score_before(run, chain, step), indent=1))
        return run.name, step

    with concurrent.futures.ThreadPoolExecutor(args.jobs) as pool:
        for name, step in pool.map(one, jobs):
            print(name, step, flush=True)


def command_score(args):
    run = RUNS / "runs" / args.run
    arm = json.loads((run / "arm.json").read_text())
    chain = find(load_chains(), arm["task"])
    steps = [args.step] if args.step else sorted(int(p.parent.name[4:]) for p in run.glob("step*/result.json"))
    if not (run / "project").is_dir():
        raise SystemExit("the working copy was removed; rescoring needs it (run with --keep-projects)")
    for step in steps:
        scored = score_step(run, chain, step)
        (run / f"step{step}" / "hidden.json").write_text(json.dumps(scored, indent=1))
        print(json.dumps({"step": step, "passed": scored["passed"], "total": scored["total"],
                          "issues": [(i["issue"], i["resolved"]) for i in scored["issues"]], "error": scored.get("error")}))


# ---------------------------------------------------------------- report


def costs(run):
    path = run / "claude-calls.jsonl"
    calls = [json.loads(line) for line in path.read_text().splitlines() if line.strip()] if path.exists() else []
    total = sum(call.get("cost") or 0 for call in calls)
    critic = sum(call.get("cost") or 0 for call in calls if call.get("role") == "critic")
    return round(total, 4), round(critic, 4)


def run_row(run, entry, chain):
    """One finished run's facts, recomputed from its steps' scores so a report always counts alike."""
    results = [json.loads(p.read_text()) for p in sorted(run.glob("step*/result.json"),
                                                         key=lambda p: int(p.parent.name[4:]))]
    hidden = [json.loads(p.read_text()) for p in sorted(run.glob("step*/hidden.json"),
                                                        key=lambda p: int(p.parent.name[4:]))]
    befores = {int(p.parent.name[4:]): json.loads(p.read_text()) for p in run.glob("step*/before.json")}
    facts = {"steps": len(chain["bug_fixes"]), "completed": len(hidden),
             **chain_facts(run, chain, list(enumerate(hidden, start=1)), befores)}
    cost, critic = costs(run)
    return {"run": run.name, "chain": entry["chain"], "arm": entry["label"], "steps": facts["steps"],
            "completed": facts["completed"], "resolvedAtStep": facts["resolvedAtStep"],
            "strictResolved": facts["strictResolved"], "resolvedAtEnd": facts["resolvedAtEnd"],
            "regressed": facts["regressed"], "brokenChecks": len(facts["brokenChecks"]),
            "carriedChecks": facts["carriedChecks"], "regressionEvents": facts["regressionEvents"],
            "carriedEvaluations": facts["carriedEvaluations"],
            "earlierIssuesBroken": sum(bool(s["unresolvedEarlier"]) for s in facts["steps"]),
            "existingBrokenSteps": facts["existingBrokenSteps"], "breakingSteps": facts["breakingSteps"],
            "visibleBreakingSteps": facts["visibleBreakingSteps"],
            "testsBrokenBySteps": facts["testsBrokenBySteps"],
            "existingBrokenTests": None if facts["existingBrokenTests"] is None else len(facts["existingBrokenTests"]),
            "workerSeconds": sum(r["seconds"] for r in results), "scoreSeconds": sum(h.get("seconds", 0) for h in hidden),
            "timedOut": sum(bool(r["timedOut"]) for r in results), "cost": cost, "criticCost": critic,
            "stepRows": [{**s, "seconds": r["seconds"], "instance": r.get("instance")}
                         for s, r in zip(facts["steps"], results)]}


def pct(part, whole):
    return f"{part}/{whole} ({part / whole * 100:.0f}%)" if whole else "–"


def command_report(args):
    directory = RUNS / "batches" / args.batch
    manifest = json.loads((directory / "manifest.json").read_text())
    chains = load_chains()
    rows, missing = [], []
    for entry in manifest["runs"]:
        run = RUNS / "runs" / entry["name"]
        if (run / "invalid.json").exists():
            missing.append(f"{entry['name']} (invalid: {json.loads((run / 'invalid.json').read_text())['reason']})")
        elif not (run / "chain.json").exists():
            missing.append(f"{entry['name']} (unfinished)")
        else:
            rows.append(run_row(run, entry, chains[entry["chain"]]))
    out = [f"## ChainSWE batch {args.batch} (preset {manifest['preset']})", "",
           "| Arm | Chains | Issues | Resolved at its step | Strict (ChainSWE) | Resolved at end | Chains with a "
           "regression | Steps that broke a passing test (of them, tests in the worker's repository) | Earlier tests broken | Regressions per carried test | "
           "Steps breaking an existing test | "
           "Steps leaving an earlier issue unresolved | Worker min per chain (median) | Cost $ per chain (mean) |",
           "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for arm in [a["label"] for a in manifest["arms"]]:
        mine = [r for r in rows if r["arm"] == arm]
        if not mine:
            continue
        issues = sum(r["completed"] for r in mine)
        later = sum(max(r["completed"] - 1, 0) for r in mine)
        out.append(
            f"| {arm} | {len(mine)} | {issues} | {pct(sum(r['resolvedAtStep'] for r in mine), issues)} | "
            f"{pct(sum(r['strictResolved'] for r in mine), issues)} | {pct(sum(r['resolvedAtEnd'] for r in mine), issues)} | "
            f"{pct(sum(r['regressed'] for r in mine), len(mine))} | "
            f"{pct(sum(r['breakingSteps'] for r in mine), issues) if all(r['breakingSteps'] is not None for r in mine) else 'needs before scores'}"
            f"{'' if any(r['visibleBreakingSteps'] is None for r in mine) else ' (' + str(sum(r['visibleBreakingSteps'] for r in mine)) + ' visible)'} | "
            f"{pct(sum(r['brokenChecks'] for r in mine), sum(r['carriedChecks'] for r in mine))} | "
            f"{pct(sum(r['regressionEvents'] for r in mine), sum(r['carriedEvaluations'] for r in mine))} | "
            f"{pct(sum(r['existingBrokenSteps'] for r in mine), issues) if all(r['existingBrokenSteps'] is not None for r in mine) else 'needs none runs'} | "
            f"{pct(sum(r['earlierIssuesBroken'] for r in mine), later)} | "
            f"{statistics.median(r['workerSeconds'] for r in mine) / 60:.1f} | "
            f"{statistics.mean(r['cost'] for r in mine):.2f} |")
    if args.runs:
        out += ["", "| Run | Step | Issue | Resolved | Strict | New tests | Carried | Regressions | Broke (before vs after) "
                "| Existing tests broken | Earlier issues unresolved | Worker s |",
                "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
        for r in rows:
            for s in r["stepRows"]:
                out.append(f"| {r['run']} | {s['step']} | {s['instance']} | {'yes' if s['resolved'] else 'no'} | "
                           f"{'yes' if s['strict'] else 'no'} | {s['newPassed']}/{s['newTotal']} | {s['carried']} | "
                           f"{len(s['regressions'])}{': ' + '; '.join(s['regressions'][:3]) if s['regressions'] else ''} | "
                           f"{'–' if s['brokenByStep'] is None else len(s['brokenByStep'])}"
                           f"{': ' + '; '.join(s['brokenByStep'][:2]) if s['brokenByStep'] else ''} | "
                           f"{'–' if s['existingBroken'] is None else len(s['existingBroken'])}"
                           f"{': ' + '; '.join(s['existingBroken'][:2]) if s['existingBroken'] else ''} | "
                           f"{', '.join(map(str, s['unresolvedEarlier'])) or '–'} | {s['seconds']} |")
    if missing:
        out += ["", "Not counted: " + "; ".join(missing)]
    text = "\n".join(out) + "\n"
    print(text)
    (directory / "report.json").write_text(json.dumps({"rows": rows, "missing": missing}, indent=2))
    if args.md:
        pathlib.Path(args.md).write_text(text)


def command_list(args):
    for chain in load_chains().values():
        if args.repo and chain["repo"] != args.repo:
            continue
        ids = ", ".join(bug["swebench_instance_id"].rsplit("-", 1)[-1][:10] for bug in chain["bug_fixes"])
        print(f"{chain['label']:22} {chain['source']:15} {chain['date_range']:25} {ids}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("export").add_argument("parquet_dir")
    sub.add_parser("list").add_argument("--repo")
    run = sub.add_parser("run")
    run.add_argument("--batch", required=True)
    run.add_argument("--chains", required=True)
    run.add_argument("--arms", required=True)
    run.add_argument("--reps", type=int, default=1)
    run.add_argument("--jobs", type=int, default=4)
    run.add_argument("--preset", default="quality-2026-10")
    run.add_argument("--timeout", type=int, default=2700, help="seconds per step session")
    run.add_argument("--keep-projects", action="store_true")
    run.add_argument("--rerun-invalid", action="store_true", help="redo runs a usage limit or CLI error made invalid")
    run.add_argument("--dry-run", action="store_true")
    score = sub.add_parser("score")
    score.add_argument("run")
    score.add_argument("--step", type=int)
    before = sub.add_parser("before")
    before.add_argument("--batch", required=True)
    before.add_argument("--jobs", type=int, default=4)
    report = sub.add_parser("report")
    report.add_argument("--batch", required=True)
    report.add_argument("--runs", action="store_true")
    report.add_argument("--md")
    args = parser.parse_args()
    {"export": lambda: export(args.parquet_dir), "list": lambda: command_list(args), "run": lambda: command_run(args),
     "score": lambda: command_score(args), "before": lambda: command_before(args),
     "report": lambda: command_report(args)}[args.command]()


if __name__ == "__main__":
    sys.exit(main())
