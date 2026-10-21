"""ChainSWE scoring: test output parsing, regressions across issues, and the worker's test python.

Run from the repository root: python3 -m unittest bench/test_chainswe.py
Standard library only; no Docker image or model is used. The scorer itself was validated on the
calibration chains with the gold patches (every issue resolved, no regression) and with no change
(no issue resolved, no regression).
"""
from pathlib import Path
import sys
import types
import unittest

BENCH = Path(__file__).resolve().parent
sys.path.insert(0, str(BENCH))
from chains import summarize  # noqa: E402
from swe_tests import members, parse_test_results, passes  # noqa: E402

DJANGO = """test_commit_debug_log (backends.base.test_base.DatabaseWrapperLoggingTests.test_commit_debug_log) ... FAIL
test_no_logs_without_debug (backends.base.test_base.DatabaseWrapperLoggingTests) ... ok
test_initialization_class_attributes (backends.base.test_base.DatabaseWrapperTests)
The "initialization" class attributes like client_class and ... ok
test_repr (backends.base.test_base.DatabaseWrapperTests) ... ERROR

======================================================================
ERROR: test_repr (backends.base.test_base.DatabaseWrapperTests)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/testbed/tests/backends/base/test_base.py", line 40, in test_repr
    repr(None.x)
AttributeError: 'NoneType' object has no attribute 'x'

----------------------------------------------------------------------
Ran 4 tests in 0.005s

FAILED (failures=1, errors=1)
"""
PYTEST = """PASSED tests/test_markup.py::test_inline[verify-:kbd:`M-x  M-s`-<p><kbd class="kbd">M</kbd></p>-x]
FAILED tests/test_markup.py::test_inline[verify-:kbd:`-`-<p>-</p>-y] - AssertionError: assert 'a - b' == 'c'
PASSED tests/test_util_typing.py::test_restify
"""


def shim():
    """swe_env/python's functions, without running it."""
    path = BENCH / "swe_env" / "python"
    namespace = types.SimpleNamespace()
    exec(compile(path.read_text().replace("\nmain()\n", "\n"), str(path), "exec"), namespace.__dict__)
    return namespace


class ParseTests(unittest.TestCase):
    def test_django_ids_descriptions_and_body_errors(self):
        results = parse_test_results(DJANGO)
        self.assertFalse(passes(results, "test_commit_debug_log (backends.base.test_base.DatabaseWrapperLoggingTests)"))
        self.assertFalse(passes(results, "backends.base.test_base.DatabaseWrapperLoggingTests.test_commit_debug_log"))
        self.assertTrue(passes(results, "backends.base.test_base.DatabaseWrapperLoggingTests.test_no_logs_without_debug"))
        self.assertTrue(passes(results, 'The "initialization" class attributes like client_class and'))
        # An error raised in the test body is a failure, not a fixture error.
        self.assertEqual(results["backends.base.test_base.DatabaseWrapperTests.test_repr"], "FAILED")
        self.assertFalse(passes(results, "test_missing (backends.base.test_base.DatabaseWrapperTests)"))

    def test_pytest_summary_and_truncated_parameter_ids(self):
        results = parse_test_results(PYTEST)
        self.assertTrue(passes(results, "tests/test_util_typing.py::test_restify"))
        # The dataset cuts a parameter id at its first space; the id stands for every parameter it begins.
        self.assertEqual(len(members(results, "tests/test_markup.py::test_inline[verify-:kbd:`M-x")), 1)
        self.assertTrue(passes(results, "tests/test_markup.py::test_inline[verify-:kbd:`M-x"))
        self.assertFalse(passes(results, "tests/test_markup.py::test_inline[verify-:kbd:`-`-<p>-</p>-y]"))


class RegressionTests(unittest.TestCase):
    @staticmethod
    def evaluation(*checks):
        return {"results": [{"name": name, "step": step, "passed": passed} for name, step, passed in checks]}

    def test_a_test_the_next_issue_rewrites_is_not_carried_into_it(self):
        steps = [(1, self.evaluation(("a", 1, True), ("b", 1, True))),
                 (2, self.evaluation(("a", 1, False), ("b", 1, False), ("c", 2, True)))]
        plain = summarize({"results": []}, steps)
        self.assertEqual(plain["steps"][1]["regressions"], ["a", "b"])
        # Issue 2 lists `a` in FAIL_TO_PASS: its test patch rewrote it, so failing it is issue 2's miss.
        redefined = summarize({"results": []}, steps, {2: {"a"}})
        self.assertEqual(redefined["steps"][1]["regressions"], ["b"])
        self.assertEqual(redefined["steps"][1]["carried"], 1)


class BrokenByStepTests(unittest.TestCase):
    def test_only_tests_that_passed_before_the_step_count(self):
        chainswe = __import__("chainswe")
        before = {"results": [{"name": "a", "passed": True}, {"name": "b", "passed": False}, {"name": "c", "passed": True}]}
        after = {"results": [{"name": "a", "passed": False}, {"name": "b", "passed": False}, {"name": "c", "passed": True},
                             {"name": "d", "passed": False}]}
        self.assertEqual(chainswe.broken_by(before, after), ["a"])
        self.assertEqual(chainswe.broken_by(None, after), [])

    def test_a_test_a_test_patch_adds_is_hidden(self):
        chainswe = __import__("chainswe")
        chain = {"bug_fixes": [{"test_patch": "+class T(TestCase):\n+    def test_new(self):\n     def test_old(self):\n"}]}
        self.assertEqual(chainswe.added_tests(chain, 1), {"test_new"})
        self.assertEqual(chainswe.test_function("tests/test_x.py::TestA::test_new[a.b - c]"), "test_new")
        self.assertEqual(chainswe.test_function("pkg.tests.TestA.test_old"), "test_old")


class PythonShimTests(unittest.TestCase):
    def test_only_test_runs_go_to_the_image(self):
        module = shim()
        self.assertTrue(module.is_test_run("python3", ["-m", "pytest", "-q", "tests/test_x.py"]))
        self.assertTrue(module.is_test_run("python", ["-X", "dev", "-m", "unittest", "x"]))
        self.assertTrue(module.is_test_run("python", ["./tests/runtests.py", "--parallel", "1", "admin_views"]))
        self.assertTrue(module.is_test_run("pytest", ["tests"]))
        self.assertFalse(module.is_test_run("python3", ["-I", "record_call.py", "log"]))
        self.assertFalse(module.is_test_run("python3", ["-c", "import pytest"]))
        self.assertFalse(module.is_test_run("python3", ["-m", "json.tool"]))
        self.assertFalse(module.is_test_run("python3", []))


if __name__ == "__main__":
    unittest.main()
