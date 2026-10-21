"""Per-test results from SWE-bench test output, and whether a bug's listed tests pass.

Adapted from ChainSWE's evaluation/chainswe/evaluate.py (https://github.com/C-lister/SWE-Edit),
Copyright (c) Microsoft Corporation, MIT License, so a step here is scored the way ChainSWE
scores it: Django's verbose unittest runner, pytest's -rA summary, test descriptions printed
under a docstring, and the dataset's whitespace-truncated pytest parameter IDs.
"""
import re

PRIORITY = {"PASSED": 0, "XPASS": 0, "SKIPPED": 1, "XFAIL": 1, "FAILED": 3, "ERROR": 4}
PASS_STATUSES = {"PASSED", "XPASS"}
UNITTEST = {"ok": "PASSED", "FAIL": "FAILED", "ERROR": "ERROR", "expected failure": "XFAIL",
            "unexpected success": "XPASS"}
LIFECYCLE = {"setUp", "tearDown", "setUpClass", "tearDownClass", "setUpModule", "tearDownModule",
             "asyncSetUp", "asyncTearDown", "_callSetUp", "_callTearDown", "_callCleanup", "doCleanups",
             "doClassCleanups", "doModuleCleanups"}


def canonical_test_id(test_id):
    """`test_x (pkg.mod.Class)` and `pkg.mod.Class.test_x` name the same test."""
    test_id = test_id.strip().removeprefix("./")
    match = re.fullmatch(r"(\w+) \(([^)]+)\)", test_id)
    if match:
        name, owner = match.groups()
        return owner if owner.endswith("." + name) else owner + "." + name
    return test_id


def add_result(results, test_id, status):
    """Record a status; a test reported twice keeps its worst status."""
    key = canonical_test_id(test_id)
    if PRIORITY[status] >= PRIORITY.get(results.get(key), -1):
        results[key] = status


def _body_errors(output, results):
    """An unittest ERROR raised in the test body is a failure, not a fixture error."""
    evidence = {}
    for block in re.split(r"^={6,}\s*$", output, flags=re.MULTILINE):
        header = re.search(r"^ERROR: (\w+) \(([^)]+)\)(?: .*)?$", block, re.MULTILINE)
        if header is None:
            continue
        name, owner = header.groups()
        frames = re.findall(r'^  File "[^"]+", line \d+, in (\w+)\s*$', block, re.MULTILINE)
        body = "Traceback (most recent call last):" in block and name in frames and not LIFECYCLE.intersection(frames)
        evidence.setdefault(canonical_test_id(f"{name} ({owner})"), []).append(body)
    for key, bodies in evidence.items():
        if results.get(key) == "ERROR" and all(bodies):
            results[key] = "FAILED"


def _strip_reason(test_id):
    """`path::test[a - b] - AssertionError` -> `path::test[a - b]`: cut at the first ` - ` outside brackets."""
    depth = 0
    for offset, char in enumerate(test_id):
        if depth == 0 and test_id.startswith(" - ", offset):
            return test_id[:offset]
        if char == "[":
            depth += 1
        elif char == "]":
            depth = max(0, depth - 1)
    return test_id


def parse_test_results(output):
    """{canonical test id: status} from unittest (verbose) or pytest (-rA) output."""
    results, descriptions, description_lines = {}, {}, set()
    output = re.sub(r"\x1b\[[0-9;]*m", "", output)
    # A test with a docstring prints its description on a second line; datasets list some by it.
    for match in re.finditer(r"^(\w+ \([^)]+\))\n([^\n]+?)\s+\.\.\.\s+"
                             r"(ok|FAIL|ERROR|skipped[^\n]*|expected failure|unexpected success)$",
                             output, re.MULTILINE):
        test_id, description, raw = match.groups()
        key = canonical_test_id(test_id)
        add_result(results, key, UNITTEST.get(raw, "SKIPPED"))
        descriptions.setdefault(description.strip(), set()).add(key)
        description_lines.add(match.group(0).splitlines()[1].strip())
    for line in output.splitlines():
        line = line.strip()
        if line in description_lines or re.fullmatch(
                r"FAILED \((?:failures|errors|skipped|expected failures|unexpected successes)=\d+"
                r"(?:, (?:failures|errors|skipped|expected failures|unexpected successes)=\d+)*\)", line):
            continue
        match = re.match(r"^(PASSED|FAILED|ERROR) (.+)$", line)
        if match:
            add_result(results, _strip_reason(match.group(2)), match.group(1))
            continue
        match = re.match(r"^(\w+ \([^)]+\))\s+.*?\.\.\.\s+(ok|FAIL|ERROR|skipped.*|expected failure|unexpected success)$",
                         line)
        if match:
            add_result(results, match.group(1), UNITTEST.get(match.group(2), "SKIPPED"))
            continue
        match = re.match(r"^(.+?)\s+(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)(?:\s+\[.*\])?$", line)
        if match:
            add_result(results, *match.groups())
    _body_errors(output, results)
    for description, owners in descriptions.items():
        statuses = {results[owner] for owner in owners}
        if len(statuses) == 1:
            add_result(results, description, statuses.pop())
    return results


def members(results, test):
    """The result keys a listed test stands for: itself, or every parameter of a truncated pytest ID."""
    key = canonical_test_id(test)
    if key in results:
        return [key]
    parameter = key.split("::", 1)[-1]
    if ("::" in key and "[" in parameter and (not key.endswith("]") or parameter.count("[") > parameter.count("]"))
            and key.split() == [key]):
        return sorted(node for node in results if node.endswith("]") and node.split(maxsplit=1)[0] == key)
    return []


def passes(results, test):
    found = members(results, test)
    return bool(found) and all(results[node] in PASS_STATUSES for node in found)
