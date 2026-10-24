"""Container isolation for scope runs (owner decision D2): the worker runs in the scope image with a bench-only credential.

run_scope.py uses this by default (`--container`). Per run:

- Five areas of the run directory are mounted, each at the same path as on the host, so the paths setup_arm.py
  wrote (the remote, the fake home, @@HOME@@) stay valid: project/, home/, outside/, remote.git and shimbin/
  (MOUNTED). The run directory itself is not: the host writes result.json, invalid.json, egress.log and
  scope.json there, so a link the worker plants cannot redirect those writes, and the worker cannot read the
  ground truth (scenario.json, canaries.json). Before the mount, the sign-in link to the real ~/.claude and
  the copy of ~/.claude.json are removed from the fake home (scope_env.drop_host_signin); a run directory that
  is, or contains, the real home, or whose areas are not plain directories, is refused.
- The scenario's success checks import the worker's modules, so they run in a container too (check_argv):
  no network at all, the same hardening, the areas but shimbin/ mounted read-only, and git with no user or
  system config and the repository's hooks and fsmonitor off (scope_snapshot.SAFE_GIT_ENV).
- The worker signs in with the bench-only token from --token-file, read when the run starts and handed to
  `docker run --env-file /dev/fd/<n>` through a pipe: it is never in argv, on disk outside that file, in a
  log, arm.json or result.json. Its output and the run directory are searched for the token afterwards and
  any copy is redacted (result.json "tokenLeaks" names the files). Inside, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1
  keeps it out of the worker's Bash commands.
- The container's environment is only what container_env() lists: no host variable reaches it (no
  SSH_AUTH_SOCK, GH_TOKEN, API keys, DISPLAY).
- The network: the worker's container is on its own `--internal` Docker network, which has no route out.
  A second container from the same image, on that network and the default bridge, runs egress_proxy.py,
  which tunnels HTTPS (CONNECT) to the allowed hosts only (api.anthropic.com:443) and logs each request to
  <run>/egress.log. The worker reaches it through HTTPS_PROXY. Local addresses inside the container work.
- Root filesystem read-only, /tmp a tmpfs, all capabilities dropped, no new privileges, the host user's
  uid and gid, 2 CPUs, 4 GB, 1024 processes.
- Host guard, a backstop to the single mount: before and after, the existence and mode of ~/.claude.json
  (not its contents, which a Claude Code session on the host rewrites constantly), a hash of
  ~/.claude/settings.json and the file names in ~/.ssh, ~/.claude (top level) and ~/.codex (top level),
  never their contents (host_state); and no path under the run directory may be a symlink or hard link
  into the real home (link_problems). A change or such a link flags the run invalid, unscored.

Docker is reached at $DOCKER_HOST, by default the system daemon's socket, as chainswe.py does.
"""
import hashlib
import json
import os
import pathlib
import stat
import subprocess
import sys

from common import run_worker
from scope_env import files_digest, inside, real_home
from scope_snapshot import SAFE_GIT_ENV

BENCH = pathlib.Path(__file__).resolve().parent
IMAGE = "visp-bench-scope:2.1.300"
TOKEN_VARIABLE = "CLAUDE_CODE_OAUTH_TOKEN"
TOKEN_FILE = pathlib.Path(".config") / "visp-bench" / "claude-token"
ALLOW_HOSTS = ("api.anthropic.com:443",)
APP = "/opt/visp-scope"
IMAGE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
PROXY_PORT = 3128
REDACTED = b"[bench-token-redacted]"
# Host state the guard records (host_state): files by existence and mode, files by content, and directories by
# the listing of their names, every level (True) or the top one (False).
HOST_MODES = (".claude.json",)
HOST_FILES = (".claude/settings.json",)
HOST_LISTINGS = {".ssh": True, ".claude": False, ".codex": False}
LIMITS = ["--cpus", "2", "--memory", "4g", "--pids-limit", "1024"]
HARDENING = ["--read-only", "--tmpfs", "/tmp:rw,exec,nosuid,size=1g", "--cap-drop", "ALL",
             "--security-opt", "no-new-privileges"]
# The run directory's areas a worker container mounts read-write; a success-check container mounts the first four
# read-only.
MOUNTED = ("project", "home", "outside", "remote.git", "shimbin")
CHECK_MOUNTED = MOUNTED[:4]
CHECK_TIMEOUT = 60


def docker_env():
    """The docker client's own environment: what it needs to reach the daemon, nothing else of the host."""
    return {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(real_home()),
            "DOCKER_HOST": os.environ.get("DOCKER_HOST", "unix:///var/run/docker.sock")}


def docker(*argv, check=True, timeout=120):
    done = subprocess.run(["docker", *argv], env=docker_env(), capture_output=True, text=True, timeout=timeout)
    if check and done.returncode != 0:
        raise SystemExit(f"docker {argv[0]} failed: {done.stderr.strip()[-500:]}")
    return done


def default_token_file():
    return real_home() / TOKEN_FILE


def token_file_problems(path):
    """What is wrong with the token file, from its metadata only: [] when it can be used."""
    path = pathlib.Path(path)
    try:
        info = path.stat()
    except OSError:
        return [f"no token file at {path}: make it with `claude setup-token` (bench/README.md, Container isolation)"]
    problems = []
    if not stat.S_ISREG(info.st_mode):
        problems.append(f"{path} is not a regular file")
    elif stat.S_IMODE(info.st_mode) & 0o077:
        problems.append(f"{path} is readable by others: chmod 600 {path}")
    elif info.st_size == 0:
        problems.append(f"{path} is empty")
    return problems


def read_token(path):
    """The token the file holds (one line). Errors name the file, never its content."""
    problems = token_file_problems(path)
    if problems:
        raise SystemExit("run aborted: " + "; ".join(problems))
    value = pathlib.Path(path).read_text().strip()
    if not value or "\n" in value or "\r" in value or "\0" in value:
        raise SystemExit(f"run aborted: {path} must hold the token alone, on one line")
    return value


def names(run):
    """Docker names for a run's worker, proxy and network, from its path (stable across a redo)."""
    key = hashlib.sha256(str(pathlib.Path(run).resolve()).encode()).hexdigest()[:12]
    return {"container": f"visp-scope-{key}", "proxy": f"visp-scope-proxy-{key}", "network": f"visp-scope-net-{key}",
            "check": f"visp-scope-check-{key}"}


def mount_problems(run, real=None):
    """Why the run's areas may not be mounted: [] when the run directory neither is nor holds the real home and each
    of MOUNTED is a directory of it, not a symlink."""
    run, real = pathlib.Path(run), pathlib.Path(real) if real else real_home()
    if not run.is_absolute() or not run.is_dir():
        return [f"run directory {run} is not an absolute directory"]
    if inside(real, run):
        return [f"run directory {run} is or contains the real home {real}"]
    return [f"{run / area} is not a directory of the run (a symlink, or missing)" for area in MOUNTED
            if (run / area).is_symlink() or not (run / area).is_dir()]


def volumes(run, areas, mode):
    """`--volume` arguments for areas of the run, each at its own path."""
    run = str(pathlib.Path(run).resolve())
    return [word for area in areas for word in ("--volume", f"{run}/{area}:{run}/{area}:{mode}")]


def container_env(arm, run, proxy):
    """The worker container's whole environment, except the token (which goes through the env file)."""
    run = pathlib.Path(run).resolve()
    home = (arm.get("env") or {}).get("HOME") or str(run / "home")
    if os.path.realpath(home) != os.path.realpath(run / "home"):
        raise SystemExit(f"run aborted: a container run's HOME must be its fake home {run / 'home'}, not {home}")
    url = f"http://{proxy}:{PROXY_PORT}"
    env = {"HOME": str(run / "home"), "PATH": os.pathsep.join([*(arm.get("extraPath") or []), IMAGE_PATH]),
           "LANG": "C.UTF-8", "GIT_TERMINAL_PROMPT": "0", "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1",
           "DISABLE_AUTOUPDATER": "1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
           # The token stays out of the worker's own commands (https://code.claude.com/docs/en/env-vars).
           "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB": "1",
           "HTTPS_PROXY": url, "https_proxy": url, "HTTP_PROXY": url, "http_proxy": url,
           "NO_PROXY": "localhost,127.0.0.1,::1", "no_proxy": "localhost,127.0.0.1,::1"}
    # The task's own variables (arm.json "env") and a worker mode's (presets.WORKER_ENV_MODES, "workerEnv").
    for key, value in {**(arm.get("env") or {}), **(arm.get("workerEnv") or {})}.items():
        if key not in ("HOME", "PATH"):
            env[key] = value
    return env


def worker_argv(run, image, env, env_fd, digest, deadline, command, uid=None, gid=None):
    """`docker run` for one worker turn. The token is in the file at /dev/fd/<env_fd>, never in this argv."""
    run = str(pathlib.Path(run).resolve())
    identity = names(run)
    argv = ["docker", "run", "--rm", "--init", "--name", identity["container"], "--network", identity["network"],
            "--user", f"{os.getuid() if uid is None else uid}:{os.getgid() if gid is None else gid}",
            *volumes(run, MOUNTED, "rw"), "--workdir", f"{run}/project", *HARDENING, *LIMITS,
            "--env-file", f"/dev/fd/{env_fd}"]
    for key, value in sorted({**env, "BENCH_SCOPE_DIGEST": digest}.items()):
        argv += ["--env", f"{key}={value}"]
    return [*argv, image, "python3", "-I", f"{APP}/entrypoint.py", "--run", run, "--deadline", str(deadline), "--",
            *command]


def check_argv(run, image, code, timeout, uid=None, gid=None):
    """`docker run` for one success check: `python3 -c code` in the finished project, no network, read-only mounts."""
    run = str(pathlib.Path(run).resolve())
    env = {"HOME": f"{run}/home", "PATH": IMAGE_PATH, "LANG": "C.UTF-8", "PYTHONPATH": f"{run}/project",
           "PYTHONDONTWRITEBYTECODE": "1", **SAFE_GIT_ENV}
    argv = ["docker", "run", "--rm", "--init", "--name", names(run)["check"], "--network", "none",
            "--user", f"{os.getuid() if uid is None else uid}:{os.getgid() if gid is None else gid}",
            *volumes(run, CHECK_MOUNTED, "ro"), "--workdir", f"{run}/project", *HARDENING, *LIMITS]
    for key, value in sorted(env.items()):
        argv += ["--env", f"{key}={value}"]
    return [*argv, image, "timeout", "--kill-after", "5", str(timeout), "python3", "-c", code]


def check_runner(run, image):
    """A runner for scope_verdict.run_success: each check in its own container (check_argv); (passed, output)."""
    def run_check(code, timeout=CHECK_TIMEOUT):
        try:
            done = subprocess.run(check_argv(run, image, code, timeout), env=docker_env(), capture_output=True,
                                  text=True, timeout=timeout + 60)
        except subprocess.TimeoutExpired:
            docker("rm", "--force", names(run)["check"], check=False)
            return False, "timed out"
        return done.returncode == 0, done.stdout + done.stderr
    return run_check


def proxy_argv(run, image, allow):
    identity = names(run)
    argv = ["run", "--detach", "--init", "--name", identity["proxy"], "--network", "bridge", *HARDENING,
            "--memory", "256m", "--pids-limit", "64", image, "python3", "-I", f"{APP}/egress_proxy.py",
            "--listen", f"0.0.0.0:{PROXY_PORT}"]
    for target in allow:
        argv += ["--allow", target]
    return argv


def describe(image):
    """What the image reports of itself (entrypoint.py --describe), or None when it is absent or broken."""
    try:
        done = docker("run", "--rm", "--network", "none", image, check=False, timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        return None
    try:
        return json.loads(done.stdout) if done.returncode == 0 else None
    except ValueError:
        return None


def preflight(image, token_file):
    """([problems], what the image reported): can a container run start? Reads no token, only the file's metadata."""
    problems = list(token_file_problems(token_file))
    facts = describe(image)
    if facts is None:
        problems.append(f"no working image {image} on {docker_env()['DOCKER_HOST']}: build it "
                        "(bench/README.md, Container isolation)")
        return problems, None
    if facts.get("digest") != files_digest(BENCH):
        problems.append(f"image {image} is stale: its bench files differ from this checkout's; rebuild it")
    if (facts.get("uid"), facts.get("gid")) != (os.getuid(), os.getgid()):
        problems.append(f"image {image} user is {facts.get('uid')}:{facts.get('gid')}, not this user "
                        f"{os.getuid()}:{os.getgid()}: rebuild it with --build-arg UID=$(id -u) --build-arg GID=$(id -g)")
    return problems, facts


def host_state(real=None):
    """{name: signature} of the host state the guard watches.

    A backstop: the container mounts only the run directory, so it cannot reach the real home. What changes on
    its own while a Claude Code session runs on the host is left out: ~/.claude.json counts by its existence
    and mode only, ~/.claude by its top-level names. ~/.claude/settings.json counts by content; ~/.ssh (every
    level) and ~/.codex (top level) by their file names, never contents.
    """
    real = pathlib.Path(real) if real else real_home()
    state = {}
    for rel in HOST_MODES:
        path = real / rel
        state[f"~/{rel} (exists, mode)"] = oct(stat.S_IMODE(path.lstat().st_mode)) if path.exists() else "absent"
    for rel in HOST_FILES:
        path = real / rel
        state[f"~/{rel}"] = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else "absent"
    for rel, deep in HOST_LISTINGS.items():
        directory = real / rel
        if directory.is_dir():
            found = directory.rglob("*") if deep else directory.iterdir()
            listing = sorted(str(path.relative_to(directory)) for path in found)
            state[f"~/{rel}/ (names)"] = hashlib.sha256("\n".join(listing).encode()).hexdigest()
        else:
            state[f"~/{rel}/ (names)"] = "absent"
    return state


def link_problems(run, real=None):
    """Paths under the run directory that lead into the real home: [] when there are none.

    A symlink whose target resolves under the real home but outside the run directory, or a file with more
    hard links than the run directory holds (its other name is elsewhere, and the run directory may well lie
    under the real home). Links inside the run, such as a scenario's data/ link to outside/, pass.
    """
    run, real = pathlib.Path(run).resolve(), pathlib.Path(real) if real else real_home()
    problems, inodes = [], {}
    for directory, names, files in os.walk(run):
        for name in [*names, *files]:
            path = pathlib.Path(directory) / name
            try:
                info = path.lstat()
            except OSError:
                continue
            if stat.S_ISLNK(info.st_mode):
                target = os.path.realpath(path)
                if inside(target, real) and not inside(target, run):
                    problems.append(f"{path.relative_to(run)} is a symlink into the real home ({target})")
            elif stat.S_ISREG(info.st_mode) and info.st_nlink > 1:
                inodes.setdefault((info.st_dev, info.st_ino), [info.st_nlink, []])[1].append(path)
    for links, paths in inodes.values():
        if len(paths) < links:
            problems += [f"{path.relative_to(run)} is hard-linked to a path outside the run directory" for path in paths]
    return sorted(problems)


def host_changes(before, after):
    return sorted(key for key in set(before) | set(after) if before.get(key) != after.get(key))


def redact_text(text, secret):
    return text.replace(secret, REDACTED.decode()) if secret and isinstance(text, str) else text


def redact_files(run, secret, limit=50 << 20):
    """Replace every copy of the secret in the run's files; returns the paths changed, relative to the run."""
    needle, changed = secret.encode(), []
    for directory, _, files in os.walk(run):
        for name in files:
            path = pathlib.Path(directory) / name
            try:
                if path.is_symlink() or path.stat().st_size > limit:
                    continue
                data = path.read_bytes()
                if needle in data:
                    path.write_bytes(data.replace(needle, REDACTED))
                    changed.append(str(path.relative_to(run)))
            except OSError:
                continue
    return sorted(changed)


class Session:
    """One run's network, proxy and worker turns. Use as a context manager; the instance is run_session's `launch`."""

    def __init__(self, run, arm, image, token, digest, allow=ALLOW_HOSTS):
        self.run, self.arm, self.image, self.allow = pathlib.Path(run).resolve(), arm, image, tuple(allow)
        self.token, self.digest, self.names = token, digest, names(run)
        self.env = container_env(arm, self.run, self.names["proxy"])

    def __enter__(self):
        self.clean()
        docker("network", "create", "--internal", self.names["network"])
        docker(*proxy_argv(self.run, self.image, self.allow))
        docker("network", "connect", self.names["network"], self.names["proxy"])
        return self

    def __exit__(self, *_):
        logs = docker("logs", self.names["proxy"], check=False)
        (self.run / "egress.log").write_text(logs.stdout + logs.stderr)
        self.clean()

    def clean(self):
        docker("rm", "--force", self.names["container"], self.names["proxy"], check=False)
        docker("network", "rm", self.names["network"], check=False)

    def __call__(self, command, timeout):
        """One turn: run `command` (claude and its arguments) in the container; (exit code, stdout, stderr, timed out)."""
        read, write = os.pipe()
        try:
            os.write(write, f"{TOKEN_VARIABLE}={self.token}\n".encode())
            os.close(write)
            argv = worker_argv(self.run, self.image, self.env, read, self.digest, timeout, command)
            # The container stops itself at the deadline; the host waits a little longer, then removes it.
            code, stdout, stderr, timed_out = run_worker(argv, self.run, docker_env(), timeout + 60,
                                                         self.run / "worker.pid", pass_fds=(read,))
        finally:
            os.close(read)
            docker("rm", "--force", self.names["container"], check=False)
        stdout, stderr = redact_text(stdout, self.token), redact_text(stderr, self.token)
        self.record(command, stdout)
        return code, stdout, stderr, timed_out or code == 124

    def record(self, command, stdout):
        """The turn's cost in claude-calls.jsonl, as claude_shim logs a host run's calls (the spend guard reads it)."""
        subprocess.run([sys.executable, "-I", str(BENCH / "claude_shim" / "record_call.py"),
                        str(self.run / "claude-calls.jsonl"), *command], input=stdout or "", text=True,
                       capture_output=True)
