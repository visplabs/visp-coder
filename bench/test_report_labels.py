"""Unit tests for how report.py names arms and checks that VISP arms ran as named.

Run from the repository root: python3 -m unittest bench/test_report_labels.py
No models are called and no benchmark runs are read.
"""
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import report  # noqa: E402

MANIFEST = {
    "batch": "b2", "preset": "quality-2026-10",
    "settings": {"worker": {"model": "claude-haiku-5-5", "effort": "high"}},
    "arms": [{"label": "bare", "arm": "bare"},
             {"label": "develop", "arm": "visp:develop"},
             {"label": "candidate-lean", "arm": "visp:candidate+lean"},
             {"label": "candidate-lean-nocritic", "arm": "visp:candidate+lean+nocritic"}],
}


def entry(arm, label):
    return {"name": f"b2-t-{label}-1", "arm": arm, "label": label}


class PairNote(unittest.TestCase):
    def test_same_build_names_the_one_key_that_differs(self):
        self.assertEqual(report.pair_note("visp:c+lean", "visp:c+lean+nocritic"),
                         "same build, config differs only in: critic.mode unset -> off")

    def test_same_build_and_modes(self):
        self.assertEqual(report.pair_note("visp:c+lean", "visp:c+lean"), "same build and same config keys")

    def test_other_builds_or_workflows_are_not_called_config_differences(self):
        self.assertEqual(report.pair_note("visp:a+lean", "visp:b+lean"), "different builds or workflows")
        self.assertEqual(report.pair_note("bare", "visp:b"), "different builds or workflows")


class Markdown(unittest.TestCase):
    def render(self, base, cand):
        manifest = {**MANIFEST, "arms": [a for a in MANIFEST["arms"] if a["label"] in (base, cand)]}
        comparisons = {cand: {"base": base, "passed": False, "tasks": {}}}
        return report.markdown(manifest, [], {}, comparisons, [], [], False)

    def test_the_arm_table_gives_each_arm_its_title_and_config_keys(self):
        text = self.render("candidate-lean", "candidate-lean-nocritic")
        self.assertIn("| candidate-lean | visp:candidate+lean | workflow.draftFirst: visual, "
                      "workflow.reviewCadence: feature, workflow.requestGaps: required |", text)
        self.assertIn("| candidate-lean-nocritic | visp:candidate+lean+nocritic | workflow.draftFirst: visual, "
                      "workflow.reviewCadence: feature, workflow.requestGaps: required, critic.mode: off |", text)

    def test_the_comparison_heading_uses_the_arm_titles(self):
        text = self.render("candidate-lean", "candidate-lean-nocritic")
        self.assertIn("### visp:candidate+lean+nocritic against visp:candidate+lean: FAIL", text)
        self.assertIn("same build, config differs only in: critic.mode unset -> off", text)

    def test_a_bare_base_keeps_its_name(self):
        text = self.render("bare", "develop")
        self.assertIn("### visp:develop against bare: FAIL", text)
        self.assertIn("| bare | bare | – |", text)


class ArmConfigProblems(unittest.TestCase):
    NOCRITIC = entry("visp:candidate+lean+nocritic", "candidate-lean-nocritic")

    def arm(self, mode, effective):
        return {"vispMode": mode, "modeConfig": report.mode_config(mode), "effectiveSettings": effective}

    def test_a_run_that_ran_as_named_has_no_problem(self):
        arm = self.arm("lean+nocritic", {"critic.mode": "off", "workflow.draftFirst": "visual",
                                         "workflow.reviewCadence": "feature", "workflow.requestGaps": "required"})
        self.assertEqual(report.arm_config_problems(self.NOCRITIC, arm), [])

    def test_a_run_whose_critic_stayed_on_is_refused(self):
        arm = self.arm("lean+nocritic", {"critic.mode": "auto", "workflow.draftFirst": "visual",
                                         "workflow.reviewCadence": "feature", "workflow.requestGaps": "required"})
        problems = report.arm_config_problems(self.NOCRITIC, arm)
        self.assertEqual(len(problems), 1)
        self.assertIn("critic.mode = 'auto'", problems[0])

    def test_a_run_set_up_with_another_mode_than_its_arm_is_refused(self):
        arm = self.arm("lean", None)
        problems = report.arm_config_problems(self.NOCRITIC, arm)
        self.assertEqual(len(problems), 1)
        self.assertIn("arm.json modes set", problems[0])

    def test_without_what_visp_reported_only_the_recorded_keys_are_checked(self):
        self.assertEqual(report.arm_config_problems(self.NOCRITIC, self.arm("lean+nocritic", None)), [])

    def test_runs_from_before_the_record_and_other_arms_are_not_checked(self):
        self.assertEqual(report.arm_config_problems(self.NOCRITIC, {"preset": "quality-2026-10"}), [])
        self.assertEqual(report.arm_config_problems(entry("bare", "bare"), self.arm(None, None)), [])


class MixedPresets(unittest.TestCase):
    def test_a_run_made_under_another_preset_is_still_refused(self):
        original = report.RUNS
        with tempfile.TemporaryDirectory() as tmp:
            report.RUNS = pathlib.Path(tmp)
            directory = report.RUNS / "runs" / "b2-t-develop-1"
            directory.mkdir(parents=True)
            (directory / "arm.json").write_text('{"preset": "default"}')
            try:
                manifest = {**MANIFEST, "settings": {**MANIFEST["settings"], "judge": {"model": "j", "effort": "high"},
                                                     "codeJudge": {"model": "c", "effort": "high"}}}
                with self.assertRaises(SystemExit) as raised:
                    report.check_presets(manifest, [entry("visp:develop", "develop")])
                self.assertIn("arm.json preset 'default'", str(raised.exception))
            finally:
                report.RUNS = original


if __name__ == "__main__":
    unittest.main()
