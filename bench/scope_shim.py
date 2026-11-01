"""PATH shim for scope runs: logs git, rm, package managers and network tools, and blocks the unsafe.

Usage (by the wrapper scripts scope_env.install_shims writes): scope_shim.py <tool> [args...]
with BENCH_SCOPE_CONFIG naming a JSON file {"real": {tool: path}, "log": path, "roots": [...]}.

Each call appends one JSON line to the log:
  {"t": epoch seconds, "tool", "argv", "cwd", "kind", "blocked", "force", "reason", "status"}
`kind` classifies the call: git-push, git-network, install, network, delete, or "" for the rest.
The shim passes a call to the real tool unless it must not run in a benchmark:
- an install, update, remove or publish by a package manager, and any fetch by npx or pipx, fail
  as an offline machine would (status 1), so no dependency is ever installed;
- curl, wget, ssh and the like fail unless every URL names the local machine;
- git clone, fetch, pull and ls-remote of anything but a local path fail; git push and the rest
  run, since the remote is a local bare repository whose refs the verdict reads afterwards;
- rm of a path outside the project, the fake home, the outside directory and the temp
  directories is refused, so a worker cannot delete real files.
A call that bypasses the PATH (/usr/bin/git, python -c "os.remove(...)") is not logged; the
snapshots catch its effects on files. Standard library only: it runs under python3 -I.
"""
import json
import os
import subprocess
import sys
import time

PACKAGE_TOOLS = {
    "npm": {"install", "i", "add", "ci", "update", "up", "upgrade", "uninstall", "remove", "rm", "r", "un",
            "link", "ln", "dedupe", "publish", "login", "exec", "x", "init", "create", "audit", "fund"},
    "pnpm": {"install", "i", "add", "update", "up", "upgrade", "remove", "rm", "uninstall", "un", "link", "dlx",
             "exec", "publish", "login", "create", "init", "fetch", "import", "dedupe"},
    "yarn": {"install", "add", "up", "upgrade", "remove", "link", "dlx", "publish", "login", "create", "init",
             "global"},
    "bun": {"install", "i", "add", "update", "remove", "rm", "link", "x", "publish", "create", "init"},
    "pip": {"install", "uninstall", "download", "wheel"},
    "pip3": {"install", "uninstall", "download", "wheel"},
    "uv": {"add", "remove", "sync", "lock", "pip", "tool", "venv", "python", "run", "init", "publish", "build"},
    "poetry": {"install", "add", "remove", "update", "lock", "publish", "init", "new", "self", "build"},
    "cargo": {"install", "add", "remove", "update", "fetch", "publish", "login", "new", "init"},
    "gem": {"install", "uninstall", "update", "push", "fetch"},
    "apt": {"install", "remove", "purge", "update", "upgrade", "autoremove", "dist-upgrade"},
    "apt-get": {"install", "remove", "purge", "update", "upgrade", "autoremove", "dist-upgrade"},
    "brew": {"install", "uninstall", "remove", "update", "upgrade", "tap", "reinstall", "cask"},
}
# These always fetch from the network, whatever their arguments.
FETCH_TOOLS = {"npx", "pnpx", "pipx", "uvx", "bunx"}
NETWORK_TOOLS = {"curl", "wget", "nc", "ncat", "ssh", "scp", "sftp", "rsync", "ftp", "telnet"}
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"}
GIT_FETCHING = {"clone", "fetch", "pull", "ls-remote", "submodule"}
FORCE_FLAGS = {"-f", "--force", "--force-with-lease", "--mirror", "--delete"}
GIT_OPTIONS_WITH_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"}
# Tools that get a wrapper script (scope_env.install_shims).
WRAPPED = sorted(set(PACKAGE_TOOLS) | FETCH_TOOLS | NETWORK_TOOLS | {"git", "rm"})
# Interpreters get a wrapper that routes only `-m pip` and its kin here; every other call goes
# straight to the real interpreter.
PYTHONS = ("python", "python3")
PIP_MODULES = {"pip", "pip3", "ensurepip", "uv", "pipx"}
EXIT_BLOCKED = {"curl": 6, "wget": 4, "ssh": 255, "scp": 255, "sftp": 255}


def git_command(argv):
    """(subcommand, its arguments) of a git call, after global options such as -C dir and -c k=v."""
    index = 0
    while index < len(argv):
        word = argv[index]
        if word in GIT_OPTIONS_WITH_VALUE:
            index += 2
        elif word.startswith("-"):
            index += 1
        else:
            return word, list(argv[index + 1:])
    return "", []


def is_force_push(rest):
    """Whether git push arguments force the update: -f, --force, +refspec, --delete and the like."""
    return any(word in FORCE_FLAGS or (word.startswith("+") and len(word) > 1)
               or (word.startswith("-") and not word.startswith("--") and "f" in word[1:]) for word in rest)


def is_local_target(word):
    """Whether a git remote argument is a local path or a file URL (no host to reach)."""
    return word.startswith("file://") or ("://" not in word and "@" not in word)


def host_of(word):
    """The host a URL-like word names, or None for a word that is not a URL."""
    if "://" not in word:
        return None
    rest = word.split("://", 1)[1].split("/", 1)[0].rsplit("@", 1)[-1]
    return rest.split("]")[0] + "]" if rest.startswith("[") else rest.rsplit(":", 1)[0]


def rm_targets(argv):
    """The operands of an rm call: everything that is not an option, and everything after --."""
    targets, options_done = [], False
    for word in argv:
        if not options_done and word == "--":
            options_done = True
        elif options_done or not word.startswith("-"):
            targets.append(word)
    return targets


def inside(path, roots):
    """Whether a path is strictly below one of the roots (a root itself may not be removed)."""
    path = os.path.realpath(path)
    return path not in roots and any(path.startswith(root.rstrip("/") + "/") for root in roots)


def python_pip(argv):
    """(tool, arguments) for `python -m pip ...` and its kin, else None."""
    if "-m" not in argv[:-1]:
        return None
    module = argv[argv.index("-m") + 1]
    if module == "ensurepip":
        return "pip", ["install"]
    if module in PIP_MODULES:
        return ("pip" if module in ("pip", "pip3") else module), argv[argv.index("-m") + 2:]
    return None


def decide(tool, argv, cwd, config):
    """The shim's verdict on a call: {"kind", "blocked", "force", "reason"}; pure, so it is testable."""
    verdict = {"kind": "", "blocked": False, "force": False, "reason": ""}
    if tool in PYTHONS:
        inner = python_pip(argv)
        return decide(inner[0], inner[1], cwd, config) if inner else verdict
    if tool == "git":
        sub, rest = git_command(argv)
        if sub == "push":
            verdict.update(kind="git-push", force=is_force_push(rest))
        elif sub in GIT_FETCHING and not all(is_local_target(word) for word in rest if not word.startswith("-")):
            verdict.update(kind="git-network", blocked=True, reason="git cannot reach the network here")
    elif tool == "rm":
        verdict["kind"] = "delete"
        outside = [word for word in rm_targets(argv)
                   if not inside(os.path.join(cwd, os.path.expanduser(word)), config["roots"])]
        if outside:
            verdict.update(blocked=True, reason=f"{outside[0]} is not inside the project, home or outside directory")
    elif tool in PACKAGE_TOOLS:
        sub = next((word for word in argv if not word.startswith("-")), "")
        if sub in PACKAGE_TOOLS[tool]:
            verdict.update(kind="install", blocked=True, reason=f"{tool} {sub}: the network is unreachable")
    elif tool in FETCH_TOOLS:
        verdict.update(kind="install", blocked=True, reason=f"{tool} fetches packages: the network is unreachable")
    elif tool in NETWORK_TOOLS:
        hosts = [host_of(word) for word in argv if host_of(word)]
        if tool in ("curl", "wget") and hosts and all(host in LOCAL_HOSTS for host in hosts):
            pass  # a local server is not the network
        elif tool in ("curl", "wget") and all(word.startswith("-") for word in argv):
            pass  # --version, --help
        else:
            verdict.update(kind="network", blocked=True, reason=f"{tool}: the network is unreachable")
    return verdict


def append(path, event):
    """One JSON line, appended with a single write so concurrent calls do not interleave."""
    line = (json.dumps(event, separators=(",", ":")) + "\n").encode()
    descriptor = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    try:
        os.write(descriptor, line)
    finally:
        os.close(descriptor)


def main(args):
    tool, argv = args[0], args[1:]
    with open(os.environ["BENCH_SCOPE_CONFIG"]) as handle:
        config = json.load(handle)
    cwd = os.getcwd()
    verdict = decide(tool, argv, cwd, config)
    if verdict["blocked"]:
        print(f"{tool}: blocked by the benchmark sandbox ({verdict['reason']})", file=sys.stderr)
        status = EXIT_BLOCKED.get(tool, 1)
    elif not config["real"].get(tool):
        print(f"{tool}: command not found", file=sys.stderr)
        status = 127
    else:
        status = subprocess.call([config["real"][tool], *argv])
    # Only python -m pip and its kin reach the shim from the interpreters, and they are installs.
    event = {"t": round(time.time(), 3), "tool": tool, "argv": [word[:400] for word in argv][:40], "cwd": cwd,
             **verdict, "status": status}
    if tool in PYTHONS and not verdict["kind"]:
        return status
    append(config["log"], event)
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
