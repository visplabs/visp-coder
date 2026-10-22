"""Carry outcome of a run of archive-carryover or archive-carryover-raised, and the carry-rate report.

The hidden checks of both tasks already separate what carried. Their `memory:` group applies the
feature decisions of session 1 to session 2's paths; four of those checks are about the restock cap:

- `restock above cap changes nothing; exactly <cap> succeeds`  (rejects one over, accepts the boundary)
- `restock at cap rejects one extra unit without changes`      (rejection only)
- `restock cap uses quantity, not available stock`             (rejection only)
- `concurrent restocks one unit below the cap stop at exactly <cap>`

`archive-carryover` (cap 10000 from session 1): `carried` if all four pass, else `lost`.

`archive-carryover-raised` (the intermediate session raised the cap to 50000): the task adds
`restock past the replaced 10000 limit succeeds` (9000 + 6000 is accepted). Then:

- `current`: the four cap checks and the past-the-old-limit check pass.
- `stale`: the old limit is enforced: the past-the-old-limit, boundary and concurrent checks fail
  while both rejection-only checks pass (a 10000 cap rejects 50000-and-over restocks too) and plain
  restock works
  (`restock returns and persists quantity with existing holds`, so a restock that rejects everything
  is not called stale).
- `forgot`: no cap is enforced: both rejection-only checks fail.
- `partial`: anything else (a cap at some other value, an off-by-one, a race).
- `unknown`: the result lacks the checks the label needs (hidden.json from another task or version).

What the checks cannot tell: `stale` means "rejects what a low cap rejects and cannot grow an item
past 15000"; a cap below 15000 that is not 10000 reads as `stale` too, and a cap between 15000 and
50000 reads as `partial`. A restock that does not work at all (the plain-restock check fails) is
`partial`, never `forgot` or `stale`. The four cap checks passed or failed together in all of co1
and co2, and no co1 or co2 run is a -raised run, so the -raised labels are tested on results
derived from the real check names, not on a real run.

The primary outcome is the carry: `carried` for archive-carryover, `current` for -raised.
`hidden` is untouched; this reads the same hidden.json.
"""
import json
import math
import pathlib

CARRY_TASKS = ("archive-carryover", "archive-carryover-raised")
CARRIED = ("carried", "current")
LABELS = ("carried", "lost", "current", "stale", "forgot", "partial", "unknown")
ROLES = {
    "boundary": "restock above cap changes nothing",
    "at_cap": "restock at cap rejects one extra unit",
    "quantity": "restock cap uses quantity",
    "concurrent": "concurrent restocks one unit below the cap",
}
OLD_LIMIT = "restock past the replaced 10000 limit"
PLAIN_RESTOCK = "new:restock returns and persists quantity"


def find(results, fragment, group="memory:"):
    """The result whose name starts with the group prefix and contains the fragment, or None."""
    for result in results:
        if result["name"].startswith(group) and fragment in result["name"]:
            return result
    return None


def passed(result):
    return bool(result and result["passed"])


def cap_checks(results):
    """{role: result} for the four restock-cap checks; a missing one is absent."""
    found = {role: find(results, fragment) for role, fragment in ROLES.items()}
    return {role: result for role, result in found.items() if result}


def outcome(task, results):
    """{"carry": label, "capChecks": {role: passed}, "oldLimit": passed or None} for a carryover task, else None."""
    if task not in CARRY_TASKS:
        return None
    caps = cap_checks(results)
    record = {"carry": "unknown", "capChecks": {role: passed(result) for role, result in caps.items()},
              "oldLimit": None}
    if len(caps) != len(ROLES):
        return record
    if task == "archive-carryover":
        record["carry"] = "carried" if all(passed(result) for result in caps.values()) else "lost"
        return record
    old = find(results, OLD_LIMIT)
    plain = next((r for r in results if r["name"].startswith(PLAIN_RESTOCK)), None)
    if old is None or plain is None:
        return record
    record["oldLimit"] = passed(old)
    rejecting = passed(caps["at_cap"]) and passed(caps["quantity"])
    if all(passed(result) for result in caps.values()) and passed(old):
        record["carry"] = "current"
    elif not passed(caps["at_cap"]) and not passed(caps["quantity"]) and passed(plain):
        record["carry"] = "forgot"
    elif rejecting and passed(plain) and not any(passed(check) for check in (old, caps["boundary"], caps["concurrent"])):
        record["carry"] = "stale"
    else:
        record["carry"] = "partial"
    return record


def for_hidden(task, hidden_path):
    """outcome() for a hidden.json file; None for another task, an unreadable file or one with no results."""
    try:
        results = json.loads(pathlib.Path(hidden_path).read_text()).get("results")
    except (OSError, ValueError):
        return None
    return outcome(task, results) if results else None


def fisher_greater(x1, n1, x2, n2):
    """One-sided Fisher exact p that group 1's carry rate is above group 2's: P(X >= x1), X hypergeometric."""
    total, carried = n1 + n2, x1 + x2
    ways = math.comb(total, carried)
    return sum(math.comb(n1, k) * math.comb(n2, carried - k)
               for k in range(x1, min(n1, carried) + 1) if carried - k <= n2) / ways


def tally(rows):
    """{label: count} over rows' carry labels; rows without one are counted as 'unscored'."""
    counts = {}
    for row in rows:
        key = row.get("carry") or "unscored"
        counts[key] = counts.get(key, 0) + 1
    return counts


def carried(rows):
    return sum(row.get("carry") in CARRIED for row in rows)


def arms_of(manifest):
    return [(arm["label"], arm["arm"]) for arm in manifest["arms"]]


def is_visp(spec):
    return spec.startswith(("visp:", "visp-codex:"))


def pct(part, whole):
    return f"{100 * part / whole:.0f}%" if whole else "–"


def comparisons(rows, arms, tasks):
    """VISP against each bare arm, pooled over the tasks both ran: counts, rates, delta and one-sided p."""
    found = []
    for visp_label, visp_spec in arms:
        if not is_visp(visp_spec):
            continue
        for bare_label, bare_spec in arms:
            if is_visp(bare_spec) or not bare_spec.startswith("bare"):
                continue
            shared = [task for task in tasks
                      if any(r["task"] == task and r["arm"] == visp_label for r in rows)
                      and any(r["task"] == task and r["arm"] == bare_label for r in rows)]
            left = [r for r in rows if r["arm"] == visp_label and r["task"] in shared and r.get("carry")]
            right = [r for r in rows if r["arm"] == bare_label and r["task"] in shared and r.get("carry")]
            if not left or not right:
                continue
            x1, x2 = carried(left), carried(right)
            delta = x1 / len(left) - x2 / len(right)
            p = fisher_greater(x1, len(left), x2, len(right))
            found.append({"visp": visp_label, "bare": bare_label, "tasks": shared, "visp_carried": x1,
                          "visp_runs": len(left), "bare_carried": x2, "bare_runs": len(right),
                          "delta": delta, "p": p, "meets": delta >= 0.20 and p < 0.05})
    return found


def markdown(manifest, rows):
    """The carry rate per arm and task, the label counts, and VISP against each bare arm."""
    arms = arms_of(manifest)
    tasks = [task for task in manifest["tasks"] if task in CARRY_TASKS]
    if not tasks:
        return "No carryover task (archive-carryover, archive-carryover-raised) in this batch.\n"
    out = ["## Carry", "",
           "Carried: the restock cap holds at its current value (`archive-carryover`: the cap checks pass; "
           "`-raised`: they pass and restock past the replaced 10000 limit works). Valid runs only.", "",
           "| Task | Arm | Runs | Carried | Rate | Labels | Intermediate reruns |",
           "| --- | --- | --- | --- | --- | --- | --- |"]
    for task in tasks:
        for label, _ in arms:
            group = [r for r in rows if r["task"] == task and r["arm"] == label]
            if not group:
                continue
            labels = ", ".join(f"{name} {count}" for name, count in sorted(tally(group).items()))
            reruns = sum(r.get("carryReruns") or 0 for r in group)
            out.append(f"| {task} | {label} | {len(group)} | {carried(group)} | {pct(carried(group), len(group))} "
                       f"| {labels} | {reruns} |")
    out += ["", "| Arm | Tasks | Runs | Carried | Rate | Intermediate reruns |", "| --- | --- | --- | --- | --- | --- |"]
    for label, _ in arms:
        group = [r for r in rows if r["arm"] == label and r["task"] in tasks]
        if group:
            names = ", ".join(sorted({r["task"] for r in group}))
            out.append(f"| {label} | {names} | {len(group)} | {carried(group)} | {pct(carried(group), len(group))} "
                       f"| {sum(r.get('carryReruns') or 0 for r in group)} |")
    pairs = comparisons(rows, arms, tasks)
    if pairs:
        out += ["", "VISP against each bare arm, counts pooled over the tasks both ran; one-sided Fisher exact p "
                "(VISP's carry rate above bare's). `meets` is a gain of at least 20 points with p < 0.05.", "",
                "| VISP arm | Bare arm | Tasks | VISP | Bare | Delta points | p | meets |",
                "| --- | --- | --- | --- | --- | --- | --- | --- |"]
        for pair in pairs:
            out.append(f"| {pair['visp']} | {pair['bare']} | {', '.join(pair['tasks'])} "
                       f"| {pair['visp_carried']}/{pair['visp_runs']} | {pair['bare_carried']}/{pair['bare_runs']} "
                       f"| {100 * pair['delta']:+.0f} | {pair['p']:.3f} | {'yes' if pair['meets'] else 'no'} |")
    unscored = [r["run"] for r in rows if r["task"] in tasks and not r.get("carry")]
    if unscored:
        out += ["", "Runs with no carry label (hidden checks not scored, or lacking the cap checks):", ""]
        out += [f"- {run}" for run in unscored]
    return "\n".join(out) + "\n"
