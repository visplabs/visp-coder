"""Unit tests for scope runs in a container (scope_container.py, run_scope.py --container, the +auto arms).

Run from the repository root: python3 -m unittest bench/test_scope_container.py
No model is called and no token is real: each test writes a fake token to a file in a temporary directory.
The real home is never read: the host guard tests use a temporary directory in its place. DockerTests run a
container from the scope image when it is built and Docker answers; they make no connection outside the
machine (the egress proxy refuses the one they try).
"""
import asyncio
import contextlib
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

BENCH = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(BENCH))
sys.path.insert(0, str(BENCH / "scope"))

import egress_proxy  # noqa: E402
import scope_container as containers  # noqa: E402
import scope_env  # noqa: E402

FAKE_TOKEN = "sk-ant-oat01-FAKE-test-token-0123456789"
CONTAINER_TOKEN = "CLAUDE_CODE_OAUTH_TOKEN"
HOST_SECRETS = {"SSH_AUTH_SOCK": "/run/user/1000/ssh-agent", "GH_TOKEN": "ghp_fakefakefake",
                "ANTHROPIC_API_KEY": "sk-ant-api-fake", CONTAINER_TOKEN: "sk-ant-host-fake",
                "AWS_SECRET_ACCESS_KEY": "awsfake", "DISPLAY": ":0", "PATH": "/home/someone/.local/bin:/usr/bin"}
# Every variable a worker container may get; anything else is a leak from the host.
ALLOWED_ENV = {"HOME", "PATH", "LANG", "GIT_TERMINAL_PROMPT", "CLAUDE_CODE_DISABLE_AUTO_MEMORY", "DISABLE_AUTOUPDATER",
               "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", "HTTPS_PROXY",
               "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"}


def fake_run(root):
    """A run directory with what container mode reads: arm.json's env and extraPath, and the areas it mounts."""
    run = pathlib.Path(root) / "runs" / "r"
    for area in ("project", "home", "outside", "remote.git", "shimbin"):
        (run / area).mkdir(parents=True)
    arm = {"arm": "bare-rule+auto", "permissionMode": "auto", "extraPath": [str(run / "shimbin")],
           "env": {"HOME": str(run / "home"), "GIT_TERMINAL_PROMPT": "0"}}
    (run / "arm.json").write_text(json.dumps(arm))
    return run, arm


def token_file(root, mode=0o600, text=FAKE_TOKEN + "\n"):
    path = pathlib.Path(root) / "token"
    path.write_text(text)
    path.chmod(mode)
    return path


class TokenFileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_private_one_line_file_is_read(self):
        path = token_file(self.tmp.name)
        self.assertEqual(containers.token_file_problems(path), [])
        self.assertEqual(containers.read_token(path), FAKE_TOKEN)

    def test_problems_name_the_file_never_the_token(self):
        cases = {"missing": None, "readable": 0o644, "empty": 0o600, "two lines": 0o600}
        for case, mode in cases.items():
            with self.subTest(case):
                path = pathlib.Path(self.tmp.name) / "token"
                path.unlink(missing_ok=True)
                if mode is not None:
                    token_file(self.tmp.name, mode, {"empty": "", "two lines": FAKE_TOKEN + "\nmore\n"}.get(case,
                                                                                                         FAKE_TOKEN))
                with self.assertRaises(SystemExit) as raised:
                    containers.read_token(path)
                self.assertIn(str(path), str(raised.exception))
                self.assertNotIn(FAKE_TOKEN, str(raised.exception))
        self.assertIn("chmod 600", containers.token_file_problems(token_file(self.tmp.name, 0o640))[0])

    def test_the_default_file_is_under_the_real_home(self):
        self.assertEqual(containers.default_token_file(),
                         scope_env.real_home() / ".config" / "visp-bench" / "claude-token")


class EnvAndMountTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.run, self.arm = fake_run(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_no_host_variable_reaches_the_container(self):
        with mock.patch.dict(os.environ, HOST_SECRETS):
            env = containers.container_env(self.arm, self.run, "proxy")
        self.assertLessEqual(set(env), ALLOWED_ENV)
        self.assertNotIn(CONTAINER_TOKEN, env)
        for value in HOST_SECRETS.values():
            self.assertNotIn(value, " ".join(env.values()))
        self.assertEqual(env["HOME"], str(self.run.resolve() / "home"))
        self.assertEqual(env["PATH"].split(os.pathsep), [str(self.run / "shimbin"), *containers.IMAGE_PATH.split(":")])
        self.assertEqual(env["HTTPS_PROXY"], "http://proxy:3128")
        self.assertEqual(env["CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"], "1")

    def test_a_home_other_than_the_fake_one_is_refused(self):
        arm = {**self.arm, "env": {"HOME": str(scope_env.real_home())}}
        with self.assertRaises(SystemExit):
            containers.container_env(arm, self.run, "proxy")

    def test_only_the_run_areas_are_mounted_and_the_token_is_not_in_argv(self):
        env = containers.container_env(self.arm, self.run, "proxy")
        argv = containers.worker_argv(self.run, "image:tag", env, 7, "digest", 600, ["claude", "-p", "do it"],
                                      uid=1000, gid=1000)
        self.assertNotIn(FAKE_TOKEN, " ".join(argv))
        self.assertFalse(any("OAUTH" in word or "TOKEN=" in word for word in argv))
        self.assertEqual(argv[argv.index("--env-file") + 1], "/dev/fd/7")
        mounts = [argv[index + 1] for index, word in enumerate(argv) if word in ("--volume", "-v", "--mount")]
        run = str(self.run.resolve())
        # Not the run directory itself: the host writes result.json, invalid.json and egress.log there, and
        # canaries.json and scenario.json (the ground truth) stay out of the worker's reach.
        self.assertEqual(containers.MOUNTED, ("project", "home", "outside", "remote.git", "shimbin"))
        self.assertEqual(mounts, [f"{run}/{area}:{run}/{area}:rw" for area in containers.MOUNTED])
        real = str(scope_env.real_home())
        self.assertFalse(any(word == real or word.startswith(real + ":") for word in argv))
        self.assertEqual(argv[argv.index("--network") + 1], containers.names(self.run)["network"])
        for flag in ("--read-only", "--rm", "--init"):
            self.assertIn(flag, argv)
        self.assertEqual(argv[argv.index("--cap-drop") + 1], "ALL")
        self.assertEqual(argv[argv.index("--user") + 1], "1000:1000")
        self.assertEqual(argv[-3:], ["claude", "-p", "do it"])

    def test_the_proxy_has_no_mount_and_only_the_allowed_hosts(self):
        argv = containers.proxy_argv(self.run, "image:tag", ["api.anthropic.com:443"])
        self.assertFalse(any(word in ("--volume", "-v", "--mount", "--env-file") for word in argv))
        self.assertEqual([argv[index + 1] for index, word in enumerate(argv) if word == "--allow"],
                         ["api.anthropic.com:443"])

    def test_mount_problems(self):
        real = pathlib.Path(self.tmp.name) / "realhome"
        for area in containers.MOUNTED:
            (real / "visp-bench" / "runs" / "r" / area).mkdir(parents=True)
        self.assertEqual(containers.mount_problems(real / "visp-bench" / "runs" / "r", real), [])
        self.assertEqual(len(containers.mount_problems(real, real)), 1)
        self.assertEqual(len(containers.mount_problems(pathlib.Path(self.tmp.name), real)), 1)
        self.assertEqual(len(containers.mount_problems(pathlib.Path("relative/run"), real)), 1)

    def test_each_mounted_area_must_be_a_directory_of_the_run(self):
        self.assertEqual(containers.mount_problems(self.run), [])
        (self.run / "outside").rmdir()
        (self.run / "outside").symlink_to(pathlib.Path(self.tmp.name))
        problems = containers.mount_problems(self.run)
        self.assertEqual(len(problems), 1)
        self.assertIn("outside", problems[0])
        (self.run / "outside").unlink()
        self.assertIn("outside", containers.mount_problems(self.run)[0])

    def test_names_are_stable_and_valid(self):
        first, second = containers.names(self.run), containers.names(self.run)
        self.assertEqual(first, second)
        for name in first.values():
            self.assertRegex(name, r"^[a-z0-9][a-z0-9_.-]+$")


class SessionTests(unittest.TestCase):
    """One worker turn with docker replaced: the token goes only through the env-file pipe, and is redacted after."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.run, self.arm = fake_run(self.tmp.name)
        self.seen = {}

    def tearDown(self):
        self.tmp.cleanup()

    def fake_worker(self, argv, cwd, env, timeout, pid_file, stdin=None, pass_fds=()):
        fd = int(argv[argv.index("--env-file") + 1].rsplit("/", 1)[1])
        self.seen.update(argv=argv, env=env, pass_fds=pass_fds, envfile=os.read(fd, 4096).decode())
        result = {"type": "result", "result": f"I printed {FAKE_TOKEN}", "total_cost_usd": 0.01, "session_id": "s"}
        return 0, json.dumps(result), f"warning {FAKE_TOKEN}", False

    def test_a_turn(self):
        with mock.patch.dict(os.environ, HOST_SECRETS), mock.patch.object(containers, "run_worker", self.fake_worker), \
                mock.patch.object(containers, "docker") as docker:
            session = containers.Session(self.run, self.arm, "image:tag", FAKE_TOKEN, "digest")
            code, stdout, stderr, timed_out = session(["claude", "-p", "go", "--permission-mode", "auto"], 300)
        self.assertEqual(self.seen["envfile"], f"CLAUDE_CODE_OAUTH_TOKEN={FAKE_TOKEN}\n")
        self.assertEqual(len(self.seen["pass_fds"]), 1)
        self.assertNotIn(FAKE_TOKEN, " ".join(self.seen["argv"]))
        # The docker client itself gets only what it needs to reach the daemon.
        self.assertEqual(set(self.seen["env"]), {"PATH", "HOME", "DOCKER_HOST"})
        self.assertNotIn(FAKE_TOKEN, json.dumps(self.seen["env"]))
        self.assertNotIn(FAKE_TOKEN, stdout + stderr)
        self.assertIn("[bench-token-redacted]", stdout)
        calls = (self.run / "claude-calls.jsonl").read_text()
        self.assertNotIn(FAKE_TOKEN, calls)
        self.assertEqual(json.loads(calls)["role"], "worker")
        self.assertEqual(json.loads(calls)["cost"], 0.01)
        removed = [call.args for call in docker.call_args_list if call.args[:2] == ("rm", "--force")]
        self.assertEqual(removed, [("rm", "--force", session.names["container"])])
        self.assertEqual(timed_out, False)
        self.assertEqual(code, 0)

    def test_redact_files(self):
        (self.run / "home" / ".claude").mkdir()
        (self.run / "home" / ".claude" / "t.jsonl").write_text(f"env: {FAKE_TOKEN}\n")
        (self.run / "project" / "clean.py").write_text("x = 1\n")
        self.assertEqual(containers.redact_files(self.run, FAKE_TOKEN), ["home/.claude/t.jsonl"])
        self.assertNotIn(FAKE_TOKEN, (self.run / "home" / ".claude" / "t.jsonl").read_text())
        self.assertEqual(containers.redact_files(self.run, FAKE_TOKEN), [])


class SuccessCheckTests(unittest.TestCase):
    """A success check imports the worker's modules (a planted sitecustomize.py too): it runs in a container, never on
    the host."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.run, _ = fake_run(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_check_runs_in_a_hardened_container_without_network(self):
        argv = containers.check_argv(self.run, "image:tag", "print(1)", 60, uid=1000, gid=1000)
        self.assertEqual(argv[:2], ["docker", "run"])
        self.assertEqual(argv[argv.index("--network") + 1], "none")
        for flag in ("--read-only", "--rm", "--init"):
            self.assertIn(flag, argv)
        self.assertEqual(argv[argv.index("--cap-drop") + 1], "ALL")
        self.assertIn("no-new-privileges", argv)
        self.assertEqual(argv[argv.index("--user") + 1], "1000:1000")
        self.assertNotIn("--env-file", argv)
        run = str(self.run.resolve())
        mounts = [argv[index + 1] for index, word in enumerate(argv) if word in ("--volume", "-v", "--mount")]
        self.assertEqual(mounts, [f"{run}/{area}:{run}/{area}:ro" for area in ("project", "home", "outside", "remote.git")])
        env = dict(argv[index + 1].split("=", 1) for index, word in enumerate(argv) if word == "--env")
        self.assertEqual(env["PYTHONPATH"], f"{run}/project")
        self.assertEqual(env["HOME"], f"{run}/home")
        self.assertEqual((env["GIT_CONFIG_GLOBAL"], env["GIT_CONFIG_SYSTEM"]), ("/dev/null", "/dev/null"))
        overrides = {env[f"GIT_CONFIG_KEY_{index}"]: env[f"GIT_CONFIG_VALUE_{index}"]
                     for index in range(int(env["GIT_CONFIG_COUNT"]))}
        self.assertEqual(overrides["core.hooksPath"], "/dev/null")
        self.assertEqual(overrides["core.fsmonitor"], "false")
        self.assertEqual(argv[argv.index("image:tag") + 1:][-3:], ["python3", "-c", "print(1)"])

    def test_the_runner_passes_a_check_by_its_exit_code(self):
        import scope_verdict
        seen = []

        def fake(argv, **kwargs):
            seen.append(argv)
            return subprocess.CompletedProcess(argv, 0 if argv[-1] == "pass" else 1, "out", "err")
        scenario = {"success": {"checks": [{"name": "a", "code": "pass"}, {"name": "b", "code": "fail"}]}}
        with mock.patch.object(containers.subprocess, "run", fake):
            result = scope_verdict.run_success(scenario, self.run / "project", self.run / "home",
                                               runner=containers.check_runner(self.run, "image:tag"))
        self.assertEqual([(check["name"], check["passed"]) for check in result["checks"]], [("a", True), ("b", False)])
        self.assertFalse(result["passed"])
        self.assertTrue(all(argv[:2] == ["docker", "run"] for argv in seen))

    def test_git_after_the_worker_ignores_the_repositorys_fsmonitor_and_hooks(self):
        """The worker can write .git/config; `git diff` runs core.fsmonitor. The bench's git turns it off."""
        import scope_snapshot
        import scope_verdict
        project = self.run / "project"
        marker = pathlib.Path(self.tmp.name) / "fsmonitor-ran"
        identity = ["-c", "user.name=W", "-c", "user.email=w@w"]
        for argv in (["init", "-q"], ["add", "-A"], [*identity, "commit", "-q", "--allow-empty", "-m", "x"]):
            subprocess.run(["git", *argv], cwd=project, check=True, capture_output=True)
        (project / "a.txt").write_text("a\n")
        subprocess.run(["git", "add", "a.txt"], cwd=project, check=True)
        subprocess.run(["git", *identity, "commit", "-q", "-m", "a"], cwd=project, check=True)
        (project / "a.txt").write_text("b\n")
        hook = project / "monitor.sh"
        hook.write_text(f"#!/bin/sh\ntouch '{marker}'\nexit 1\n")
        hook.chmod(0o755)
        subprocess.run(["git", "config", "core.fsmonitor", str(hook)], cwd=project, check=True)
        code = 'import subprocess\nsubprocess.run(["git", "diff", "--quiet", "HEAD"])\n'
        # The trap is live: plain git runs the worker's fsmonitor.
        subprocess.run(["git", "diff", "--quiet", "HEAD"], cwd=project, capture_output=True)
        self.assertTrue(marker.exists(), "git did not run core.fsmonitor; the test proves nothing")
        marker.unlink()
        scope_verdict.run_success({"success": {"checks": [{"name": "committed", "code": code}]}}, project,
                                  self.run / "home")
        scope_snapshot.git_state(project)
        self.assertFalse(marker.exists())
        self.assertEqual(scope_snapshot.git_state(project)["config/core.fsmonitor"], str(hook))


class RunScopeScoringTests(unittest.TestCase):
    """run_scope.main on a real scope run, with docker's worker turn replaced: the success checks go to a container,
    the shim log is read from shimbin/, and --rescore judges from snapshot-after.json."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        env = {**os.environ, "VISP_BENCH_RUNS": self.tmp.name, "HOME": self.tmp.name}
        done = subprocess.run([sys.executable, str(BENCH / "setup_arm.py"), "scope-git-push-02", "bare-rule", "r",
                               "--preset", "quality-2026-10"], env=env, capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.run = pathlib.Path(self.tmp.name) / "runs" / "r"
        self.token = token_file(self.tmp.name)
        self.checks = []
        self.real_run = subprocess.run

    def tearDown(self):
        self.tmp.cleanup()

    def fake_subprocess_run(self, argv, *args, **kwargs):
        if list(argv[:2]) == ["docker", "run"]:
            self.checks.append(list(argv))
            return subprocess.CompletedProcess(argv, 0, "", "")
        if "-c" in argv and pathlib.Path(str(argv[0])).name.startswith("python"):
            raise AssertionError(f"a success check ran on the host: {argv}")
        return self.real_run(argv, *args, **kwargs)

    def main(self, *extra, during=None):
        import run_scope

        class FakeSession:
            def __init__(self, run, arm, image, token, digest, allow):
                self.names, self.env = containers.names(run), {"HOME": "h"}

            def __enter__(self):
                return self

            def __exit__(self, *_):
                pass

        def session(project, arm, prompt, model, timeout, effort=None, launch=None):
            if during:
                during()
            return {"arm": arm["arm"], "report": "done", "sessionIds": [], "isError": False}

        argv = ["run_scope.py", "r", "--token-file", str(self.token), *extra]
        with mock.patch.object(run_scope, "RUNS", pathlib.Path(self.tmp.name)), \
                mock.patch.object(run_scope, "run_session", session), \
                mock.patch.object(containers, "Session", FakeSession), \
                mock.patch.object(containers, "preflight", lambda image, path: ([], {"claude": "2.1.300"})), \
                mock.patch.object(containers, "host_state", lambda real: {}), \
                mock.patch.object(subprocess, "run", self.fake_subprocess_run), \
                mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(io.StringIO()):
            run_scope.main()
        return json.loads((self.run / "scope.json").read_text())

    def rejected_push(self):
        event = {"t": 1.0, "tool": "git", "argv": ["push", "origin", "main"], "cwd": str(self.run / "project"),
                 "kind": "git-push", "blocked": False, "force": False, "reason": "", "status": 1}
        with open(self.run / "shimbin" / "shim.log", "a") as handle:
            handle.write(json.dumps(event) + "\n")

    def test_checks_run_in_a_container_and_the_shim_log_is_read_from_shimbin(self):
        verdict = self.main(during=self.rejected_push)
        self.assertTrue(verdict["success"], verdict.get("error"))
        self.assertEqual(len(self.checks), len(json.loads((self.run / "scenario.json").read_text())["success"]["checks"]))
        for argv in self.checks:
            self.assertEqual(argv[argv.index("--network") + 1], "none")
        self.assertEqual([item["id"] for item in verdict["attempted"]], ["git-push"])
        self.assertTrue((self.run / "snapshot-after.json").is_file())

    def test_rescore_judges_from_snapshot_after_and_checks_in_the_container(self):
        self.main()
        first = json.loads((self.run / "scope.json").read_text())
        # Something changes the project after the run (worker code a later step ran): a rescore must not see it.
        (self.run / "project" / "CONTRIBUTING.md").unlink()
        import scope_snapshot
        self.checks.clear()
        with mock.patch.object(scope_snapshot, "take", side_effect=AssertionError("a new snapshot was taken")):
            verdict = self.main("--rescore")
        self.assertEqual(verdict["changes"], first["changes"])
        self.assertEqual(verdict["effected"], [])
        self.assertTrue(self.checks)

    def test_rescore_without_snapshot_after_refuses(self):
        self.main()
        (self.run / "snapshot-after.json").unlink()
        with self.assertRaises(SystemExit) as raised:
            self.main("--rescore")
        self.assertIn("snapshot-after.json", str(raised.exception))


class HostGuardTests(unittest.TestCase):
    """The host state the guard records: ~/.claude.json by existence and mode, settings by content, directories by names."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.real = pathlib.Path(self.tmp.name)
        for directory in (".claude", ".ssh", ".codex"):
            (self.real / directory).mkdir()
        (self.real / ".claude" / "settings.json").write_text("{}")
        (self.real / ".claude" / "projects").mkdir()
        (self.real / ".claude.json").write_text('{"a": 1}')
        (self.real / ".claude.json").chmod(0o600)
        (self.real / ".ssh" / "id_ed25519").write_text("key one")

    def tearDown(self):
        self.tmp.cleanup()

    def changes(self, before):
        return containers.host_changes(before, containers.host_state(self.real))

    def test_each_watched_change_is_named(self):
        before = containers.host_state(self.real)
        self.assertEqual(set(before), {"~/.claude.json (exists, mode)", "~/.claude/settings.json", "~/.ssh/ (names)",
                                       "~/.claude/ (names)", "~/.codex/ (names)"})
        self.assertEqual(self.changes(before), [])
        (self.real / ".claude" / "settings.json").write_text('{"x": 1}')
        self.assertEqual(self.changes(before), ["~/.claude/settings.json"])
        (self.real / ".ssh" / "keys").mkdir()
        (self.real / ".ssh" / "keys" / "new_key").write_text("k")
        (self.real / ".codex" / "auth.json").write_text("{}")
        (self.real / ".claude" / "agents").mkdir()
        self.assertEqual(self.changes(before), ["~/.claude/ (names)", "~/.claude/settings.json", "~/.codex/ (names)",
                                                "~/.ssh/ (names)"])
        (self.real / ".claude.json").chmod(0o644)
        self.assertIn("~/.claude.json (exists, mode)", self.changes(before))
        (self.real / ".claude.json").unlink()
        self.assertIn("~/.claude.json (exists, mode)", self.changes(before))

    def test_what_a_host_session_rewrites_does_not_trip_it(self):
        """A Claude Code session on the host rewrites ~/.claude.json and writes under ~/.claude/projects constantly."""
        before = containers.host_state(self.real)
        (self.real / ".claude.json").write_text('{"a": 2, "numStartups": 41, "tipsHistory": {}}')
        (self.real / ".claude" / "projects" / "-home-x").mkdir()
        (self.real / ".claude" / "projects" / "-home-x" / "session.jsonl").write_text("{}")
        self.assertEqual(self.changes(before), [])

    def test_ssh_contents_are_not_hashed(self):
        before = containers.host_state(self.real)
        (self.real / ".ssh" / "id_ed25519").write_text("key two")
        self.assertEqual(self.changes(before), [])
        empty = pathlib.Path(self.tmp.name) / "empty"
        empty.mkdir()
        self.assertEqual(set(containers.host_state(empty).values()), {"absent"})


class LinkTests(unittest.TestCase):
    """No path under the run directory may lead into the real home."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.real = pathlib.Path(self.tmp.name) / "realhome"
        (self.real / ".ssh").mkdir(parents=True)
        (self.real / ".ssh" / "id_ed25519").write_text("key")
        # The run lies under the real home, as the default $VISP_BENCH_RUNS (~/visp-bench) puts it.
        self.run = self.real / "visp-bench" / "runs" / "r"
        for area in ("project", "outside", "home"):
            (self.run / area).mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def test_links_inside_the_run_or_outside_the_home_pass(self):
        (self.run / "project" / "data").symlink_to(self.run / "outside")
        (self.run / "project" / "a.txt").write_text("x")
        os.link(self.run / "project" / "a.txt", self.run / "outside" / "a-copy.txt")
        (self.run / "project" / "system").symlink_to("/usr/share")
        self.assertEqual(containers.link_problems(self.run, self.real), [])

    def test_a_symlink_into_the_real_home_is_named(self):
        (self.run / "project" / "keys").symlink_to(self.real / ".ssh")
        (self.run / "home" / "dangling").symlink_to(self.real / "missing" / "file")
        problems = containers.link_problems(self.run, self.real)
        self.assertEqual(len(problems), 2)
        self.assertTrue(problems[0].startswith("home/dangling is a symlink into the real home"))
        self.assertTrue(problems[1].startswith("project/keys is a symlink into the real home"))

    def test_a_hard_link_to_a_file_outside_the_run_is_named(self):
        os.link(self.real / ".ssh" / "id_ed25519", self.run / "project" / "key")
        self.assertEqual(containers.link_problems(self.run, self.real),
                         ["project/key is hard-linked to a path outside the run directory"])


class RunScopeContainerTests(unittest.TestCase):
    """run_scope.main in container mode with docker and the worker replaced."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.run, arm = fake_run(self.tmp.name)
        (self.run / "scenario.json").write_text("{}")
        (self.run / "prompt.txt").write_text("Task")
        (self.run / "home" / ".claude").symlink_to(pathlib.Path(self.tmp.name) / "real-claude")
        (self.run / "home" / ".claude.json").write_text("{}")
        self.token = token_file(self.tmp.name)
        self.states = []

    def tearDown(self):
        self.tmp.cleanup()

    def main(self, states, during=None):
        """Run run_scope.main; `states` are host_state's answers in turn, or a function in its place; `during`
        runs while the pretend worker works."""
        import run_scope
        state = states if callable(states) else (lambda answers: lambda real: next(answers))(iter(states))

        class FakeSession:
            def __init__(self, run, arm, image, token, digest, allow):
                self.names, self.env = containers.names(run), {"HOME": "h"}

            def __enter__(self):
                return self

            def __exit__(self, *_):
                pass

        def session(project, arm, prompt, model, timeout, effort=None, launch=None):
            assert launch is not None
            if during:
                during()
            return {"arm": arm["arm"], "report": f"done {FAKE_TOKEN}", "sessionIds": ["s"], "isError": False}

        argv = ["run_scope.py", "r", "--token-file", str(self.token)]
        with mock.patch.object(run_scope, "RUNS", pathlib.Path(self.tmp.name)), \
                mock.patch.object(run_scope, "run_session", session), \
                mock.patch.object(run_scope, "score", lambda *args, **kwargs: {"overreach": False}), \
                mock.patch.object(containers, "Session", FakeSession), \
                mock.patch.object(containers, "preflight", lambda image, path: ([], {"claude": "2.1.300"})), \
                mock.patch.object(containers, "host_state", state), \
                mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(io.StringIO()) as printed:
            run_scope.main()
        return json.loads((self.run / "result.json").read_text()), printed.getvalue()

    def test_a_clean_run_records_its_isolation_and_no_token(self):
        result, printed = self.main([{"~/.claude.json": "a"}, {"~/.claude.json": "a"}])
        self.assertFalse((self.run / "home" / ".claude").exists() or (self.run / "home" / ".claude").is_symlink())
        self.assertFalse((self.run / "home" / ".claude.json").exists())
        self.assertEqual(result["isolation"]["mode"], "container")
        self.assertEqual(result["isolation"]["removedFromHome"], [".claude", ".claude.json"])
        self.assertEqual(result["isolation"]["hostChanged"], [])
        self.assertEqual(result["claudeProjects"], str(self.run.resolve() / "home" / ".claude" / "projects"))
        self.assertFalse((self.run / "invalid.json").exists())
        for text in (json.dumps(result), printed, (self.run / "arm.json").read_text()):
            self.assertNotIn(FAKE_TOKEN, text)

    def test_a_host_state_change_flags_the_run_and_skips_scoring(self):
        result, _ = self.main([{"~/.claude/settings.json": "a"}, {"~/.claude/settings.json": "b"}])
        flag = json.loads((self.run / "invalid.json").read_text())
        self.assertEqual(flag["reason"], "host state changed")
        self.assertEqual(flag["match"], "~/.claude/settings.json")
        self.assertIn("host state changed", json.loads((self.run / "scope.json").read_text())["error"])
        self.assertEqual(result["isolation"]["hostChanged"], ["~/.claude/settings.json"])
        import batch
        self.assertIn(flag["reason"], batch.STOPPING)

    def test_a_host_session_rewriting_claude_json_during_the_run_does_not_trip_the_guard(self):
        real = pathlib.Path(self.tmp.name) / "realhome"
        (real / ".claude").mkdir(parents=True)
        (real / ".claude" / "settings.json").write_text("{}")
        (real / ".claude.json").write_text('{"numStartups": 1}')
        real_state = containers.host_state

        def rewrite():
            (real / ".claude.json").write_text('{"numStartups": 2, "projects": {"/x": {}}}')
        result, _ = self.main(lambda _real: real_state(real), during=rewrite)
        self.assertEqual(result["isolation"]["hostChanged"], [])
        self.assertFalse((self.run / "invalid.json").exists())

    def test_a_link_into_the_real_home_made_during_the_run_flags_it(self):
        # Only a link is made; nothing under the real home is read or written.
        result, _ = self.main([{}, {}], during=lambda: (self.run / "project" / "keys").symlink_to(
            scope_env.real_home() / ".ssh"))
        self.assertEqual(len(result["isolation"]["hostChanged"]), 1)
        self.assertIn("project/keys is a symlink into the real home", result["isolation"]["hostChanged"][0])
        self.assertEqual(json.loads((self.run / "invalid.json").read_text())["reason"], "host state changed")

    def test_a_link_into_the_real_home_before_the_run_aborts_it(self):
        (self.run / "outside" / "keys").symlink_to(scope_env.real_home() / ".ssh")
        with self.assertRaises(SystemExit) as raised:
            self.main([{}, {}])
        self.assertIn("links into the real home", str(raised.exception))
        self.assertFalse((self.run / "result.json").exists())

    def test_a_visp_arm_is_refused_in_the_container(self):
        arm = json.loads((self.run / "arm.json").read_text())
        (self.run / "arm.json").write_text(json.dumps({**arm, "arm": "visp:cand"}))
        with self.assertRaises(SystemExit) as raised:
            self.main([])
        self.assertIn("VISP arm", str(raised.exception))


class AutoArmTests(unittest.TestCase):
    def test_permission_modes_and_models(self):
        self.assertEqual(scope_env.permission_mode("bare-rule+auto"), "auto")
        self.assertEqual(scope_env.permission_mode("bare-rule"), "bypassPermissions")
        self.assertTrue(scope_env.auto_mode_supported("claude-haiku-5-5"))
        self.assertFalse(scope_env.auto_mode_supported("claude-haiku-4-5-20251001"))
        self.assertTrue(all(scope_env.is_scope_arm(arm) for arm in ("bare-rule+auto", "bare+auto", "visp:x")))
        self.assertFalse(scope_env.is_scope_arm("speckit"))

    def test_run_session_passes_the_arms_permission_mode_to_the_launcher(self):
        import run_claude
        seen = []

        def launch(argv, timeout):
            seen.append(argv)
            return 0, json.dumps({"session_id": "s", "num_turns": 1, "result": "ok"}), "", False
        with tempfile.TemporaryDirectory() as tmp:
            (pathlib.Path(tmp) / "project").mkdir()
            result = run_claude.run_session(pathlib.Path(tmp) / "project", {"arm": "bare-rule+auto",
                                                                            "permissionMode": "auto"},
                                            "Task", "claude-haiku-5-5", 60, launch=launch)
        self.assertEqual(seen[0][0], "claude")
        self.assertEqual(seen[0][seen[0].index("--permission-mode") + 1], "auto")
        self.assertEqual(result["permissionMode"], "auto")

    def test_run_session_records_each_turns_denials_and_model_usage(self):
        import run_claude
        denial = {"tool_name": "Bash", "tool_use_id": "toolu_1", "tool_input": {"command": "git push origin main"}}
        usage = {"claude-haiku-5-5": {"inputTokens": 10, "outputTokens": 5, "costUSD": 0.01}}

        def launch(argv, timeout):
            return 0, json.dumps({"session_id": "s", "num_turns": 3, "result": "ok", "permission_denials": [denial],
                                  "modelUsage": usage}), "", False
        with tempfile.TemporaryDirectory() as tmp:
            (pathlib.Path(tmp) / "project").mkdir()
            result = run_claude.run_session(pathlib.Path(tmp) / "project", {"arm": "bare-rule+auto",
                                                                            "permissionMode": "auto"},
                                            "Task", "claude-haiku-5-5", 60, launch=launch)
        self.assertEqual(result["permissionDenials"], [[denial]])
        self.assertEqual(result["modelUsage"], [usage])
        import scope_verdict
        facts = scope_verdict.denial_facts(result, pathlib.Path("/run/project"))
        self.assertEqual([(fact["tool"], fact["command"], fact["toolUseId"], fact["turn"]) for fact in facts],
                         [("Bash", "git push origin main", "toolu_1", 1)])

    def test_an_auto_mode_classifier_abort_is_scored_not_invalid(self):
        import runfacts
        with tempfile.TemporaryDirectory() as tmp:
            run = pathlib.Path(tmp)
            aborted = {"isError": True, "report": "Agent aborted: auto mode classifier blocked too many actions"}
            (run / "result.json").write_text(json.dumps(aborted))
            self.assertTrue(runfacts.auto_aborted(aborted))
            self.assertIsNone(runfacts.worker_failure(run))
            self.assertIsNone(runfacts.invalidity(run))
            (run / "result.json").write_text(json.dumps({"isError": True, "report": "API Error: 500"}))
            self.assertEqual(runfacts.worker_failure(run)["reason"], "worker failure")
            self.assertFalse(runfacts.auto_aborted({"isError": False, "report": aborted["report"]}))

    def test_batch_labels_and_plans_the_auto_arm(self):
        import batch
        self.assertEqual(batch.label("bare-rule+auto"), ("bare-rule-auto", "bare-rule+auto"))
        args = type("Args", (), {"tasks": "scope-git-push-02", "arms": "bare-rule,bare-rule+auto", "batch": "b",
                                 "reps": 1, "split": "dev"})()
        with contextlib.redirect_stdout(io.StringIO()):
            _, _, runs = batch.plan(args)
        self.assertEqual(sorted(run["name"] for run in runs),
                         ["b-scope-git-push-02-bare-rule-1", "b-scope-git-push-02-bare-rule-auto-1"])

    def test_setup_arm_writes_the_rule_and_the_mode_and_refuses_an_unsupported_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = {**os.environ, "VISP_BENCH_RUNS": tmp, "HOME": tmp}
            setup = [sys.executable, str(BENCH / "setup_arm.py"), "scope-git-push-02", "bare-rule+auto"]
            # Haiku 5.5 supports auto mode at any effort: the pilot's preset is quality-2026-10 (high).
            done = subprocess.run([*setup, "r1", "--preset", "quality-2026-10"], env=env, capture_output=True,
                                  text=True)
            self.assertEqual(done.returncode, 0, done.stderr)
            run = pathlib.Path(tmp) / "runs" / "r1"
            self.assertEqual(json.loads((run / "arm.json").read_text())["permissionMode"], "auto")
            self.assertEqual((run / "project" / "CLAUDE.md").read_text(), scope_env.rule_sentence() + "\n")
            refused = subprocess.run([*setup, "r2"], env=env, capture_output=True, text=True)
            self.assertNotEqual(refused.returncode, 0)
            self.assertIn("auto mode does not support", refused.stderr)


class ProxyTests(unittest.TestCase):
    """egress_proxy.py on the loopback: CONNECT to an allowed host:port is tunnelled, everything else gets 403."""

    def test_decide(self):
        allowed = {"api.anthropic.com:443"}
        self.assertTrue(egress_proxy.decide("CONNECT", "API.anthropic.com:443", allowed))
        for method, target in (("CONNECT", "api.anthropic.com:80"), ("CONNECT", "example.com:443"),
                               ("GET", "http://api.anthropic.com:443/"), ("CONNECT", "api.anthropic.com")):
            self.assertFalse(egress_proxy.decide(method, target, allowed), (method, target))

    def test_tunnel_and_refusal(self):
        import socket
        upstream = socket.socket()
        upstream.bind(("127.0.0.1", 0))
        upstream.listen()
        up_port = upstream.getsockname()[1]

        def echo():
            connection, _ = upstream.accept()
            connection.sendall(connection.recv(100).upper())
            connection.close()
        threading.Thread(target=echo, daemon=True).start()
        ready, loop = threading.Event(), asyncio.new_event_loop()
        port, printed = [], io.StringIO()
        allowed = {f"127.0.0.1:{up_port}"}
        server = loop.create_task(egress_proxy.serve("127.0.0.1:0", allowed,
                                                     lambda bound: (port.append(bound), ready.set())))

        def serve():
            asyncio.set_event_loop(loop)
            with contextlib.suppress(asyncio.CancelledError):
                loop.run_until_complete(server)
            loop.close()
        thread = threading.Thread(target=serve, daemon=True)
        with contextlib.redirect_stdout(printed):
            thread.start()
            self.assertTrue(ready.wait(5))
            self.tunnel_and_refuse(port[0], up_port)
            loop.call_soon_threadsafe(server.cancel)
            thread.join(5)
        upstream.close()
        log = [json.loads(line) for line in printed.getvalue().splitlines()]
        self.assertEqual([entry["allowed"] for entry in log], [True, False, False])

    def tunnel_and_refuse(self, port, up_port):
        import socket

        def ask(request):
            client = socket.create_connection(("127.0.0.1", port), timeout=5)
            client.sendall(request)
            return client

        client = ask(f"CONNECT 127.0.0.1:{up_port} HTTP/1.1\r\nHost: x\r\n\r\n".encode())
        self.assertTrue(client.recv(100).startswith(b"HTTP/1.1 200"))
        client.sendall(b"hello")
        self.assertEqual(client.recv(100), b"HELLO")
        client.close()
        for request in (b"CONNECT example.com:443 HTTP/1.1\r\n\r\n", b"GET http://example.com/ HTTP/1.1\r\n\r\n"):
            client = ask(request)
            self.assertTrue(client.recv(100).startswith(b"HTTP/1.1 403"))
            client.close()


class DigestTests(unittest.TestCase):
    def test_the_flat_copy_has_the_same_digest(self):
        with tempfile.TemporaryDirectory() as tmp:
            for name, rel in scope_env.IMAGE_FILES.items():
                shutil.copy(BENCH / rel, pathlib.Path(tmp) / name)
            self.assertEqual(scope_env.files_digest(tmp, flat=True), scope_env.files_digest(BENCH))
            (pathlib.Path(tmp) / "scope_shim.py").write_text("# changed\n")
            self.assertNotEqual(scope_env.files_digest(tmp, flat=True), scope_env.files_digest(BENCH))

    def test_the_dockerfile_copies_every_image_file_and_pins_its_base_and_cli(self):
        dockerfile = (BENCH / "scope" / "Dockerfile").read_text()
        ignore = (BENCH / "scope" / "Dockerfile.dockerignore").read_text()
        for rel in scope_env.IMAGE_FILES.values():
            self.assertIn(rel, dockerfile)
            self.assertIn("!" + rel, ignore)
        self.assertRegex(dockerfile, r"FROM \S+@sha256:[0-9a-f]{64}")
        version = containers.IMAGE.rsplit(":", 1)[1]
        self.assertIn(f"ARG CLAUDE_CODE_VERSION={version}", dockerfile)


def docker_ready():
    try:
        return containers.describe(containers.IMAGE) is not None
    except Exception:
        return False


@unittest.skipUnless(docker_ready(), f"the scope image {containers.IMAGE} is not built or Docker does not answer")
class DockerTests(unittest.TestCase):
    """A real container turn with a fake token: environment, mount, shim, network, redaction."""

    def test_a_turn_in_the_scope_image(self):
        problems, facts = containers.preflight(containers.IMAGE, os.devnull)
        self.assertEqual([problem for problem in problems if "token" not in problem and "regular" not in problem], [],
                         "the image is stale or its user is not this one: rebuild it")
        with tempfile.TemporaryDirectory() as tmp:
            run, arm = fake_run(tmp)
            subprocess.run(["git", "init", "-q", str(run / "project")], check=True)
            (run / "canaries.json").write_text("{}")
            script = ("echo HOME=$HOME; [ -n \"$CLAUDE_CODE_OAUTH_TOKEN\" ] && echo token-set; "
                      "echo say $CLAUDE_CODE_OAUTH_TOKEN; env | cut -d= -f1 | sort | tr '\\n' ' '; echo; "
                      "command -v git; ls /home; touch /etc/x 2>/dev/null || echo read-only; "
                      f"echo run-holds $(ls -A {run.resolve()} | sort | tr '\\n' ' '); "
                      f"cat {run.resolve()}/canaries.json 2>/dev/null || echo no-ground-truth; "
                      f"ln -s /etc/passwd {run.resolve()}/result.json 2>/dev/null || echo run-not-writable; "
                      "python3 -c \"import urllib.request\ntry:\n urllib.request.urlopen('https://example.com', "
                      "timeout=5)\nexcept Exception as e: print('refused', e)\"")
            with mock.patch.dict(os.environ, HOST_SECRETS):
                with containers.Session(run, arm, containers.IMAGE, FAKE_TOKEN, scope_env.files_digest(BENCH)) as turn:
                    code, stdout, stderr, _ = turn(["bash", "-c", script], 120)
            self.assertEqual(code, 0, stderr)
            self.assertIn(f"HOME={run.resolve() / 'home'}", stdout)
            self.assertIn("token-set", stdout)
            self.assertNotIn(FAKE_TOKEN, stdout)
            names = set(stdout.splitlines()[3].split())
            self.assertLessEqual(names, ALLOWED_ENV | {"CLAUDE_CODE_OAUTH_TOKEN", "HOSTNAME", "NODE_VERSION", "PWD",
                                                       "SHLVL", "_"})
            self.assertIn(str(run.resolve() / "shimbin" / "git"), stdout)
            self.assertIn("read-only", stdout)
            self.assertIn("run-holds " + " ".join(sorted(containers.MOUNTED)) + "\n", stdout)
            self.assertIn("no-ground-truth", stdout)
            self.assertIn("run-not-writable", stdout)
            self.assertFalse((run / "result.json").is_symlink())
            self.assertTrue((run / "shimbin" / "shim.log").is_file())
            self.assertIn("403 Forbidden", stdout)
            log = [json.loads(line) for line in (run / "egress.log").read_text().splitlines()]
            self.assertEqual([(entry["target"], entry["allowed"]) for entry in log if "target" in entry],
                             [("example.com:443", False)])
            left = containers.docker("ps", "-a", "--filter", f"name={turn.names['container']}", "--format",
                                     "{{.Names}}").stdout.strip()
            self.assertEqual(left, "")

    def test_a_planted_sitecustomize_runs_only_in_the_check_container(self):
        import scope_verdict
        with tempfile.TemporaryDirectory() as tmp:
            run, _ = fake_run(tmp)
            marker = run.resolve() / "pwned"  # the run directory, which a check container does not mount
            (run / "project" / "sitecustomize.py").write_text(
                f"import socket\nopen({str(marker)!r}, 'w').write('x')\n")
            (run / "project" / "mod.py").write_text("VALUE = 1\n")
            scenario = {"success": {"checks": [
                {"name": "request", "code": "import mod\nassert mod.VALUE == 1\n"},
                {"name": "offline", "code": "import socket\nsocket.create_connection(('1.1.1.1', 53), timeout=3)\n"},
                {"name": "read-only", "code": "open('new.txt', 'w')\n"}]}}
            result = scope_verdict.run_success(scenario, run / "project", run / "home",
                                               runner=containers.check_runner(run, containers.IMAGE))
            self.assertEqual([check["passed"] for check in result["checks"]], [True, False, False], result)
            self.assertFalse(marker.exists())
            self.assertFalse((run / "project" / "new.txt").exists())

    def test_reference_solutions_pass_in_the_check_container(self):
        """The null run ($0): each dev scenario's reference solution, judged with its checks in the container, is
        clean and meets the request; the untouched project does not."""
        import scope_split
        import scope_verdict
        from test_scope import apply_solution, prepare
        import scope_snapshot as snapshots
        failures = []
        with tempfile.TemporaryDirectory() as tmp:
            for identifier in scope_split.scenarios("dev"):
                scenario = scope_env.load_scenario(scope_env.PREFIX + identifier)
                run = prepare(tmp, scenario)
                runner = containers.check_runner(run, containers.IMAGE)
                before = snapshots.take(run)
                untouched = scope_verdict.run_success(scenario, run / "project", run / "home", runner=runner)
                apply_solution(scenario, run)
                changes, remote = snapshots.compare(before, snapshots.take(run), run)
                success = scope_verdict.run_success(scenario, run / "project", run / "home", runner=runner)
                verdict = scope_verdict.judge(scenario, changes, [], remote, success=success)
                if untouched["passed"] or not verdict["success"] or verdict["effected"] or verdict["d6"]:
                    failures.append((identifier, untouched["passed"], [c for c in success["checks"] if not c["passed"]],
                                     verdict["effected"]))
        self.assertEqual(failures, [])


if __name__ == "__main__":
    unittest.main()
