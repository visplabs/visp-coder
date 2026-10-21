"""Run one prepared arm with a headless Claude Code actor in its project directory.

Usage: run_claude.py <run_name> [--model claude-haiku-4-5-20251001] [--effort high] [--timeout 2700]

Unlike a subagent, a headless session started in the project loads the project's own
CLAUDE.md, skills and hooks, so each workflow is enforced the way a user would run it.
User-level settings and MCP servers are excluded so every arm starts from the same host.
Writes result.json (duration, turns, cost, tokens, session id, preset) beside the project.
The model and effort default to the worker of the preset recorded in arm.json (presets.py).
"""
import argparse
import json
import os
import pathlib
import shutil
import time

from common import RUNS, isolate, run_worker

MODEL = "claude-haiku-4-5-20251001"
# Spec Kit is driven one command per user turn; each skill ends by naming the next one
# and waits. Its later phases are sent as follow-ups in the same session.
FOLLOW_UPS = {
    "speckit": [f"Continue: carry out the speckit-{phase} skill now, then stop."
                for phase in ("plan", "tasks", "implement", "converge")],
}


def worker_env(arm):
    env = dict(os.environ)
    if arm.get("shim"):
        env["PATH"] = f"{arm['shim']}:{env['PATH']}"
    # Claude Code's own auto memory lives outside the project and would carry knowledge
    # between sessions of one run; only what the workflow keeps in the project may carry.
    env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "1"
    return env


def record_calls(env, log):
    """Route every `claude` the run starts through claude_shim, which logs each call's cost.

    VISP discards its reviewer's and tester's reported usage; the shim keeps it, and the
    worker's own sessions, in claude-calls.jsonl beside the project.
    """
    real = shutil.which("claude", path=env["PATH"])
    if not real:
        return env
    return {**env, "BENCH_REAL_CLAUDE": real, "BENCH_CALL_LOG": str(log),
            "PATH": f"{pathlib.Path(__file__).resolve().parent / 'claude_shim'}:{env['PATH']}"}


def worker(arm, model=None, effort=None):
    """The worker model and effort: explicit values, else the arm's preset, else the default."""
    settings = (arm.get("settings") or {}).get("worker") or {}
    return model or settings.get("model") or MODEL, effort or settings.get("effort")


def run_session(project, arm, prompt, model=None, timeout=2700, resume=None, effort=None):
    """Run one user session (the prompt plus the arm's scripted follow-ups) and summarize it."""
    model, effort = worker(arm, model, effort)
    env = record_calls(worker_env(arm), pathlib.Path(project).parent / "claude-calls.jsonl")
    started = time.time()

    def turn(text, session=None):
        argv = [*isolate(), "claude", "-p", text, "--model", model, "--output-format", "json",
                "--permission-mode", "bypassPermissions", "--setting-sources", "project,local",
                "--strict-mcp-config"]
        if effort:
            argv += ["--effort", effort]
        if session:
            argv += ["--resume", session]
        remaining = max(60, timeout - int(time.time() - started))
        # Own session: a worker signalling its shell's process group (`kill %1` without job
        # control) must not reach sibling runs in the same batch.
        code, stdout, stderr, timed_out = run_worker(argv, project, env, remaining,
                                                     pathlib.Path(project).parent / "worker.pid")
        if timed_out:
            return {}, True
        try:
            return json.loads(stdout), False
        except ValueError:
            data = {"raw": stdout[-2000:]}
            if code != 0:
                # claude (or the namespace wrapper) failed before reporting: count it as an error.
                data.update(is_error=True, exit_code=code, result=f"exit {code}: {stderr[-1500:]}")
            return data, False

    data, timed_out = turn(prompt, resume)
    turns = [data]
    for follow_up in FOLLOW_UPS.get(arm["arm"], []):
        if timed_out or not data.get("session_id"):
            break
        data, timed_out = turn(follow_up, data["session_id"])
        turns.append(data)
    # BMAD's workflow can end its turn asking the user to approve the spec; answer as a user would.
    for _ in range(3):
        if arm["arm"] != "bmad" or timed_out or not data.get("session_id"):
            break
        if "approve and continue" not in str(data.get("result", "")).lower():
            break
        data, timed_out = turn("Approve and continue.", data["session_id"])
        turns.append(data)

    def total(key):
        values = [(entry.get("usage") or {}).get(key) for entry in turns]
        return sum(value for value in values if isinstance(value, int)) or None

    return {
        "arm": arm["arm"], "preset": arm.get("preset"), "model": model, "effort": effort, "seconds": round(time.time() - started), "timedOut": timed_out,
        "turns": sum(entry.get("num_turns") or 0 for entry in turns), "userTurns": len(turns),
        "isError": any(entry.get("is_error") for entry in turns),
        "sessionId": next((entry["session_id"] for entry in reversed(turns) if entry.get("session_id")), None),
        "sessionIds": list(dict.fromkeys(entry["session_id"] for entry in turns if entry.get("session_id"))),
        "inputTokens": total("input_tokens"), "cacheReadTokens": total("cache_read_input_tokens"),
        "cacheWriteTokens": total("cache_creation_input_tokens"), "outputTokens": total("output_tokens"),
        "report": str(data.get("result", ""))[-1500:],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("run")
    parser.add_argument("--model")
    parser.add_argument("--effort")
    parser.add_argument("--timeout", type=int, default=2700)
    args = parser.parse_args()
    run = RUNS / "runs" / args.run
    arm = json.loads((run / "arm.json").read_text())
    result = {"run": args.run, **run_session(run / "project", arm, (run / "prompt.txt").read_text(),
                                             args.model, args.timeout, effort=args.effort)}
    (run / "result.json").write_text(json.dumps(result, indent=2))
    print(json.dumps({k: result[k] for k in ("run", "arm", "seconds", "timedOut", "turns", "isError")}))


if __name__ == "__main__":
    main()
