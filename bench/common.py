"""Shared benchmark settings."""
import functools
import os
import pathlib
import shutil
import signal
import subprocess

# Runs, builds and worker homes live outside the repository.
RUNS = pathlib.Path(os.environ.get("VISP_BENCH_RUNS", pathlib.Path.home() / "visp-bench"))

# A worker sees only its own processes: `killall python3` or `pkill -f <pattern>` to stop its
# test server must not reach the runner or another run's servers. The namespace ends with it.
UNSHARE = ["unshare", "--user", "--map-current-user", "--pid", "--fork", "--mount-proc", "--kill-child"]


@functools.cache
def isolate():
    """The namespace wrapper, or [] where unshare is missing or the host blocks it.

    Unprivileged user namespaces or mounting /proc can be disabled even when unshare exists;
    the exact wrapper is tried once so a blocked host runs workers unwrapped instead of not at all.
    """
    if not shutil.which("unshare"):
        return []
    try:
        probe = subprocess.run([*UNSHARE, "true"], capture_output=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return []
    return UNSHARE if probe.returncode == 0 else []


def run_worker(argv, cwd, env, timeout, pid_file, stdin=None, pass_fds=()):
    """Run a worker CLI in its own session, its pid recorded in pid_file while it runs.

    Returns (exit code, stdout, stderr, timed out). On timeout the whole process group is killed.
    The pid file lets a later batch stop a worker its killed driver left behind (stop_recorded).
    pass_fds are file descriptors the worker inherits (scope_container.py hands docker its env file so).
    """
    process = subprocess.Popen(argv, cwd=cwd, env=env, text=True, start_new_session=True, pass_fds=pass_fds,
                               stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    pid_file = pathlib.Path(pid_file)
    pid_file.write_text(str(process.pid))
    try:
        stdout, stderr = process.communicate(stdin, timeout=timeout)
        return process.returncode, stdout, stderr, False
    except subprocess.TimeoutExpired:
        _kill_group(process.pid)
        stdout, stderr = process.communicate()
        return process.returncode, stdout, stderr, True
    finally:
        pid_file.unlink(missing_ok=True)


def _kill_group(pid):
    try:
        os.killpg(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def _owned_by(pid, run):
    """Whether a live process belongs to this run: its working directory or argv names the run."""
    try:
        cwd = os.readlink(f"/proc/{pid}/cwd")
        argv = pathlib.Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
    except OSError:
        return False
    root = str(run.resolve())
    return cwd.startswith(root) or any(word == run.name or word.startswith(root) for word in argv.split())


def stop_recorded(run):
    """Stop the runner and worker a previous batch recorded for this run, if they still run.

    Returns the pids stopped. A recorded pid now used by an unrelated process is left alone.
    """
    stopped = []
    for name in ("runner.pid", "worker.pid"):
        path = run / name
        try:
            pid = int(path.read_text())
        except (OSError, ValueError):
            continue
        if _owned_by(pid, run):
            # Each was started in its own session, so its group is its pid.
            _kill_group(pid)
            stopped.append(pid)
        path.unlink(missing_ok=True)
    return stopped
