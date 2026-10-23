"""Named benchmark configurations, so every run of a quality batch uses the same models.

A preset fixes the worker (model and effort), VISP's reviewer and tester (the visp.yml `critic`
block) and the two judges. setup_arm.py records the preset in arm.json and the runners copy it
into result.json, so report.py can refuse to compare runs made under different presets.
`default` keeps the configuration the published numbers were measured with.
"""
import json
import re
import subprocess

JUDGE = {"model": "claude-sonnet-5-5", "effort": "high"}
CODE_JUDGE = {"model": "claude-opus-5-5", "effort": "high"}
SONNET_CRITIC = {"harness": "claude-code", "launch": "claude-exec", "model": "claude-sonnet-5-5",
                 "reasoningEffort": "high"}
HAIKU_CRITIC = {**SONNET_CRITIC, "model": "claude-haiku-5-5"}

PRESETS = {
    # Haiku 4.5 worker at its default effort, VISP-launched Codex reviewer at medium effort.
    "default": {
        "worker": {"model": "claude-haiku-4-5-20251001", "effort": None},
        "critic": {"harness": "codex", "launch": "codex-exec", "reasoningEffort": "medium", "webSearch": True},
        "judge": JUDGE, "codeJudge": CODE_JUDGE,
    },
    "quality-2026-10": {
        "worker": {"model": "claude-haiku-5-5", "effort": "high"},
        "critic": SONNET_CRITIC, "judge": JUDGE, "codeJudge": CODE_JUDGE,
    },
    "quality-2026-10-sonnet": {
        "worker": {"model": "claude-sonnet-5-5", "effort": "high"},
        "critic": SONNET_CRITIC, "judge": JUDGE, "codeJudge": CODE_JUDGE,
    },
    # quality-2026-10 with the worker's own model as reviewer and tester: the critic ablation.
    "quality-2026-10-haiku-critic": {
        "worker": {"model": "claude-haiku-5-5", "effort": "high"},
        "critic": HAIKU_CRITIC, "judge": JUDGE, "codeJudge": CODE_JUDGE,
    },
    # A weaker worker: Haiku 5.5 at low effort, with the Sonnet critic and with its own model as critic.
    "quality-2026-10-low": {
        "worker": {"model": "claude-haiku-5-5", "effort": "low"},
        "critic": SONNET_CRITIC, "judge": JUDGE, "codeJudge": CODE_JUDGE,
    },
    "quality-2026-10-low-haiku-critic": {
        "worker": {"model": "claude-haiku-5-5", "effort": "low"},
        "critic": HAIKU_CRITIC, "judge": JUDGE, "codeJudge": CODE_JUDGE,
    },
}


# VISP modes an arm can add with `visp:<build>+<mode>[+<mode>...]`. A mode maps dotted visp.yml
# keys (`section.key`) to values, so it can set any config key, not only `workflow` ones. The
# mode is part of the arm, not the preset, so a batch compares it with the default on one preset.
VISP_MODES = {
    # Lean mode (docs/workflow.md#lean-mode): draft pictures first, one review per feature with at
    # most two rounds unless required findings remain, and gaps against the request required.
    "lean": {"workflow.draftFirst": "visual", "workflow.reviewCadence": "feature",
             "workflow.requestGaps": "required"},
    # Regression gate (docs/workflow.md#regression-gate): done and accept refuse while a test that
    # passed on the old code fails now.
    "gate": {"workflow.regressionGate": "gate"},
    # The reviewer and tester off (src/config/critic.ts criticModeSchema: auto | manual | both | off).
    # Everything else stays as the arm's other modes and the preset set it.
    "nocritic": {"critic.mode": "off"},
    # No recall: VISP records requests but its model passes no earlier decisions to a new feature
    # (src/config/schema.ts memorySchema.recall). Attributes a carryover gain to recall or to the rest.
    "norecall": {"memory.recall": False},
}


# Worker environment modes, an arm suffix after the arm and any VISP modes: `bare+compact100k`,
# `visp:cand+lean+compact100k`. Each sets variables in the worker's environment (run_claude.worker_env)
# and nothing in the project, so the prompt and the project files of the arm stay as they are.
# compact100k: Claude Code compacts the conversation when it reaches about 90k tokens, so no request
# passes the 100k price line (research-oct23.md C1). From https://code.claude.com/docs/en/env-vars:
# CLAUDE_CODE_AUTO_COMPACT_WINDOW is "how full the context gets before compaction", from 100000 to 1000000
# tokens, and beats the setting and the flag; CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (1-100) is the percentage of
# that window at which compaction triggers, and can only lower the threshold. Without them a model with a
# native 1M window (Haiku 5.5) compacts at about 967K tokens (https://code.claude.com/docs/en/model-config).
WORKER_ENV_MODES = {
    "compact100k": {"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "100000", "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "90"},
}


def split_worker_modes(arm):
    """An arm spec without its worker environment modes, and those modes.

    `visp:cand+lean+compact100k` -> ("visp:cand+lean", ["compact100k"]); `bare+compact100k` -> ("bare", ["compact100k"]).
    """
    head, *names = arm.split("+")
    modes = [name for name in names if name in WORKER_ENV_MODES]
    if len(set(modes)) != len(modes):
        raise SystemExit(f"worker mode repeated in {arm}")
    return "+".join([head, *(name for name in names if name not in WORKER_ENV_MODES)]), modes


def worker_env(modes):
    """The environment variables the worker modes set; {} for none."""
    return {key: value for mode in modes for key, value in WORKER_ENV_MODES[mode].items()}


def visp_build(arm):
    """The build and modes of a VISP arm: `visp:visp-cand+lean+nocritic` -> ("visp-cand", "lean+nocritic").

    Worker environment modes (`+compact100k`) are not VISP modes and are left out.
    """
    build, _, mode = split_worker_modes(arm)[0].split(":", 1)[1].partition("+")
    mode_config(mode)
    return build, mode or None


def mode_config(mode):
    """The dotted visp.yml keys of a `+`-joined mode string; {} for none. Unknown or clashing modes stop."""
    config = {}
    names = mode.split("+") if mode else []
    if len(set(names)) != len(names):
        raise SystemExit(f"VISP mode repeated in {mode}")
    for name in names:
        if name not in VISP_MODES:
            raise SystemExit(f"unknown VISP mode {name}; known: {', '.join(VISP_MODES)}")
        for key, value in VISP_MODES[name].items():
            if key in config and config[key] != value:
                raise SystemExit(f"VISP modes in {mode} set {key} to {config[key]} and {value}")
            config[key] = value
    return config


def arm_title(arm):
    """How a report names an arm: a VISP arm as `visp:<build>+<modes>`, any other as it is; worker modes follow."""
    base, workers = split_worker_modes(arm)
    suffix = "".join(f"+{name}" for name in workers)
    if not base.startswith(("visp:", "visp-codex:")):
        return base + suffix
    build, mode = visp_build(base)
    return f"{base.split(':', 1)[0]}:{build}" + (f"+{mode}" if mode else "") + suffix


def mode_difference(base, candidate):
    """The config keys two arms' modes set differently: {key: (base value, candidate value)}, None if unset."""
    left, right = mode_config(base), mode_config(candidate)
    return {key: (left.get(key), right.get(key)) for key in sorted({*left, *right}) if left.get(key) != right.get(key)}


def scalar(value):
    return str(value).lower() if isinstance(value, bool) else str(value)


def config_yaml(config, mode):
    """visp.yml with the mode's keys set, new ones first in their section as `visp init` writes them.

    A key the file already sets in its section is replaced; a section the file lacks is appended.
    """
    sections = {}
    for dotted, value in mode_config(mode).items():
        section, _, key = dotted.partition(".")
        if not key or "." in key:
            raise SystemExit(f"VISP mode key {dotted} is not section.key")
        sections.setdefault(section, {})[key] = value
    lines = config.split("\n")
    for section, keys in sections.items():
        head = next((i for i, line in enumerate(lines) if re.match(rf"{section}:\s*(#.*)?$", line)), None)
        if head is None:
            lines += ["", f"{section}:"] + [f"  {key}: {scalar(value)}" for key, value in keys.items()]
            continue
        end = head + 1
        while end < len(lines) and (not lines[end].strip() or lines[end][0] in " \t"):
            end += 1
        added = []
        for key, value in keys.items():
            at = next((i for i in range(head + 1, end) if re.match(rf"  {key}:(\s|$)", lines[i])), None)
            if at is None:
                added.append(f"  {key}: {scalar(value)}")
            else:
                lines[at] = f"  {key}: {scalar(value)}"
        lines[head + 1:head + 1] = added
    return "\n".join(lines)


def effective_settings(root, env):
    """{path: value} from `visp doctor --settings --json` in the project (works offline), or None."""
    try:
        done = subprocess.run(["visp", "doctor", "--settings", "--json"], cwd=root, env=env,
                              capture_output=True, text=True, timeout=120)
        settings = json.loads(done.stdout)["data"]["settings"]
        listed = (settings.get("value") or settings)["settings"]
        return {item["path"]: item["value"] for item in listed}
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError, AttributeError):
        return None


def arm_record(mode, effective):
    """The arm.json fields of a VISP arm: its modes, the keys they set and the settings VISP reports."""
    return {"vispMode": mode, "modeConfig": mode_config(mode), "effectiveSettings": effective}


def preset(name):
    if name not in PRESETS:
        raise SystemExit(f"unknown preset {name}; known: {', '.join(PRESETS)}")
    return PRESETS[name]


def critic_yaml(critic):
    """The visp.yml critic block for a preset, two-space indented as `visp init` writes it."""
    lines = ["critic:"]
    for key, value in critic.items():
        lines.append(f"  {key}: {str(value).lower() if isinstance(value, bool) else value}")
    return "\n".join(lines)
