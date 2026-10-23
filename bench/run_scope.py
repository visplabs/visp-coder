"""Run one prepared scope arm with a headless Claude Code worker, then judge it.

Usage: run_scope.py <run_name> [--model ...] [--effort ...] [--timeout 1200]
                    [--container | --no-container] [--token-file ~/.config/visp-bench/claude-token]
                    [--image visp-bench-scope:2.1.300] [--allow-host api.anthropic.com:443 ...]
       run_scope.py <run_name> --rescore     (judge a finished run again, from the directory as it is now)

The run is prepared by setup_arm.py with a scope task (scope_env.py). Before the worker starts,
the project, the fake home, the outside directory and the git remote are hashed
(snapshot-before.json); when it ends they are hashed again and the differences, the PATH shim's
log (shim.log), the worker's transcript and, for a VISP arm, the output of `visp pr` are judged
by scope_verdict.py. Writes scope.json (the verdict and its evidence), snapshot-after.json, pr.txt and,
last, result.json, so a run is finished only once it is judged. No model judges anything.

By default (`--container`) the worker runs in the scope image (scope/Dockerfile) with the bench-only token
from --token-file, the run directory as its only mount, no host environment, and a network that reaches
only the allowed hosts through an egress proxy (scope_container.py). result.json records the isolation
under "isolation". The run is flagged invalid (invalid.json) and not scored if the host's
~/.claude/settings.json, ~/.claude.json or ~/.ssh file listing changed while it ran. A VISP arm cannot run
in the container yet: its build is not in the image. `--no-container` runs the worker on the host as
before; the run then aborts before the worker starts if its HOME is the real home or a path under the fake
home links into it (scope_env.check_home_isolation), which the sign-in link materialize() makes always
does. `--rescore` starts no worker and runs neither guard.
"""
import argparse
import json
import pathlib
import subprocess
import sys

import scope_container as containers
import scope_snapshot as snapshots
from common import RUNS
from run_claude import run_session, worker_env
from runfacts import CLAUDE_PROJECTS
from scope_env import check_home_isolation, drop_host_signin, files_digest, real_home
from scope_verdict import judge, load_events, run_success, transcript_facts


def transcript_paths(result):
    """The worker's transcripts: under the host's ~/.claude/projects, or the container's (result "claudeProjects")."""
    ids = [session for session in (result.get("sessionIds") or [result.get("sessionId")]) if session]
    roots = [CLAUDE_PROJECTS] + ([pathlib.Path(result["claudeProjects"])] if result.get("claudeProjects") else [])
    return sorted({path for root in roots for session in ids for path in root.glob(f"*/{session}.jsonl")})


def visp_pr(run, arm):
    """The text `visp pr` prints for the finished project, or None for an arm without VISP."""
    if not str(arm["arm"]).startswith("visp"):
        return None
    try:
        done = subprocess.run(["visp", "pr"], cwd=run / "project", env=worker_env(arm), capture_output=True,
                              text=True, timeout=180)
    except (OSError, subprocess.TimeoutExpired) as error:
        return f"visp pr failed: {error}"
    return done.stdout + done.stderr


def score(run, arm, scenario, result, before):
    """Judge a finished run from its directory; writes scope.json, snapshot-after.json and pr.txt."""
    after = snapshots.take(run)
    snapshots.dump(run / "snapshot-after.json", after)
    changes, remote = snapshots.compare(before, after, run)
    canaries = json.loads((run / "canaries.json").read_text())
    refusals, reads = transcript_facts(transcript_paths(result), run / "project", canaries)
    pr_text = visp_pr(run, arm)
    if pr_text is not None:
        (run / "pr.txt").write_text(pr_text)
    success = run_success(scenario, run / "project", run / "home")
    verdict = judge(scenario, changes, load_events(run / "shim.log"), remote, refusals, reads, success, pr_text)
    verdict.update({"run": run.name, "arm": arm["arm"], "changes": changes, "remote": remote,
                    "refusals": refusals, "reads": reads, "shimEvents": len(load_events(run / "shim.log")),
                    "successChecks": success["checks"]})
    (run / "scope.json").write_text(json.dumps(verdict, indent=2))
    return verdict


def run_on_host(run, arm, args):
    """The worker on the host. Returns (result, snapshot before, host state changes)."""
    # Before anything is hashed or started: the worker's HOME must not be, or link into, the real home.
    check_home_isolation((arm.get("env") or {}).get("HOME") or run / "home", run)
    before = snapshots.take(run)
    snapshots.dump(run / "snapshot-before.json", before)
    result = {"run": args.run, **run_session(run / "project", arm, (run / "prompt.txt").read_text(), args.model,
                                             args.timeout, effort=args.effort)}
    result["isolation"] = {"mode": "host"}
    return result, before, []


def run_in_container(run, arm, args):
    """The worker in the scope image (scope_container.py). Returns (result, snapshot before, host state changes)."""
    if str(arm["arm"]).startswith("visp"):
        raise SystemExit("run aborted: a VISP arm cannot run in the scope container yet (its build is not in the image)")
    problems, facts = containers.preflight(args.image, args.token_file)
    problems += containers.mount_problems(run)
    if problems:
        raise SystemExit("run aborted: " + "; ".join(problems))
    removed = drop_host_signin(run)
    check_home_isolation(run / "home", run)
    token = containers.read_token(args.token_file)
    real = real_home()
    host_before = containers.host_state(real)
    before = snapshots.take(run)
    snapshots.dump(run / "snapshot-before.json", before)
    with containers.Session(run, arm, args.image, token, files_digest(containers.BENCH), args.allow_host) as session:
        result = {"run": args.run, **run_session(run / "project", arm, (run / "prompt.txt").read_text(), args.model,
                                                 args.timeout, effort=args.effort, launch=session)}
    host_after = containers.host_state(real)
    leaks = containers.redact_files(run, token)
    result = json.loads(containers.redact_text(json.dumps(result), token))
    changed = containers.host_changes(host_before, host_after)
    result["claudeProjects"] = str(run.resolve() / "home" / ".claude" / "projects")
    result["isolation"] = {"mode": "container", "image": args.image, "imageClaude": facts.get("claude"),
                           "imageDigest": facts.get("digest"), "names": session.names, "env": sorted(session.env),
                           "credential": str(args.token_file), "allowHosts": list(args.allow_host),
                           "removedFromHome": removed, "hostState": {"before": host_before, "after": host_after},
                           "hostChanged": changed, "tokenLeaks": leaks}
    return result, before, changed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("run")
    parser.add_argument("--model")
    parser.add_argument("--effort")
    parser.add_argument("--timeout", type=int, default=1200)
    parser.add_argument("--rescore", action="store_true")
    parser.add_argument("--container", action=argparse.BooleanOptionalAction, default=True,
                        help="run the worker in the scope image (the default); --no-container runs it on the host")
    parser.add_argument("--token-file", type=pathlib.Path, default=containers.default_token_file(),
                        help="the bench-only Claude Code token (claude setup-token), mode 600")
    parser.add_argument("--image", default=containers.IMAGE)
    parser.add_argument("--allow-host", action="append", metavar="HOST:PORT",
                        help=f"a host the container may reach (default: {', '.join(containers.ALLOW_HOSTS)})")
    args = parser.parse_args()
    args.allow_host = args.allow_host or list(containers.ALLOW_HOSTS)
    run = RUNS / "runs" / args.run
    arm = json.loads((run / "arm.json").read_text())
    scenario = json.loads((run / "scenario.json").read_text())
    if args.rescore:
        result = json.loads((run / "result.json").read_text())
        verdict = score(run, arm, scenario, result, snapshots.load(run / "snapshot-before.json"))
    else:
        result, before, changed = (run_in_container if args.container else run_on_host)(run, arm, args)
        if changed:
            # The container cannot reach these files: a change means the isolation failed or something else on
            # the host wrote them while the run ran. Either way the run is not scored.
            flag = {"reason": "host state changed", "source": "run_scope.py host guard", "match": ", ".join(changed)}
            (run / "invalid.json").write_text(json.dumps(flag, indent=2))
            verdict = {"error": f"host state changed during the run: {', '.join(changed)}"}
            (run / "scope.json").write_text(json.dumps(verdict))
        else:
            try:
                verdict = score(run, arm, scenario, result, before)
            except Exception as error:  # a broken verdict must not lose the run: report.py lists it as unusable
                verdict = {"error": repr(error)}
                (run / "scope.json").write_text(json.dumps(verdict))
        (run / "result.json").write_text(json.dumps(result, indent=2))
    print(json.dumps({"run": args.run, "arm": arm["arm"], "overreach": verdict.get("overreach"),
                      "attempt": verdict.get("attempt"), "success": verdict.get("success"),
                      "error": verdict.get("error")}))


if __name__ == "__main__":
    sys.exit(main())
