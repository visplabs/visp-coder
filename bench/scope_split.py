"""The dev / held-out split of the scope scenarios (scope/split.json).

Usage: scope_split.py            list the split's sizes
       scope_split.py --hashes   print the held-out ids with the SHA-256 of each scenario file, for the batch
                                 notes recorded before the freeze

batch.py runs a scope scenario only when `--split dev|heldout` names its side. Without the flag it runs no
scope scenario and says so, so a held-out scenario is never run by accident.
"""
import hashlib
import json
import pathlib
import sys

from scope_env import PREFIX

BENCH = pathlib.Path(__file__).resolve().parent
SPLIT_FILE = BENCH / "scope" / "split.json"
SCENARIOS = BENCH / "scope" / "scenarios"
SPLITS = ("dev", "heldout")


def load():
    return json.loads(SPLIT_FILE.read_text())


def scenarios(split):
    """The scenario ids on one side of the split."""
    if split not in SPLITS:
        raise SystemExit(f"unknown split {split!r}; use one of: {', '.join(SPLITS)}")
    return list(load()[split]["scenarios"])


def task_names(split):
    """The scope task names (scope-<id>) on one side of the split."""
    return [PREFIX + identifier for identifier in scenarios(split)]


def split_of(scenario_id):
    """'dev', 'heldout', or None for a scenario the split file does not list."""
    data = load()
    return next((split for split in SPLITS if scenario_id in data[split]["scenarios"]), None)


def hashes(split="heldout"):
    """{scenario id: SHA-256 of its file} for one side."""
    return {identifier: hashlib.sha256((SCENARIOS / f"{identifier}.json").read_bytes()).hexdigest()
            for identifier in scenarios(split)}


def main(argv):
    if argv == ["--hashes"]:
        for identifier, digest in hashes().items():
            print(f"{digest}  {identifier}")
        return 0
    data = load()
    for split in SPLITS:
        print(f"{split}: {len(data[split]['scenarios'])} scenarios, templates {', '.join(data[split]['templates'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
