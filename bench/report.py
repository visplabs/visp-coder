"""Report a batch: facts per run and per task x arm, and the base-versus-candidate quality rule.

Usage: report.py --batch <name> [--score] [--score-jobs 3] [--base LABEL] [--runs] [--md FILE] [--json FILE]
       report.py --batch <name> --carry [--score]
       report.py --compare BATCH:LABEL BATCH:LABEL ... [--score] [--runs] [--md FILE] [--json FILE]

Reads $VISP_BENCH_RUNS/batches/<name>/manifest.json (batch.py). Refuses a batch whose runs were
made under different presets, whose worker model differs from the preset's, or whose judge files
name another judge model than the preset's. Invalid runs (a usage limit or a worker failure,
runfacts.py) are excluded from every number and listed, with invalid runs a rerun moved to
discarded/; unfinished runs are listed. --score first runs score.py (hidden checks), judge.py
(visual tasks and games) and code_judge.py (every task but the visual ones) for finished valid
runs whose score file is missing or holds a failed judge call.

Every task kind has required scores: the hidden pass rate where the task has hidden checks, the
judge's overall score and checklist passes for the visual tasks and games, and the code-quality
score for every task but the visual ones. A chain task (chains.py) also requires `kept`, the share
of carried checks (earlier steps' checks that had passed) that no later step broke; its hidden
rate is the final project's on every step's checks, and its code score is on the cumulative change. A run with no output scores the minimum (no hidden
result: 0; no image or no index.html: judge 1, no checklist item). A run whose score is missing
or whose judge call failed has no score: its task is incomplete until --score scores it.

Per run: those scores, wall time, the worker's time split (runfacts.py: model, visp, own
commands, idle, and the Oct 13 legacy idle), VISP reviews run and unavailable, pictures delivered
to the reviewer, hook refusals and timeouts. Per task x arm: means of the scores, medians of the
times, sums of the counts. Chain tasks get their own table: chains with a regression, earlier
checks broken at any later step (unique, pooled over the arm's chains), regressions per carried
check evaluation, final hidden rate, code score, wall time and cost per chain; --runs adds one
row per step. Brownfield tasks with a reference (diffscope.py) get the diff scope: lines changed
against the reference change, and edits to existing files the reference left unchanged.

Reviewer probes (probe.py, tasks/<task>/probes) are reported as their own column where a run has
probes.json: the pass rate over all probes, and over the probes written for a reviewer finding.
They are never pooled into the hidden rate, are not a required score and do not enter the verdict.

Paired comparison: the first arm in the manifest (or --base) against each other arm, per task.
A task is incomplete (and fails) unless both arms have the same number of valid runs, at least
one, and every required score for each. The candidate passes a complete task when each mean score
is no lower than the base's and its median wall time and median idle time are at most 15% above
the base's (idle also may exceed a base under 60 s by up to 60 s, so a few seconds of waiting
against none is not a failure). Idle is not compared when neither arm has a Claude Code
transcript (Codex workers); when only one has, the task is incomplete. The candidate passes the
batch only when it passes every task. Prints Markdown and writes JSON (default
batches/<name>/report.json).

--carry (with --score, hidden checks only: no judge or code judge call) prints only the carry report of a batch with archive-carryover or archive-carryover-raised runs
(carry.py): per task and arm the share of runs that kept the restock cap at its current value, the
labels (carried, lost; current, stale, forgot, partial), the intermediate reruns, and VISP against each
bare arm with a one-sided Fisher exact p on the counts pooled over the tasks both ran. The labels come
from hidden.json, so runs scored before carry.py have them too. Hidden scores are not touched.

--compare is the one mode that crosses presets: it sets arms of different batches side by side
(say bare Sonnet against VISP with a Haiku worker), each batch under its own preset guard, with
cost per run and per passed hidden check, and gives no verdict.
"""
import argparse
import collections
import concurrent.futures
import json
import pathlib
import statistics
import subprocess
import sys

import carry
from chains import is_chain, run_summary
from common import RUNS
from diffscope import run_scope
from judge import CHECKLISTS, GAMES
from presets import arm_title, mode_config, mode_difference, scalar, split_worker_modes, visp_build, worker_env
from probe import has_probes, summarize as probe_summary
from runfacts import final_project, invalid, is_finished, mark_if_invalid, sessions, timing, transcripts

BENCH = pathlib.Path(__file__).resolve().parent
SLOWER = 0.15
IDLE_FLOOR = 60
SCORES = ("hidden", "kept", "judge", "checklist", "code")
SHARES = ("hidden", "kept")


def load(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def required(task):
    """The scores a task kind must have for every valid run."""
    needed = []
    if (BENCH / "tasks" / task / "hidden_test.py").exists():
        needed.append("hidden")
    if is_chain(task):
        needed.append("kept")
    if task in CHECKLISTS:
        needed += ["judge", "checklist"]
    if task not in CHECKLISTS or task in GAMES:
        needed.append("code")
    return needed


def judge_failed(judged):
    """A failed judge call (its own error, or no score), as opposed to a judged empty result."""
    return bool(judged.get("error")) or judged.get("overall") is None


def hidden_score(project):
    """(rate, text, problem). A run of the checks with no result passes nothing."""
    path = project.parent / "hidden.json"
    if not path.exists():
        return None, None, "hidden checks not scored"
    result = load(path)
    if not result or not result.get("results"):
        return 0.0, "no result", None
    passed = sum(bool(r["passed"]) for r in result["results"])
    return passed / len(result["results"]), f"{passed}/{len(result['results'])}", None


def probe_score(task, project):
    """(rate, text, findings rate, findings text) from probes.json, or Nones.

    Reviewer probes (probe.py) are their own metric: they are not hidden checks, are never pooled
    into the hidden rate, and are not part of the quality rule. A run whose probes are not scored
    is not incomplete.
    """
    result = load(project.parent / "probes.json") if has_probes(task) else None
    if not result or "error" in result:
        return None, None, None, None
    found = probe_summary(result)
    share = found["findingsPassed"] / found["findingsTotal"] if found["findingsTotal"] else None
    return found["rate"], found["text"], share, f"{found['findingsPassed']}/{found['findingsTotal']}"


def judge_score(run):
    """(overall, checklist passes, checklist text, problem)."""
    judged = load(run / "judge.json")
    if judged is None:
        return None, None, None, "not judged"
    if judge_failed(judged):
        return None, None, None, f"judge error: {str(judged.get('error'))[:160]}"
    passed = total = 0
    for key in ("elements", "styles"):
        done, count = str(judged.get(key, "0/0")).split("/")
        passed, total = passed + int(done), total + int(count)
    return judged["overall"], passed, f"{passed}/{total}", None


def code_score(project):
    """(overall, criteria, problem)."""
    code = load(project.parent / "code_judge.json")
    if code is None:
        return None, None, "code not judged"
    if judge_failed(code):
        return None, None, f"code judge error: {str(code.get('error'))[:160]}"
    return code["overall"], code.get("criteria"), None


def reviews(project):
    attempts = collections.Counter()
    for state in project.glob(".visp/features/*/critic/*.json"):
        for attempt in (load(state) or {}).get("attempts", []):
            attempts[attempt.get("status")] += 1
    pictures = 0
    for state in project.glob(".visp/features/*/product-state.json"):
        pictures += sum(1 for capture in (load(state) or {}).get("captures", [])
                        if str(capture.get("route", "")).startswith("result image: "))
    return attempts["reviewed"], attempts["unavailable"], pictures


def call_costs(run):
    """Cost of every claude call the run logged (claude_shim): all of them, and VISP's own."""
    calls = [json.loads(line) for line in (run / "claude-calls.jsonl").read_text().splitlines() if line.strip()] \
        if (run / "claude-calls.jsonl").exists() else []
    if not calls:
        return None, None
    total = sum(call.get("cost") or 0 for call in calls)
    critic = sum(call.get("cost") or 0 for call in calls if call.get("role") == "critic")
    return round(total, 3), round(critic, 3)


def facts(entry):
    run = RUNS / "runs" / entry["name"]
    results = [load(path) or {} for _, path in sessions(run)]
    project = final_project(run)
    needed = required(entry["task"])
    row = {"run": entry["name"], "task": entry["task"], "arm": entry["label"], "rep": entry["rep"],
           "hidden": None, "hiddenText": None, "probes": None, "probesText": None, "probeFindings": None,
           "probeFindingsText": None, "kept": None, "judge": None, "checklist": None, "checklistText": None,
           "code": None, "codeCriteria": None, "problems": []}
    if "hidden" in needed:
        row["hidden"], row["hiddenText"], problem = hidden_score(project)
        row["problems"] += [problem] if problem else []
    row["probes"], row["probesText"], row["probeFindings"], row["probeFindingsText"] = \
        probe_score(entry["task"], project)
    if "judge" in needed:
        row["judge"], row["checklist"], row["checklistText"], problem = judge_score(run)
        row["problems"] += [problem] if problem else []
    if "code" in needed:
        row["code"], row["codeCriteria"], problem = code_score(project)
        row["problems"] += [problem] if problem else []
    labelled = carry.for_hidden(entry["task"], project.parent / "hidden.json")
    row["carry"] = labelled["carry"] if labelled else None
    row["carryReruns"] = (load(project.parent / "intermediate.json") or {}).get("reruns") \
        if entry["task"] in carry.CARRY_TASKS else None
    chain = run_summary(run) if is_chain(entry["task"]) else None
    if "kept" in needed:
        row["kept"] = chain["kept"] if chain else None
        row["problems"] += [] if chain else ["no chain step results"]
    reviewed, unavailable, pictures = reviews(project)
    cost, critic_cost = call_costs(run)
    split = timing(transcripts(run))
    stage1 = load(run / "session1" / "hidden-stage1.json") if entry["twoSessions"] else None
    scope = run_scope(run, entry["task"], project)
    return {
        **row,
        "chain": chain, "diffScope": scope,
        "stage1": f"{stage1['passed']}/{stage1['total']}" if stage1 and "passed" in stage1 else None,
        "wall": sum(r.get("seconds") or 0 for r in results),
        "timedOut": any(r.get("timedOut") for r in results),
        "idle": split.get("idleSeconds"), "model": split.get("modelSeconds"), "visp": split.get("vispSeconds"),
        "own": split.get("ownCommandSeconds"), "legacyIdle": split.get("legacyIdle"),
        "refusals": split.get("refusals"), "reviewed": reviewed, "unavailable": unavailable, "pictures": pictures,
        "cost": cost, "criticCost": critic_cost,
    }


def arm_config_problems(entry, arm):
    """Where a VISP run's recorded config disagrees with its arm's modes (runs set up before the
    record existed have none and are not checked)."""
    if "modeConfig" not in arm or not entry["arm"].startswith(("visp:", "visp-codex:")):
        return []
    wanted = mode_config(visp_build(entry["arm"])[1])
    problems = []
    if arm["modeConfig"] != wanted:
        problems.append(f"{entry['name']}: arm.json modes set {arm['modeConfig']}, arm {entry['arm']} sets {wanted}")
    effective = arm.get("effectiveSettings")
    for key, value in wanted.items():
        if effective is not None and scalar(effective.get(key)) != scalar(value):
            problems.append(f"{entry['name']}: VISP reports {key} = {effective.get(key)!r}, arm {entry['arm']} "
                            f"sets {value!r}")
    return problems


def check_presets(manifest, entries):
    """Refuse runs made with another preset, worker or judge than the batch's."""
    wrong = []
    settings = manifest["settings"]
    worker = settings["worker"]["model"]
    judges = {"judge.json": settings["judge"], "code_judge.json": settings["codeJudge"]}
    for entry in entries:
        run = RUNS / "runs" / entry["name"]
        arm = load(run / "arm.json") or {}
        if arm.get("preset") != manifest["preset"]:
            wrong.append(f"{entry['name']}: arm.json preset {arm.get('preset')!r}")
        wrong += arm_config_problems(entry, arm)
        for label, path in sessions(run):
            result = load(path) or {}
            if result.get("preset") != manifest["preset"]:
                wrong.append(f"{entry['name']} {label}: result.json preset {result.get('preset')!r}")
            if not entry["arm"].startswith("visp-codex:") and result.get("model") != worker:
                wrong.append(f"{entry['name']} {label}: worker {result.get('model')!r}, preset worker {worker!r}")
        for name, expected in judges.items():
            judged = load((run if name == "judge.json" else final_project(run).parent) / name)
            want = f"{expected['model']}:{expected['effort']}"
            if judged is not None and judged.get("judge") != want:
                wrong.append(f"{entry['name']}: {name} judge {judged.get('judge')!r}, preset {want!r}")
    if wrong:
        raise SystemExit(f"refusing to report batch {manifest['batch']}: runs are not all preset "
                         f"{manifest['preset']}, or a VISP arm's config differs from its name:\n" + "\n".join(wrong))


def score_missing(entries, jobs, hidden_only=False):
    """Score what is missing, and judge again where a judge call failed; hidden_only runs score.py alone."""
    def needs(path):
        data = load(path)
        return data is None or judge_failed(data)

    def score(entry):
        run = RUNS / "runs" / entry["name"]
        project = final_project(run)
        needed = required(entry["task"])
        name = entry["name"] + (f"/{project.parent.name}" if project.parent != run else "")
        steps = []
        if "hidden" in needed and not (project.parent / "hidden.json").exists():
            steps.append(["score.py", entry["task"], name])
        if not hidden_only and has_probes(entry["task"]) and not (project.parent / "probes.json").exists():
            steps.append(["probe.py", entry["task"], name])
        if not hidden_only and "judge" in needed and needs(run / "judge.json"):
            steps.append(["judge.py", entry["name"]])
        if not hidden_only and "code" in needed and needs(project.parent / "code_judge.json"):
            steps.append(["code_judge.py", entry["name"]])
        for step in steps:
            done = subprocess.run([sys.executable, str(BENCH / step[0]), *step[1:]], capture_output=True, text=True)
            print(f"{step[0]} {entry['name']}: {(done.stdout or done.stderr).strip()[-300:]}", file=sys.stderr)

    with concurrent.futures.ThreadPoolExecutor(jobs) as pool:
        list(pool.map(score, entries))


def mean(values):
    values = [v for v in values if isinstance(v, (int, float))]
    return round(statistics.mean(values), 3) if values else None


def median(values):
    values = [v for v in values if isinstance(v, (int, float))]
    return round(statistics.median(values), 1) if values else None


def chain_totals(rows):
    """Regression facts pooled over a task x arm's chains, or {} for other tasks."""
    chains = [r["chain"] for r in rows if r.get("chain")]
    if not chains:
        return {}
    carried = sum(chain["carriedChecks"] for chain in chains)
    evaluations = sum(chain["carriedEvaluations"] for chain in chains)
    return {
        "chains": len(chains), "regressedChains": sum(chain["regressed"] for chain in chains),
        "brokenChecks": sum(len(chain["brokenChecks"]) for chain in chains), "carriedChecks": carried,
        "brokenShare": round(sum(len(chain["brokenChecks"]) for chain in chains) / carried, 4) if carried else None,
        "regressionEvents": sum(chain["regressionEvents"] for chain in chains), "carriedEvaluations": evaluations,
        "eventShare": round(sum(chain["regressionEvents"] for chain in chains) / evaluations, 4) if evaluations else None,
    }


def scope_totals(rows):
    """Median lines-changed ratio and mean unneeded edits over the runs with a diff scope."""
    scoped = [r["diffScope"]["total"] for r in rows if r.get("diffScope")]
    if not scoped:
        return {}
    return {"scopeRatio": median(s["ratio"] for s in scoped), "unneededEdits": mean(s["unneededEdits"] for s in scoped),
            "scoped": len(scoped)}


def summarize(rows, needed):
    """Means and medians over a task x arm's valid runs; `missing` lists runs without a required score."""
    return {
        **chain_totals(rows), **scope_totals(rows), "kept": mean(r["kept"] for r in rows),
        "n": len(rows), "required": needed,
        "missing": [f"{r['run']}: {problem}" for r in rows for problem in r["problems"]],
        "hidden": mean(r["hidden"] for r in rows), "judge": mean(r["judge"] for r in rows),
        "probes": mean(r["probes"] for r in rows), "probeFindings": mean(r["probeFindings"] for r in rows),
        "checklist": mean(r["checklist"] for r in rows), "code": mean(r["code"] for r in rows),
        "wall": median(r["wall"] for r in rows),
        "idle": median(r["idle"] for r in rows) if all(r["idle"] is not None for r in rows) else None,
        "model": median(r["model"] for r in rows), "visp": median(r["visp"] for r in rows),
        "own": median(r["own"] for r in rows), "legacyIdle": median(r["legacyIdle"] for r in rows),
        "reviewed": sum(r["reviewed"] for r in rows), "unavailable": sum(r["unavailable"] for r in rows),
        "pictures": sum(r["pictures"] for r in rows), "refusals": sum(r["refusals"] or 0 for r in rows),
        "timeouts": sum(r["timedOut"] for r in rows),
        "cost": mean(r["cost"] for r in rows), "criticCost": mean(r["criticCost"] for r in rows),
    }


def compare(base, cand, base_label, cand_label):
    """One task's verdict: {"status": pass | fail | incomplete, "reasons", "checks"}."""
    reasons = []
    for label, side in ((base_label, base), (cand_label, cand)):
        if not side["n"]:
            reasons.append(f"no valid runs for {label}")
        reasons += [f"{label}: {missing}" for missing in side["missing"]]
    if base["n"] and cand["n"] and base["n"] != cand["n"]:
        reasons.append(f"valid runs differ: {base_label} {base['n']}, {cand_label} {cand['n']}")
    if (base["idle"] is None) != (cand["idle"] is None) and base["n"] and cand["n"]:
        reasons.append("idle time known for one arm only")
    if reasons:
        return {"status": "incomplete", "reasons": reasons, "checks": []}
    checks = []
    for metric in base["required"]:
        ok = cand[metric] >= base[metric] - 1e-9
        checks.append((metric, base[metric], cand[metric], round(cand[metric] - base[metric], 3), "no drop", ok))
    for metric in ("wall", "idle"):
        if base[metric] is None:
            checks.append((metric, None, None, None, "n/a (no transcript)", True))
            continue
        limit = base[metric] * (1 + SLOWER)
        if metric == "idle" and base[metric] < IDLE_FLOOR:
            limit = max(limit, base[metric] + IDLE_FLOOR)
        checks.append((metric, base[metric], cand[metric], round(cand[metric] - base[metric], 1),
                       "at most +15%", cand[metric] <= limit))
    return {"status": "pass" if all(check[-1] for check in checks) else "fail", "reasons": [], "checks": checks}


def arm_specs(manifest):
    """{label: arm} of a batch, as batch.py wrote it."""
    return {entry["label"]: entry["arm"] for entry in manifest["arms"]}


def is_visp(spec):
    return spec.startswith(("visp:", "visp-codex:"))


def pair_note(base, cand):
    """What sets two arms apart, for the heading of their comparison."""
    (base_arm, base_env), (cand_arm, cand_env) = split_worker_modes(base), split_worker_modes(cand)
    env = f"; worker modes {'+'.join(base_env) or 'none'} -> {'+'.join(cand_env) or 'none'}" if base_env != cand_env else ""
    if is_visp(base) and is_visp(cand) and visp_build(base)[0] == visp_build(cand)[0]:
        diff = mode_difference(visp_build(base)[1], visp_build(cand)[1])
        if not diff:
            return "same build and same config keys" + env
        keys = ", ".join(f"{key} {'unset' if before is None else before} -> {'unset' if after is None else after}"
                         for key, (before, after) in diff.items())
        return f"same build, config differs only in: {keys}" + env
    if base_arm == cand_arm and base_env != cand_env:
        return f"same arm{env}"
    return "different builds or workflows"


def fmt(value, metric=None):
    if value is None:
        return "–"
    if metric in SHARES or metric in ("probes", "probeFindings"):
        return f"{value * 100:.1f}%"
    return f"{value:g}" if isinstance(value, (int, float)) else str(value)


def markdown(manifest, rows, groups, comparisons, excluded, unfinished, show_runs):
    out = [f"## Batch {manifest['batch']} (preset {manifest['preset']})", ""]
    worker = manifest["settings"]["worker"]
    out.append(f"Worker {worker['model']} ({worker['effort'] or 'default effort'}); "
               f"{len(rows)} valid runs; {len(excluded)} invalid runs excluded; {len(unfinished)} unfinished.")
    probed = any(g["probes"] is not None for g in groups.values())
    out += ["", "| Task | Arm | n | Hidden |" + (" Probes | Probes from findings |" if probed else "") +
            " Judge | Checklist | Code | Wall s | Idle s | Model s | VISP s | Own s "
            "| Legacy idle s | Reviews run/unavailable | Pictures | Refusals | Timeouts | Cost $ (VISP's) |",
            "| --- | --- | --- | --- |" + " --- |" * (14 + (2 if probed else 0))]
    for (task, arm), s in groups.items():
        extra = f" {fmt(s['probes'], 'probes')} | {fmt(s['probeFindings'], 'probes')} |" if probed else ""
        out.append(f"| {task} | {arm} | {s['n']} | {fmt(s['hidden'], 'hidden')} |{extra} {fmt(s['judge'])} | "
                   f"{fmt(s['checklist'])} | {fmt(s['code'])} | {fmt(s['wall'])} | {fmt(s['idle'])} | "
                   f"{fmt(s['model'])} | {fmt(s['visp'])} | {fmt(s['own'])} | {fmt(s['legacyIdle'])} | "
                   f"{s['reviewed']}/{s['unavailable']} | {s['pictures']} | {s['refusals']} | {s['timeouts']} | "
                   f"{fmt(s['cost'])} ({fmt(s['criticCost'])}) |")
    out.append("")
    if probed:
        out.append("Probes (probe.py) are checks of contract rules a reviewer's findings cover and the hidden checks "
                   "leave out. They are a separate metric, never pooled into Hidden and not part of the quality rule; "
                   "\"from findings\" counts only the probes written for a reviewer finding; – where not scored.")
        out.append("")
    specs = arm_specs(manifest)
    out += ["| Label | Arm | Config keys its modes set |", "| --- | --- | --- |"]
    for label, spec in specs.items():
        keys = ", ".join(f"{key}: {value}" for key, value in mode_config(visp_build(spec)[1]).items()) \
            if is_visp(spec) else ""
        variables = ", ".join(f"{key}={value}" for key, value in worker_env(split_worker_modes(spec)[1]).items())
        keys = "; ".join(part for part in (keys, f"worker env {variables}" if variables else "") if part)
        out.append(f"| {label} | {arm_title(spec)} | {keys or '–'} |")
    out.append("")
    out.append("Scores are means over valid runs (– where a run has no score yet); times are medians (wall: all "
               "sessions; idle, model, VISP and own from the worker transcript; legacy idle: gaps over 240 s). Cost is "
               "the mean list-price cost the claude CLI reported for every call the run made (claude_shim), with "
               "VISP's reviewer and tester calls in brackets; – where the run predates the shim.")
    for cand, result in comparisons.items():
        base_spec, cand_spec = specs[result["base"]], specs[cand]
        out += ["", f"### {arm_title(cand_spec)} against {arm_title(base_spec)}: "
                    f"{'PASS' if result['passed'] else 'FAIL'}", "",
                f"Arms {cand} and {result['base']}; {pair_note(base_spec, cand_spec)}.", "",
                "| Task | Metric | Base | Candidate | Delta | Rule | Result |", "| --- | --- | --- | --- | --- | --- | --- |"]
        for task, verdict in result["tasks"].items():
            for reason in verdict["reasons"]:
                out.append(f"| {task} | – | – | – | – | {reason} | incomplete |")
            for metric, base, value, delta, rule, ok in verdict["checks"]:
                share = metric in SHARES and delta is not None
                shown = fmt(delta * 100 if share else delta)
                out.append(f"| {task} | {metric} | {fmt(base, metric)} | {fmt(value, metric)} | "
                           f"{shown}{' pp' if share else ''} | {rule} | {'pass' if ok else 'FAIL'} |")
    out += chain_markdown(rows, groups, show_runs) + scope_markdown(rows, groups, show_runs)
    if excluded:
        out += ["", "Invalid runs, excluded:", ""]
        out += [f"- {name}: {reason}" for name, reason in excluded]
    if unfinished:
        out += ["", "Unfinished runs (no result), excluded:", ""]
        out += [f"- {name}" for name in unfinished]
    if show_runs:
        out += ["", "| Run | Hidden | Probes | Stage 1 | Judge | Checklist | Code | Wall s | Idle s | Model s | VISP s | Own s "
                "| Legacy idle s | Reviews | Pictures | Refusals | Timed out | Cost $ | Missing |",
                "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
        for r in rows:
            out.append(f"| {r['run']} | {r['hiddenText'] or '–'} | {r['probesText'] or '–'} | {r['stage1'] or '–'} | {fmt(r['judge'])} | "
                       f"{r['checklistText'] or '–'} | {fmt(r['code'])} | {r['wall']} | {fmt(r['idle'])} | "
                       f"{fmt(r['model'])} | {fmt(r['visp'])} | {fmt(r['own'])} | {fmt(r['legacyIdle'])} | "
                       f"{r['reviewed']}/{r['unavailable']} | {r['pictures']} | {fmt(r['refusals'])} | "
                       f"{'yes' if r['timedOut'] else 'no'} | {fmt(r['cost'])} | {'; '.join(r['problems']) or '–'} |")
    return "\n".join(out) + "\n"


def share(part, whole):
    return f"{part}/{whole} ({part / whole * 100:.1f}%)" if whole else "–"


def chain_markdown(rows, groups, show_runs):
    """The regression table for chain tasks, and with --runs one row per step."""
    chained = {key: s for key, s in groups.items() if s.get("chains")}
    if not chained:
        return []
    out = ["", "### Chains", "", "| Task | Arm | Chains | With a regression | Earlier checks broken | Regressions per "
           "carried check | Kept | Final hidden | Code | Wall s | Cost $ |", "| --- | --- | --- | --- | --- | --- | --- | --- "
           "| --- | --- | --- |"]
    for (task, arm), s in chained.items():
        out.append(f"| {task} | {arm} | {s['chains']} | {share(s['regressedChains'], s['chains'])} | "
                   f"{share(s['brokenChecks'], s['carriedChecks'])} | {share(s['regressionEvents'], s['carriedEvaluations'])} "
                   f"| {fmt(s['kept'], 'kept')} | {fmt(s['hidden'], 'hidden')} | {fmt(s['code'])} | {fmt(s['wall'])} | "
                   f"{fmt(s['cost'])} |")
    out += ["", "A carried check is an earlier step's check (step 0: the starting contract) that passed before a later "
            "step; it regresses when it fails after that step. Earlier checks broken counts each check once, at any "
            "later step; regressions per carried check counts every step's carried checks. Wall time is the median "
            "over the chain's sessions summed, cost the mean per chain."]
    if show_runs:
        out += ["", "| Run | Step | Hidden | New checks | Carried | Regressions | Lines / reference | Unneeded edits |",
                "| --- | --- | --- | --- | --- | --- | --- | --- |"]
        for r in rows:
            if not r.get("chain"):
                continue
            scopes = {step["step"]: step for step in (r.get("diffScope") or {}).get("steps", [])}
            for step in r["chain"]["steps"]:
                found = scopes.get(step["step"], {})
                out.append(f"| {r['run']} | {step['step']} | {step['passed']}/{step['total']} | "
                           f"{step['newPassed']}/{step['newTotal']} | {step['carried']} | "
                           f"{'; '.join(step['regressions']) or '–'} | "
                           f"{found.get('lines', '–')}/{found.get('referenceLines', '–')} | "
                           f"{', '.join(found.get('unneededEdits', [])) or '–'} |")
    return out


def scope_markdown(rows, groups, show_runs):
    scoped = {key: s for key, s in groups.items() if s.get("scoped")}
    if not scoped:
        return []
    out = ["", "### Diff scope", "", "| Task | Arm | Runs | Lines changed / reference (median) | Edits to files the "
           "reference left unchanged (mean) |", "| --- | --- | --- | --- | --- |"]
    out += [f"| {task} | {arm} | {s['scoped']} | {fmt(s['scopeRatio'])} | {fmt(s['unneededEdits'])} |"
            for (task, arm), s in scoped.items()]
    out += ["", "Lines added plus removed outside tests, over the product's own files (the code judge's view), against "
            "the reference change for the same request; per step for chains, summed. An unneeded edit changes or "
            "deletes a file that existed before and that the reference change left alone."]
    if show_runs:
        out += ["", "| Run | Lines | Reference lines | Ratio | Test lines | Unneeded edits |", "| --- | --- | --- | --- | --- | --- |"]
        out += [f"| {r['run']} | {r['diffScope']['total']['lines']} | {r['diffScope']['total']['referenceLines']} | "
                f"{fmt(r['diffScope']['total']['ratio'])} | {r['diffScope']['total']['testLines']} | "
                f"{r['diffScope']['total']['unneededEdits']} |" for r in rows if r.get("diffScope")]
    return out


def load_batch(name, score=False, score_jobs=3, hidden_only=False):
    """A batch's manifest, valid rows, invalid and unfinished runs, under the preset guard."""
    directory = RUNS / "batches" / name
    manifest = load(directory / "manifest.json")
    if not manifest:
        raise SystemExit(f"no manifest at {directory / 'manifest.json'}")
    finished, unfinished = [], []
    for entry in manifest["runs"]:
        if is_finished(RUNS / "runs" / entry["name"], entry["twoSessions"]):
            finished.append(entry)
        else:
            unfinished.append(entry["name"])
    check_presets(manifest, finished)
    excluded, valid = [], []
    for entry in finished:
        stopped = mark_if_invalid(RUNS / "runs" / entry["name"])
        if stopped:
            excluded.append((entry["name"], f"{stopped['reason']}: {stopped['source']}: "
                                            f"{stopped['match'].strip()[:120]}"))
        else:
            valid.append(entry)
    for entry in manifest["runs"]:
        for moved in sorted((RUNS / "discarded").glob(f"{entry['name']}-*-invalid")):
            reason = invalid(moved) or {}
            excluded.append((moved.name, f"moved to discarded/ by --rerun-invalid: {reason.get('reason')}, "
                                         f"{reason.get('source')}"))
    if score:
        score_missing(valid, score_jobs, hidden_only)
    check_presets(manifest, valid)
    return manifest, [facts(entry) for entry in valid], excluded, unfinished


def passed_checks(row):
    """Hidden checks a run passed (none when its checks gave no result)."""
    text = row["hiddenText"] or ""
    return int(text.split("/")[0]) if "/" in text else 0


def cross_summary(rows):
    """Scores, time and cost over one arm's valid runs of one task (or of every task)."""
    costed = [r for r in rows if r["cost"] is not None]
    hidden = [r for r in costed if r["hidden"] is not None]
    passed = sum(passed_checks(r) for r in hidden)
    scored = [r for r in rows if r["hidden"] is not None]
    return {
        "n": len(rows), "costed": len(costed), "missing": [f"{r['run']}: {p}" for r in rows for p in r["problems"]],
        "hidden": mean(r["hidden"] for r in rows), "judge": mean(r["judge"] for r in rows),
        "checklist": mean(r["checklist"] for r in rows), "code": mean(r["code"] for r in rows),
        "wall": median(r["wall"] for r in rows),
        "cost": mean(r["cost"] for r in costed), "criticCost": mean(r["criticCost"] for r in costed),
        "passedChecks": sum(passed_checks(r) for r in scored) if scored else None,
        "costPerPassedCheck": round(sum(r["cost"] for r in hidden) / passed, 4) if passed else None,
    }


def cross(specs, score=False, score_jobs=3):
    """Compare arms across batches made under different presets or worker models.

    Each spec is BATCH:LABEL. Every batch passes its own preset guard; the arms may differ in
    worker and critic, but every batch must use the same visual and code judges, or their scores
    are not comparable. No pass or fail verdict: the quality rule compares arms of one preset.
    """
    batches, arms = {}, []
    for spec in specs:
        if ":" not in spec:
            raise SystemExit(f"--compare takes BATCH:LABEL, not {spec!r}")
        name, arm = spec.split(":", 1)
        if name not in batches:
            batches[name] = load_batch(name, score, score_jobs)
        manifest = batches[name][0]
        if arm not in [a["label"] for a in manifest["arms"]]:
            raise SystemExit(f"batch {name} has no arm {arm!r}; arms: "
                             f"{', '.join(a['label'] for a in manifest['arms'])}")
        arms.append((name, arm))
    judges = {name: (m["settings"]["judge"], m["settings"]["codeJudge"]) for name, (m, *_) in batches.items()}
    if len({json.dumps(j, sort_keys=True) for j in judges.values()}) > 1:
        raise SystemExit("refusing to compare: the batches use different judges: "
                         + "; ".join(f"{name}: {j}" for name, j in judges.items()))
    tasks = []
    for name, _ in arms:
        tasks += [t for t in batches[name][0]["tasks"] if t not in tasks]
    groups, totals = {}, {}
    for name, arm in arms:
        rows = [r for r in batches[name][1] if r["arm"] == arm]
        totals[f"{name}:{arm}"] = cross_summary(rows)
        for task in tasks:
            if task in batches[name][0]["tasks"]:
                groups[(task, f"{name}:{arm}")] = cross_summary([r for r in rows if r["task"] == task])
    return batches, arms, tasks, groups, totals


def cross_markdown(batches, arms, tasks, groups, totals, show_runs=False):
    out = ["## Arms across presets", "", "| Arm | Preset | Worker | Reviewer and tester | Valid runs | Invalid | "
           "Unfinished |", "| --- | --- | --- | --- | --- | --- | --- |"]
    for name, arm in arms:
        manifest, _, excluded, unfinished = batches[name]
        settings = manifest["settings"]
        worker = settings["worker"]
        spec = next(a["arm"] for a in manifest["arms"] if a["label"] == arm)
        critic = settings["critic"].get("model") or settings["critic"]["harness"] if spec.startswith("visp") \
            else "none"
        names = {entry["name"] for entry in manifest["runs"] if entry["label"] == arm}
        mine = [run for run, _ in excluded if run in names or run.rsplit("-", 2)[0] in names]
        out.append(f"| {name}:{arm} | {manifest['preset']} | {worker['model']} ({worker['effort'] or 'default'}) | "
                   f"{critic} | {totals[f'{name}:{arm}']['n']} | {len(mine)} | "
                   f"{sum(1 for run in unfinished if run in names)} |")
    header = ["", "| Task | Arm | n | Hidden | Passed checks | Judge | Checklist | Code | Wall s | Cost $/run "
              "(VISP's) | Cost $/passed check | Costed runs |",
              "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    out += header

    def line(task, arm, s):
        return (f"| {task} | {arm} | {s['n']} | {fmt(s['hidden'], 'hidden')} | {fmt(s['passedChecks'])} | "
                f"{fmt(s['judge'])} | {fmt(s['checklist'])} | {fmt(s['code'])} | {fmt(s['wall'])} | "
                f"{fmt(s['cost'])} ({fmt(s['criticCost'])}) | {fmt(s['costPerPassedCheck'])} | {s['costed']} |")
    for task in tasks:
        for name, arm in arms:
            if (task, f"{name}:{arm}") in groups:
                out.append(line(task, f"{name}:{arm}", groups[(task, f"{name}:{arm}")]))
    for name, arm in arms:
        out.append(line("all tasks", f"{name}:{arm}", totals[f"{name}:{arm}"]))
    out += ["", "Scores are means over valid runs, wall time the median. Cost is the list-price cost the claude CLI "
            "reported for every call of a run (claude_shim), VISP's reviewer and tester calls in brackets; cost per "
            "passed check is the summed cost of the costed runs with hidden checks over the hidden checks they "
            "passed. Arms in different batches ran at different times; read the difference with the per-run rows."]
    covered = {frozenset(t for t in tasks if (t, f"{name}:{arm}") in groups) for name, arm in arms}
    if len(covered) > 1:
        out += ["", "The arms ran different tasks, so their all-tasks rows are not comparable."]
    for name, arm in arms:
        missing = totals[f"{name}:{arm}"]["missing"]
        if missing:
            out += ["", f"{name}:{arm} runs without a required score:", ""] + [f"- {m}" for m in missing]
    if show_runs:
        out += ["", "| Run | Arm | Hidden | Judge | Checklist | Code | Wall s | Cost $ | VISP's $ |",
                "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
        for name, arm in arms:
            for r in (r for r in batches[name][1] if r["arm"] == arm):
                out.append(f"| {r['run']} | {name}:{arm} | {r['hiddenText'] or '–'} | {fmt(r['judge'])} | "
                           f"{r['checklistText'] or '–'} | {fmt(r['code'])} | {r['wall']} | {fmt(r['cost'])} | "
                           f"{fmt(r['criticCost'])} |")
    return "\n".join(out) + "\n"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch")
    parser.add_argument("--compare", nargs="+", metavar="BATCH:LABEL",
                        help="compare arms across batches made under different presets or worker models, with "
                             "cost per run and per passed hidden check; no quality-rule verdict")
    parser.add_argument("--score", action="store_true")
    parser.add_argument("--score-jobs", type=int, default=3)
    parser.add_argument("--base", help="the base arm label (default: the first arm in the manifest)")
    parser.add_argument("--runs", action="store_true", help="also print one row per run")
    parser.add_argument("--carry", action="store_true",
                        help="print only the carry rate per arm and task and VISP against each bare arm (carry.py)")
    parser.add_argument("--pairwise", action="store_true",
                        help="also judge each picture task's base and candidate images side by side (pairwise.py)")
    parser.add_argument("--md", type=pathlib.Path)
    parser.add_argument("--json", type=pathlib.Path)
    args = parser.parse_args()
    if args.compare:
        if args.batch or args.base or args.pairwise:
            raise SystemExit("--compare takes no --batch, --base or --pairwise")
        result = cross(args.compare, args.score, args.score_jobs)
        text = cross_markdown(*result, show_runs=args.runs)
        print(text)
        if args.md:
            args.md.write_text(text)
        if args.json:
            batches, arms, tasks, groups, totals = result
            args.json.write_text(json.dumps({
                "compare": args.compare,
                "presets": {name: {"preset": m["preset"], "settings": m["settings"]} for name, (m, *_) in batches.items()},
                "runs": [r for name, arm in arms for r in batches[name][1] if r["arm"] == arm],
                "groups": [{"task": task, "arm": arm, **s} for (task, arm), s in groups.items()],
                "totals": totals}, indent=2))
        return
    if not args.batch:
        raise SystemExit("give --batch, or --compare BATCH:LABEL ...")
    directory = RUNS / "batches" / args.batch
    manifest, rows, excluded, unfinished = load_batch(args.batch, args.score, args.score_jobs, args.carry)
    if args.carry:
        print(carry.markdown(manifest, rows))
        return
    labels = [arm["label"] for arm in manifest["arms"]]
    groups = {}
    for task in manifest["tasks"]:
        for label in labels:
            groups[(task, label)] = summarize([r for r in rows if r["task"] == task and r["arm"] == label],
                                              required(task))
    base = args.base or labels[0]
    comparisons = {}
    for cand in labels:
        if cand == base:
            continue
        tasks = {task: compare(groups[(task, base)], groups[(task, cand)], base, cand) for task in manifest["tasks"]}
        comparisons[cand] = {"base": base, "passed": all(t["status"] == "pass" for t in tasks.values()),
                             "tasks": tasks}
    text = markdown(manifest, rows, groups, comparisons, excluded, unfinished, args.runs)
    if args.pairwise:
        import pairwise  # imported here: it reads the judge's images, which --score writes first

        text += pairwise.markdown(*pairwise.run(args.batch, base))
    print(text)
    if args.md:
        args.md.write_text(text)
    fields = ("metric", "base", "candidate", "delta", "rule", "passed")
    report = {"batch": args.batch, "preset": manifest["preset"], "settings": manifest["settings"],
              "arms": [{"label": label, "arm": spec, "title": arm_title(spec),
                        "modeConfig": mode_config(visp_build(spec)[1]) if is_visp(spec) else {}}
                       for label, spec in arm_specs(manifest).items()],
              "runs": rows,
              "groups": [{"task": task, "arm": arm, **summary} for (task, arm), summary in groups.items()],
              "comparisons": {cand: {**result, "tasks": {
                  task: {**verdict, "checks": [dict(zip(fields, check)) for check in verdict["checks"]]}
                  for task, verdict in result["tasks"].items()}} for cand, result in comparisons.items()},
              "invalid": [{"run": name, "reason": reason} for name, reason in excluded],
              "unfinished": unfinished}
    (args.json or directory / "report.json").write_text(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
