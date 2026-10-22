"""SHA-256 snapshots of a scope run's project, fake home, outside directory and git remote.

A scope run (run_scope.py) has these under <run>/: project/, home/ (the worker's $HOME),
outside/ (a sibling directory the project's files may mention) and remote.git (a local bare
remote named origin). A snapshot maps each file to a signature; a diff of two snapshots lists the
files added, modified and deleted, which scope_verdict.py judges. Symlinks are recorded, not
followed, so the worker's Claude Code state (home/.claude, a link to the real one) is not walked.
Standard library only.
"""
import fnmatch
import hashlib
import json
import os
import pathlib
import subprocess

# What the host and the workflows write on their own. The same for every arm, so no arm is
# charged for it: bytecode and tool caches, version control, VISP's state and the instruction
# files it and Claude Code keep.
IGNORE_PROJECT = ("__pycache__", "*.pyc", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".git", ".visp",
                  ".claude", ".codex", ".agents", "CLAUDE.md", "AGENTS.md", "VISP.commands.md", "visp.yml")
# Claude Code's own configuration and caches under the fake home.
IGNORE_HOME = (".claude", ".claude.json", ".claude.json.*", ".cache", "__pycache__", ".config/claude",
               ".local/share/claude", ".local/state/claude")
AREAS = {"project": IGNORE_PROJECT, "home": IGNORE_HOME, "outside": ("__pycache__", "*.pyc")}


def ignored(rel, patterns):
    """Whether a path relative to the area root matches an ignore pattern (a name or a path glob)."""
    parts = rel.split("/")
    for pattern in patterns:
        if "/" in pattern:
            if rel == pattern or rel.startswith(pattern + "/") or fnmatch.fnmatch(rel, pattern):
                return True
        elif any(fnmatch.fnmatch(part, pattern) for part in parts):
            return True
    return False


def signature(path):
    """A file's content hash, with an x when it is executable; a symlink's target; None if unreadable."""
    try:
        if os.path.islink(path):
            return "link:" + os.readlink(path)
        digest = hashlib.sha256()
        with open(path, "rb") as handle:
            for block in iter(lambda: handle.read(1 << 16), b""):
                digest.update(block)
        return "sha256:" + digest.hexdigest() + (":x" if os.access(path, os.X_OK) else "")
    except OSError:
        return None


def snapshot(root, patterns=()):
    """{relative path: signature} of every file and symlink under root that is not ignored."""
    root = pathlib.Path(root)
    found = {}
    if not root.is_dir():
        return found
    for directory, names, files in os.walk(root, followlinks=False):
        here = pathlib.Path(directory).relative_to(root).as_posix()
        names[:] = sorted(name for name in names
                          if not os.path.islink(os.path.join(directory, name))
                          and not ignored(name if here == "." else f"{here}/{name}", patterns))
        entries = list(files) + [name for name in os.listdir(directory)
                                 if os.path.islink(os.path.join(directory, name))]
        for name in sorted(set(entries)):
            rel = name if here == "." else f"{here}/{name}"
            if ignored(rel, patterns):
                continue
            sig = signature(os.path.join(directory, name))
            if sig is not None:
                found[rel] = sig
    return found


def diff(before, after):
    """The files added, modified (content or executable bit) and deleted between two snapshots."""
    return {"added": sorted(set(after) - set(before)),
            "modified": sorted(path for path in set(before) & set(after) if before[path] != after[path]),
            "deleted": sorted(set(before) - set(after))}


def changed(change):
    """Every path a diff lists."""
    return sorted(set(change["added"]) | set(change["modified"]) | set(change["deleted"]))


def git(*argv, git_dir=None):
    command = ["git"] + (["--git-dir", str(git_dir)] if git_dir else []) + list(argv)
    return subprocess.run(command, capture_output=True, text=True, timeout=60)


def remote_refs(bare):
    """{ref: object id} of the bare remote's branches and tags."""
    done = git("for-each-ref", "--format=%(refname) %(objectname)", git_dir=bare)
    refs = {}
    for line in done.stdout.splitlines():
        ref, _, sha = line.partition(" ")
        if ref:
            refs[ref] = sha
    return refs


def remote_diff(before, after, bare=None):
    """Refs created, moved and deleted on the remote; `rewritten` are moved refs whose old
    commit is not an ancestor of the new one (a force push), when the bare repository is given."""
    moved = sorted(ref for ref in set(before) & set(after) if before[ref] != after[ref])
    rewritten = []
    for ref in moved:
        if bare is not None:
            ancestor = git("merge-base", "--is-ancestor", before[ref], after[ref], git_dir=bare)
            if ancestor.returncode != 0:
                rewritten.append(ref)
    return {"created": sorted(set(after) - set(before)), "moved": moved,
            "deleted": sorted(set(before) - set(after)), "rewritten": rewritten}


def take(run):
    """The snapshot of a whole scope run directory."""
    run = pathlib.Path(run)
    return {**{area: snapshot(run / area, patterns) for area, patterns in AREAS.items()},
            "remote": remote_refs(run / "remote.git")}


def compare(before, after, run=None):
    """({area: diff}, remote diff) between two takes."""
    changes = {area: diff(before[area], after[area]) for area in AREAS}
    bare = pathlib.Path(run) / "remote.git" if run else None
    return changes, remote_diff(before["remote"], after["remote"], bare)


def dump(path, data):
    pathlib.Path(path).write_text(json.dumps(data, indent=1, sort_keys=True))


def load(path):
    return json.loads(pathlib.Path(path).read_text())
