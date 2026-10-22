"""Shared pieces of the reviewer probes (bench/tasks/<task>/probes/probes.py).

A probe is a check like a hidden check, kept apart from the hidden checks and scored as its own
metric. Each one names the request clause it tests, a group and, where it came from a reviewer
finding, the finding. A probe function returns (passed, detail). One failing or crashing probe
never stops the others.

Groups:
- request: the bench reference implementation passes it.
- refgap: the request or README states the rule, but the bench reference implementation has the
  same gap the reviewer found. `test_probes.py` checks that the reference fails exactly these, and
  that the reference with a minimal fix passes them.
"""
import json

GROUPS = ("request", "refgap")


class Registry:
    def __init__(self):
        self.probes = []

    def add(self, pid, clause, group="request", finding=None):
        assert group in GROUPS, group
        assert pid not in {p["id"] for p in self.probes}, pid

        def register(fn):
            self.probes.append({"id": pid, "clause": clause, "group": group, "finding": finding, "fn": fn})
            return fn

        return register

    def case(self, pid, clause, fn, group="request", finding=None):
        self.add(pid, clause, group, finding)(fn)


def execute(probes, only=None):
    """Run the probes (all, or those whose id is in `only`); returns result dicts in order."""
    results = []
    for probe in probes:
        if only and probe["id"] not in only:
            continue
        try:
            ok, detail = probe["fn"]()
        except Exception as error:  # noqa: BLE001
            ok, detail = False, repr(error)
        results.append({"name": probe["id"], "passed": bool(ok), "detail": None if ok else detail,
                        "group": probe["group"], "finding": probe["finding"], "clause": probe["clause"]})
    return results


def summary(results):
    passed = sum(1 for r in results if r["passed"])
    return {"passed": passed, "total": len(results), "results": results}


def emit(results):
    print(json.dumps(summary(results), indent=1, default=str))


def listing(probes):
    """One line per probe for `probe.py --list`."""
    return [f"{p['id']}\t{p['group']}\t{p['finding'] or '-'}\t{p['clause']}" for p in probes]
