"""Prepare one benchmark project and write the actor prompt for it.

Usage: setup_arm.py <task> <arm> <run_name> [--skill <id>]... [--preset default]
arm: bare | bare-automemory | speckit | bmad | visp:<build> (Claude Code worker) | visp-codex:<build> (Codex worker)
bare-automemory is bare with Claude Code's auto memory on, in a directory of the run; every other arm has it off.
<build> is a name given to build_visp.sh; `visp:<build>+lean` adds a workflow mode from presets.py. --skill seeds and admits a bundled VISP skill, so an
arm with it differs from one without only by that skill. --preset (presets.py) sets VISP's
reviewer and tester and is recorded in arm.json, where the runners read the worker model.

The prompt is host-neutral; run_claude.py or run_codex.py gives it to a headless worker that
works only inside the project. Every arm receives the same task and constraints.

A two-session task (session1.md, session2.md, conventions.md) also gets prompt2.txt and
prompt2-oracle.txt, the second request without and with the first session's conventions;
run_carryover.py runs both sessions. A task with intermediate.md also gets prompt-intermediate.txt, the
request of the session between them. A chain task (steps/step1.md ... stepN.md) gets
prompt-step<k>.txt for every step, prompt.txt being the first; run_chain.py runs them in order.
"""
import argparse
import json
import os
import pathlib
import shutil
import subprocess

from chains import step_files
from common import RUNS
from presets import critic_yaml, preset, visp_build, workflow_yaml

BENCH = pathlib.Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument("task")
parser.add_argument("arm")
parser.add_argument("run")
parser.add_argument("--skill", action="append", default=[])
parser.add_argument("--preset", default="default")
args = parser.parse_args()
settings = preset(args.preset)
task_name, arm, name = args.task, args.arm, args.run
if args.skill and not arm.startswith("visp"):
    raise SystemExit("--skill applies only to VISP arms")
root = RUNS / "runs" / name / "project"
root.mkdir(parents=True, exist_ok=False)
task_dir = BENCH / "tasks" / task_name
sessions = (task_dir / "session1.md").is_file()
steps = step_files(task_name)
if sessions:
    conventions = (task_dir / "conventions.md").read_text().strip()
    task = (task_dir / "session1.md").read_text().replace("{conventions}", conventions)
elif steps:
    task = steps[0].read_text()
else:
    task = (task_dir / "task.md").read_text()
env = dict(os.environ)
shim_dir = None


def sh(argv):
    r = subprocess.run(argv, cwd=root, env=env, capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"setup failed: {argv}\n{r.stderr[-2000:]}")


sh(["git", "init", "-q", "-b", "main"])
sh(["git", "config", "user.name", "Bench"])
sh(["git", "config", "user.email", "bench@localhost"])
(root / ".gitignore").write_text("__pycache__/\nnode_modules/\n")
# A brownfield task starts from its existing codebase.
start = task_dir / "start"
if start.is_dir():
    shutil.copytree(start, root, dirs_exist_ok=True)

COMMON = (
    f"Your project directory is {root}. Run every shell command from that directory "
    f"(start each command with `cd {root} && `) and create or edit files only inside it. "
    "Do not read other directories. No dependency downloads or network APIs; the standard "
    "library is available. Do not ask questions: make reasonable assumptions and continue. "
    "Do not delegate to other agents. Build it, run your tests, and finish with a short report "
    "of what you actually verified."
)
if arm in ("bare", "bare-automemory"):
    workflow = "Use ordinary coding: write the code and tests directly."
elif arm == "speckit":
    sh(["specify", "init", "--here", "--force", "--non-interactive", "--integration", "claude"])
    workflow = (
        "This project uses GitHub Spec Kit. Follow its workflow in order by reading each command "
        "under .claude/skills/ named speckit-* and carrying out its instructions exactly as if the "
        "user had invoked it: specify (with the task below as input), then plan, then tasks, then "
        "implement, then converge. Answer any clarification yourself with a reasonable assumption."
    )
elif arm == "bmad":
    sh(["npx", "-y", "bmad-method@6.12.0", "install", "--yes", "--tools", "claude-code",
        "--modules", "bmm", "--directory", "."])
    workflow = (
        "This project uses the BMAD Method. Follow its bmad-build workflow for this request: read "
        "the bmad-build skill under .claude/skills/ and carry out its instructions exactly as if the "
        "user had invoked it, including the workflow files it points to. Where it asks the user for "
        "approval or input, approve your own recommendation and continue until the implementation "
        "is complete and tested."
    )
elif arm.startswith("visp:") or arm.startswith("visp-codex:"):
    # visp-codex installs the Codex instructions for a Codex worker; the reviewer is Codex either way.
    host = "codex" if arm.startswith("visp-codex:") else "claude-code"
    build, mode = visp_build(arm)
    shim = RUNS / "shims" / build
    shim_dir = str(shim)
    env["PATH"] = f"{shim}:{env['PATH']}"
    sh(["visp", "init", "--harness", host, "--json"])
    config = (root / "visp.yml").read_text()
    # The reviewer (and tester) is a stronger model than the worker, as the preset sets it.
    critic = critic_yaml(settings["critic"])
    config = config.replace("critic:\n  harness: claude-code", critic)
    if args.preset != "default" and critic not in config:
        raise SystemExit(f"setup failed: visp.yml has no critic block to replace for preset {args.preset}")
    (root / "visp.yml").write_text(workflow_yaml(config, mode))
    sh(["visp", "install", "--harness", host, "--json"])
    for skill in args.skill:
        sh(["visp", "skill", "seed", skill, "--by", "bench"])
        sh(["visp", "skill", "admit", skill, "--by", "bench"])
    guide = "AGENTS.md" if host == "codex" else "CLAUDE.md"
    workflow = (
        f"This project uses VISP. Read {guide} and the VISP instructions it references before "
        f"starting, and follow them. Run every command with `export PATH={shim}:$PATH` first so "
        f"`visp` is the project's build."
    )
else:
    raise SystemExit(f"unknown arm {arm}")

sh(["git", "add", "-A"])
sh(["git", "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "Benchmark scaffold"])
prompt = f"{workflow}\n\n{COMMON}\n\nTask:\n\n{task}"
(root.parent / "prompt.txt").write_text(prompt)
if sessions:
    second = (task_dir / "session2.md").read_text()
    (root.parent / "prompt2.txt").write_text(f"{workflow}\n\n{COMMON}\n\nTask:\n\n{second}")
    (root.parent / "prompt2-oracle.txt").write_text(
        f"{workflow}\n\n{COMMON}\n\nTask:\n\n{second}\n{conventions}\n")
if sessions and (task_dir / "intermediate.md").is_file():
    intermediate = (task_dir / "intermediate.md").read_text()
    (root.parent / "prompt-intermediate.txt").write_text(f"{workflow}\n\n{COMMON}\n\nTask:\n\n{intermediate}")
for number, step in enumerate(steps, start=1):
    (root.parent / f"prompt-step{number}.txt").write_text(f"{workflow}\n\n{COMMON}\n\nTask:\n\n{step.read_text()}")
# The headless runner puts the arm's VISP build on PATH so installed hooks find it.
(root.parent / "arm.json").write_text(json.dumps({"task": task_name, "arm": arm, "shim": shim_dir, "skills": args.skill,
                                                 "preset": args.preset, "settings": settings,
                                                 "memory": "auto" if arm == "bare-automemory" else "off"}))
print(json.dumps({"root": str(root), "prompt": str(root.parent / "prompt.txt")}))
