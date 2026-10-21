"""Blind pairwise judge for a batch's picture tasks: which of two arms' images delivers the request?

Usage: python3 bench/pairwise.py --batch <batch> [--base <label>] [--jobs 4]
For every visual task, the base arm's run and each other arm's run of the same rep are shown to
the batch preset's visual judge twice, in both orders, from the PNGs judge.py already rendered
(run report.py --score first). A pair is a win only when both orders agree; a split verdict is a
tie, which cancels the judge's lean towards one position. Verdicts are cached in
batches/<batch>/pairwise.json, so a rerun asks only about new pairs.

The 1-10 judge moved 0.25 on runs whose before-and-after images differ visibly; asking which of
two images is better is the more sensitive question.
"""
import argparse
import concurrent.futures
import json
import pathlib

from common import RUNS
from judge import CHECKLISTS, GAMES, JUDGE, ask

BENCH = pathlib.Path(__file__).resolve().parent
SCHEMA = {
    "type": "object",
    "properties": {"better": {"type": "string", "enum": ["first", "second", "tie"]},
                   "reason": {"type": "string"}},
    "required": ["better", "reason"],
}


def blind(name):
    path = RUNS / "runs" / name / "judge.json"
    judged = json.loads(path.read_text()) if path.exists() else {}
    image = judged.get("blind")
    return RUNS / "judge" / image if image and (RUNS / "judge" / image).is_file() else None


def verdict(settings, request, first, second):
    prompt = (f"Two images were made for the same request. Open {first} (the first image) and {second} (the second "
              f"image) with the Read tool and look at both carefully.\n\nRequest:\n{request}\n\nWhich image better "
              "delivers the request as a whole: a recognizable subject, the parts and looks the request names, and "
              "visual quality? Answer tie only when neither is better. Give the main reason in one or two sentences.")
    answer, usage = ask(settings["model"], settings["effort"], prompt, RUNS / "judge", SCHEMA)
    return answer.get("better"), answer.get("reason", ""), usage.get("total_cost_usd") or 0


def compare(settings, task, base, other):
    """Both orders; the arm both name wins, otherwise a tie."""
    request = (BENCH / "tasks" / task / "task.md").read_text().strip()
    a, b = blind(base), blind(other)
    if not a or not b:
        return {"winner": None, "missing": [n for n, image in ((base, a), (other, b)) if not image]}
    one, why_one, cost_one = verdict(settings, request, a, b)
    two, why_two, cost_two = verdict(settings, request, b, a)
    first = {"first": "base", "second": "candidate"}.get(one, "tie")
    second = {"first": "candidate", "second": "base"}.get(two, "tie")
    return {"winner": first if first == second else "tie", "votes": [first, second],
            "reasons": [why_one[:300], why_two[:300]], "cost": round(cost_one + cost_two, 4)}


def run(batch, base_label=None, jobs=4):
    directory = RUNS / "batches" / batch
    manifest = json.loads((directory / "manifest.json").read_text())
    settings = manifest["settings"].get("judge") or JUDGE
    labels = list(dict.fromkeys(entry["label"] for entry in manifest["runs"]))
    base_label = base_label or labels[0]
    names = {(e["task"], e["label"], e["rep"]): e["name"] for e in manifest["runs"]}
    cache_path = directory / "pairwise.json"
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    wanted = []
    for (task, label, rep), name in names.items():
        if label == base_label or task not in CHECKLISTS or task in GAMES:
            continue
        base = names.get((task, base_label, rep))
        key = f"{task}|{base_label}|{label}|{rep}"
        if base and (key not in cache or cache[key].get("winner") is None):
            wanted.append((key, task, base, name))
    with concurrent.futures.ThreadPoolExecutor(jobs) as pool:
        for key, result in zip([w[0] for w in wanted],
                               pool.map(lambda w: compare(settings, w[1], w[2], w[3]), wanted)):
            cache[key] = result
    cache_path.write_text(json.dumps(cache, indent=2))
    return base_label, cache


def tally(base_label, cache):
    """{candidate: {task: {"candidate": n, "base": n, "tie": n, "missing": n}}}."""
    out = {}
    for key, result in cache.items():
        task, base, label, _ = key.split("|")
        if base != base_label:
            continue
        counts = out.setdefault(label, {}).setdefault(task, {"candidate": 0, "base": 0, "tie": 0, "missing": 0})
        counts[result.get("winner") or "missing"] += 1
    return out


def markdown(base_label, cache):
    lines = []
    for label, tasks in tally(base_label, cache).items():
        pooled = {"candidate": 0, "base": 0, "tie": 0, "missing": 0}
        lines += ["", f"### Pairwise: {label} against {base_label} (both orders; a split verdict is a tie)", "",
                  f"| Task | {label} wins | {base_label} wins | Ties | Not compared |", "| --- | --- | --- | --- | --- |"]
        for task, counts in sorted(tasks.items()):
            for side in pooled:
                pooled[side] += counts[side]
            lines.append(f"| {task} | {counts['candidate']} | {counts['base']} | {counts['tie']} | {counts['missing']} |")
        lines.append(f"| all picture tasks | {pooled['candidate']} | {pooled['base']} | {pooled['tie']} | "
                     f"{pooled['missing']} |")
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch", required=True)
    parser.add_argument("--base")
    parser.add_argument("--jobs", type=int, default=4)
    args = parser.parse_args()
    base_label, cache = run(args.batch, args.base, args.jobs)
    print(markdown(base_label, cache))


if __name__ == "__main__":
    main()
