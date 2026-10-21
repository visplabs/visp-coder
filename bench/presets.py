"""Named benchmark configurations, so every run of a quality batch uses the same models.

A preset fixes the worker (model and effort), VISP's reviewer and tester (the visp.yml `critic`
block) and the two judges. setup_arm.py records the preset in arm.json and the runners copy it
into result.json, so report.py can refuse to compare runs made under different presets.
`default` keeps the configuration the published numbers were measured with.
"""

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


# VISP workflow modes an arm can add with `visp:<build>+<mode>`: visp.yml `workflow` keys. The
# mode is part of the arm, not the preset, so a batch compares it with the default on one preset.
VISP_MODES = {
    # Lean mode (docs/workflow.md#lean-mode): draft pictures first, one review per feature with at
    # most two rounds unless required findings remain, and gaps against the request required.
    "lean": {"draftFirst": "visual", "reviewCadence": "feature", "requestGaps": "required"},
    # Regression gate (docs/workflow.md#regression-gate): done and accept refuse while a test that
    # passed on the old code fails now.
    "gate": {"regressionGate": "gate"},
}


def visp_build(arm):
    """The build and workflow mode of a VISP arm: `visp:visp-cand+lean` -> ("visp-cand", "lean")."""
    build, _, mode = arm.split(":", 1)[1].partition("+")
    if mode and mode not in VISP_MODES:
        raise SystemExit(f"unknown VISP mode {mode}; known: {', '.join(VISP_MODES)}")
    return build, mode or None


def workflow_yaml(config, mode):
    """visp.yml with the mode's workflow keys added under `workflow:`, as `visp init` writes it."""
    if not mode:
        return config
    if "\nworkflow:\n" not in config:
        raise SystemExit("setup failed: visp.yml has no workflow block for the VISP mode")
    keys = "".join(f"  {key}: {value}\n" for key, value in VISP_MODES[mode].items())
    return config.replace("\nworkflow:\n", f"\nworkflow:\n{keys}", 1)


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
