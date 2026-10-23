"""Inside the scope image: check the image matches the bench, put the PATH shim in place, run the worker.

Usage (by run_scope.py through docker run; scope_container.py builds the command):
  entrypoint.py --describe
      print {"digest", "claude", "uid", "gid"} as JSON: the digest of the bench files the image holds
      (scope_env.files_digest), the Claude Code version, and the image user's ids
  entrypoint.py --run <run dir> --deadline <seconds> -- claude <args...>
      refuse (exit 97) unless BENCH_SCOPE_DIGEST equals the image's digest; write the run's shimbin/
      wrappers and shim.json for the tools of this image (scope_env.install_shims); run the command and
      stop it, with its whole process group, at the deadline (exit 124)

The run directory is mounted at the same path as on the host, so every path the scenario wrote
(the prompt, the remote, @@HOME@@) stays valid. Standard library only.
"""
import argparse
import json
import os
import pathlib
import signal
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from scope_env import files_digest, install_shims  # noqa: E402

EXIT_STALE = 97
EXIT_DEADLINE = 124


def describe():
    done = subprocess.run(["claude", "--version"], capture_output=True, text=True, timeout=60)
    return {"digest": files_digest(HERE, flat=True), "claude": done.stdout.strip(), "uid": os.getuid(),
            "gid": os.getgid()}


def run(run_dir, deadline, command):
    expected = os.environ.pop("BENCH_SCOPE_DIGEST", "")
    if expected != files_digest(HERE, flat=True):
        print("scope image is stale: its bench files differ from this bench; rebuild it (bench/README.md, "
              "Container isolation)", file=sys.stderr)
        return EXIT_STALE
    install_shims(run_dir)
    process = subprocess.Popen(command, start_new_session=True)

    def stop(number, _frame):
        os.killpg(process.pid, number)
    for number in (signal.SIGTERM, signal.SIGINT):
        signal.signal(number, stop)
    try:
        return process.wait(timeout=deadline)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        print(f"scope worker stopped at its {deadline} s deadline", file=sys.stderr)
        return EXIT_DEADLINE


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--describe", action="store_true")
    parser.add_argument("--run")
    parser.add_argument("--deadline", type=int, default=1200)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.describe:
        print(json.dumps(describe()))
        return 0
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not args.run or not command:
        parser.error("--run and a command are required")
    return run(args.run, args.deadline, command)


if __name__ == "__main__":
    sys.exit(main())
