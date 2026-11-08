"""Run one prepared arm with a headless Codex worker in its project directory.

Usage: run_codex.py <run_name> [--model gpt-5.6-luna] [--effort low] [--timeout 2700]

The worker gets a clean HOME (so no personal tools or a stale global `visp` leak in), a
private CODEX_HOME holding only the sign-in, the project's own AGENTS.md, and a
workspace-write sandbox with network so test servers and the VISP-launched reviewer work.
Writes result.json beside the project.
"""
import argparse
import json
import os
import pathlib
import shutil
import tempfile
import time

from common import RUNS, crash_env, isolate, run_worker

parser = argparse.ArgumentParser()
parser.add_argument("run")
parser.add_argument("--model", default="gpt-5.6-luna")
parser.add_argument("--effort", default="low")
parser.add_argument("--timeout", type=int, default=2700)
args = parser.parse_args()

run = RUNS / "runs" / args.run
project = run / "project"
arm = json.loads((run / "arm.json").read_text())
# Codex will not install its sandbox helper under /tmp, so the clean home lives here.
(RUNS / "homes").mkdir(exist_ok=True)
home = pathlib.Path(tempfile.mkdtemp(prefix=f"{args.run}-", dir=RUNS / "homes"))
codex_home = home / ".codex"
codex_home.mkdir()
shutil.copy(pathlib.Path.home() / ".codex" / "auth.json", codex_home / "auth.json")
path = os.environ["PATH"]
if arm.get("shim"):
    path = f"{arm['shim']}:{path}"
env = {"HOME": str(home), "CODEX_HOME": str(codex_home), "PATH": path, "LANG": "C.UTF-8",
       **crash_env(run, arm, args.model)}
# BMAD renders its skills with `uv run`, which otherwise downloads CPython into every clean
# home; the worker read that as breaking the no-download rule and stopped. Use the host's.
uv_python = pathlib.Path.home() / ".local" / "share" / "uv" / "python"
if uv_python.is_dir():
    env.update({"UV_PYTHON_INSTALL_DIR": str(uv_python), "UV_PYTHON_DOWNLOADS": "never"})
argv = [
    *isolate(),
    # Equivalent to the user trusting the project's hooks once with /hooks.
    "codex", "exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-hook-trust",
    "--cd", str(project),
    "--model", args.model, "--config", f'model_reasoning_effort="{args.effort}"',
    "--sandbox", "workspace-write", "--config", "sandbox_workspace_write.network_access=true",
    # The clean home is the worker's own, as it is for a Claude worker: BMAD's setup step
    # installs a Python there with uv and stopped on a read-only home.
    "--config", f"sandbox_workspace_write.writable_roots={json.dumps([str(home)])}",
    "--config", 'approval_policy="never"', "-",
]
started, report = time.time(), ""
# Own session, so a worker's process-group signal cannot reach sibling runs.
code, output, stderr, timed_out = run_worker(argv, None, env, args.timeout, run / "worker.pid",
                                             stdin=(run / "prompt.txt").read_text())
# codex (or the namespace wrapper) failed without emitting a single event.
failed = not timed_out and code != 0 and not output.strip()
if failed:
    report = f"exit {code}: {stderr[-1500:]}"
elapsed = round(time.time() - started)
usage, commands = {}, 0
for line in output.splitlines():
    try:
        event = json.loads(line)
    except ValueError:
        continue
    if event.get("type") == "turn.completed":
        for key, value in (event.get("usage") or {}).items():
            if isinstance(value, int):
                usage[key] = usage.get(key, 0) + value
    item = event.get("item") or {}
    if event.get("type") == "item.completed" and item.get("type") == "agent_message":
        report = item.get("text", "")
    if event.get("type") == "item.completed" and item.get("type") == "command_execution":
        commands += 1
    # The CLI's own failure (an API error, a usage limit). An error event alone can be a retry
    # the CLI recovered from; it ends the session in error only with a failed turn or exit.
    if event.get("type") == "turn.failed" or (event.get("type") == "error" and code != 0 and not timed_out):
        failed = True
        report = str(event.get("message") or (event.get("error") or {}).get("message") or event)
shutil.rmtree(home, ignore_errors=True)
result = {
    "run": args.run, "arm": arm["arm"], "preset": arm.get("preset"), "model": f"{args.model}:{args.effort}", "seconds": elapsed,
    "timedOut": timed_out, "turns": commands, "isError": failed, "usage": usage, "report": report[-1500:],
}
(run / "result.json").write_text(json.dumps(result, indent=2))
print(json.dumps({k: result[k] for k in ("run", "arm", "seconds", "timedOut", "turns")}))
