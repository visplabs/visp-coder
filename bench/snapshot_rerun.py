"""Rerun session 2 of finished carryover runs from their session-1 snapshots (research-oct23.md M2).

Usage: snapshot_rerun.py --batch <name> [--variants readme-scope,control] [--limit N] [--seed S]
                         [--jobs 4] [--preset quality-2026-10] [--spend-cap USD] [--dry-run] [--rerun-invalid]
       snapshot_rerun.py --run <run_name> [--timeout 2700]       (one run; batch.py starts these)

The driver takes the finished runs of batches b3 and b3-pilot (tasks archive-carryover and
archive-carryover-raised, arms bare and bare-automemory) whose session-1 README states the item cap on
no line but the create-item bullet (snapshots.py), restores each snapshot into a new run and runs the
second request once, in fresh mode, with the same worker, effort and preset as the source. Variant
`control` restores the snapshot unchanged; `readme-scope` adds one quoted line to its README naming the
constant and the cap's scope in the request's words. Run names follow batch.py,
<batch>-archive-carryover-<arm>-<variant>-<n>; <n> is the snapshot's place among all eligible snapshots
of its arm, so a --limit sample keeps its names. Both variants of a snapshot share <n>, and so are paired.

--limit N samples N snapshots (both variants of each), reproducibly from --seed (default 0). The queue,
the unfinished-run restart, the invalid-run check (usage limit, worker failure), the lock, the signal
handling and --spend-cap are batch.py's: this calls batch.drive, and spend_guard.py knows this driver.
--dry-run lists the planned runs and changes nothing. Score and report with
report.py --batch <name> --score; the first arm in the manifest (<arm>-control) is the base.

With --run it is the runner of one prepared run (snapshots.prepare made it): it runs the second session
only, with run_carryover's fresh mode, which restores session1/snapshot.tar and writes fresh/result.json.
"""
import argparse
import json
import sys

import batch
import run_carryover
import snapshots
from common import RUNS


def run_one(name, timeout):
    """Session 2 of one prepared run, as run_carryover.py would run it after the first session."""
    run = RUNS / "runs" / name
    arm = json.loads((run / "arm.json").read_text())
    first = run / "session1"
    args = argparse.Namespace(run=name, reuse=None, build=None, model=None, effort=None, timeout=timeout)
    run_carryover.run_modes(args, run, run / "project", arm, first, json.loads((first / "result.json").read_text()),
                            ["fresh"])


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--run", help="run one prepared run's second session (used by the driver)")
    parser.add_argument("--timeout", type=int, default=2700)
    parser.add_argument("--batch")
    parser.add_argument("--variants", default=",".join(snapshots.VARIANTS))
    parser.add_argument("--limit", type=int, metavar="N", help="sample N snapshots (both variants of each)")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--source-batches", default=",".join(snapshots.SOURCE_BATCHES))
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--preset", default="quality-2026-10")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--rerun-invalid", action="store_true")
    parser.add_argument("--spend-cap", type=float, metavar="USD")
    parser.add_argument("--spend-interval", type=float, default=60)
    args = parser.parse_args()
    if args.run:
        return run_one(args.run, args.timeout)
    if not args.batch:
        parser.error("--batch is required")
    variants = args.variants.split(",")
    unknown = set(variants) - set(snapshots.VARIANTS)
    if unknown:
        parser.error(f"unknown variants {sorted(unknown)}; known: {', '.join(snapshots.VARIANTS)}")
    every, skipped = snapshots.eligible(RUNS, args.source_batches.split(","))
    chosen = snapshots.sample(every, args.limit, args.seed)
    runs = snapshots.entries(args.batch, chosen, every, variants)
    arms = [(f"{arm}-{variant}", arm) for arm in snapshots.SOURCE_ARMS for variant in sorted(
        variants, key=lambda v: (v != "control", v)) if any(s["arm"] == arm for s in chosen)]
    args.reps = max((run["rep"] for run in runs), default=0)
    by_arm = {arm: sum(1 for s in every if s["arm"] == arm) for arm in snapshots.SOURCE_ARMS}
    print(f"{len(every)} eligible snapshots ({', '.join(f'{n} {arm}' for arm, n in by_arm.items())}); "
          f"skipped {sum(skipped.values())}: {', '.join(f'{n} {why}' for why, n in sorted(skipped.items())) or 'none'}")
    print(f"{len(chosen)} chosen" + (f" (--limit {args.limit}, seed {args.seed})" if args.limit else "")
          + f", variants {', '.join(variants)}: {len(runs)} runs")
    if not runs:
        raise SystemExit("nothing to run")
    extra = {"snapshotRerun": {"sources": [s["run"] for s in chosen], "variants": variants, "seed": args.seed,
                               "limit": args.limit, "sourceBatches": args.source_batches.split(","),
                               "skipped": skipped}}
    batch.drive(args, [snapshots.TASK], arms, runs, extra)


if __name__ == "__main__":
    sys.exit(main())
