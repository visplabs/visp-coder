"""Unit tests for the VISP arm modes: the mode-to-config mapping, visp.yml editing and arm names.

Run from the repository root: python3 -m unittest bench/test_presets.py
No models are called and no benchmark runs are read.
"""
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import presets  # noqa: E402

INIT = """# visp configuration.

# Critic defaults to auto.
critic:
  harness: claude-code
  # enabled: false

profile: minimal

workflow:
  # Default until a policy is recorded.
  strictness: standard

  maxChangedFiles: 40

graph:
  languages:
    - python
"""


class ModeConfig(unittest.TestCase):
    def test_no_mode_sets_nothing(self):
        self.assertEqual(presets.mode_config(None), {})
        self.assertEqual(presets.mode_config(""), {})

    def test_existing_modes_keep_their_workflow_keys(self):
        self.assertEqual(presets.mode_config("lean"), {
            "workflow.draftFirst": "visual", "workflow.reviewCadence": "feature",
            "workflow.requestGaps": "required"})
        self.assertEqual(presets.mode_config("gate"), {"workflow.regressionGate": "gate"})

    def test_a_mode_can_set_a_key_outside_workflow(self):
        self.assertEqual(presets.mode_config("nocritic"), {"critic.mode": "off"})

    def test_modes_combine_and_the_default_lean_keys_stay_equal(self):
        self.assertEqual(presets.mode_config("lean+nocritic"),
                         {**presets.mode_config("lean"), "critic.mode": "off"})

    def test_unknown_repeated_and_clashing_modes_stop(self):
        with self.assertRaises(SystemExit):
            presets.mode_config("lean+nonsense")
        with self.assertRaises(SystemExit):
            presets.mode_config("lean+lean")
        original = presets.VISP_MODES
        presets.VISP_MODES = {"a": {"critic.mode": "off"}, "b": {"critic.mode": "auto"}}
        try:
            with self.assertRaises(SystemExit):
                presets.mode_config("a+b")
        finally:
            presets.VISP_MODES = original

    def test_visp_build_splits_the_build_from_the_modes(self):
        self.assertEqual(presets.visp_build("visp:develop"), ("develop", None))
        self.assertEqual(presets.visp_build("visp:cand+lean"), ("cand", "lean"))
        self.assertEqual(presets.visp_build("visp-codex:cand+lean+nocritic"), ("cand", "lean+nocritic"))
        with self.assertRaises(SystemExit):
            presets.visp_build("visp:cand+nope")


class ConfigYaml(unittest.TestCase):
    def test_no_mode_leaves_the_file_alone(self):
        self.assertEqual(presets.config_yaml(INIT, None), INIT)

    def test_workflow_keys_go_first_in_their_block_in_order(self):
        text = presets.config_yaml(INIT, "lean")
        self.assertIn("workflow:\n  draftFirst: visual\n  reviewCadence: feature\n  requestGaps: required\n"
                      "  # Default until a policy is recorded.\n  strictness: standard\n", text)
        self.assertIn("  maxChangedFiles: 40\n", text)

    def test_a_critic_key_lands_in_the_critic_block_and_nowhere_else(self):
        text = presets.config_yaml(INIT, "nocritic")
        self.assertIn("critic:\n  mode: off\n  harness: claude-code\n  # enabled: false\n", text)
        self.assertEqual(text.count("mode: off"), 1)
        self.assertEqual(text.replace("  mode: off\n", "", 1), INIT)

    def test_a_key_the_file_already_sets_is_replaced_not_repeated(self):
        config = INIT.replace("critic:\n", "critic:\n  mode: auto\n", 1)
        text = presets.config_yaml(config, "nocritic")
        self.assertIn("critic:\n  mode: off\n", text)
        self.assertNotIn("mode: auto", text)

    def test_a_missing_section_is_appended(self):
        text = presets.config_yaml("profile: minimal\n", "nocritic")
        self.assertTrue(text.endswith("critic:\n  mode: off"), text)

    def test_the_default_arm_and_the_nocritic_arm_differ_only_in_the_critic_mode(self):
        lean, nocritic = presets.config_yaml(INIT, "lean"), presets.config_yaml(INIT, "lean+nocritic")
        self.assertEqual(nocritic.replace("  mode: off\n", "", 1), lean)

    def test_a_preset_critic_block_still_takes_the_key(self):
        config = INIT.replace("critic:\n  harness: claude-code", presets.critic_yaml(presets.PRESETS["quality-2026-10"]["critic"]))
        text = presets.config_yaml(config, "lean+nocritic")
        self.assertIn("critic:\n  mode: off\n  harness: claude-code\n  launch: claude-exec\n", text)


class NoRecall(unittest.TestCase):
    def test_the_mode_sets_memory_recall_false(self):
        self.assertEqual(presets.mode_config("norecall"), {"memory.recall": False})
        self.assertEqual(presets.mode_config("lean+norecall")["memory.recall"], False)

    def test_the_key_is_a_real_visp_config_key(self):
        schema = (pathlib.Path(__file__).resolve().parents[1] / "src" / "config" / "schema.ts").read_text()
        block = schema[schema.index("const memorySchema"):]
        self.assertIn("recall: z.boolean()", block[:block.index(".default({})")])

    def test_it_lands_in_the_memory_block_as_a_lowercase_boolean(self):
        config = "memory:\n  # Earlier-request recall.\n  enabled: true\n\ntelemetry:\n  enabled: true\n"
        text = presets.config_yaml(config, "norecall")
        self.assertIn("memory:\n  recall: false\n  # Earlier-request recall.\n  enabled: true\n", text)
        self.assertEqual(text.count("recall: false"), 1)

    def test_a_recall_key_already_set_is_replaced(self):
        text = presets.config_yaml("memory:\n  recall: true\n", "norecall")
        self.assertIn("memory:\n  recall: false", text)
        self.assertNotIn("recall: true", text)

    def test_the_arm_label_and_title(self):
        self.assertEqual(presets.visp_build("visp:develop+norecall"), ("develop", "norecall"))
        self.assertEqual(presets.arm_title("visp:develop+norecall"), "visp:develop+norecall")
        self.assertEqual(presets.mode_difference(None, "norecall"), {"memory.recall": (None, False)})


class ArmNames(unittest.TestCase):
    def test_titles_spell_build_and_modes(self):
        self.assertEqual(presets.arm_title("bare"), "bare")
        self.assertEqual(presets.arm_title("visp:develop"), "visp:develop")
        self.assertEqual(presets.arm_title("visp:cand+lean+nocritic"), "visp:cand+lean+nocritic")
        self.assertEqual(presets.arm_title("visp-codex:cand+gate"), "visp-codex:cand+gate")

    def test_difference_lists_only_keys_the_modes_set_differently(self):
        self.assertEqual(presets.mode_difference("lean", "lean+nocritic"), {"critic.mode": (None, "off")})
        self.assertEqual(presets.mode_difference("lean", "lean"), {})
        self.assertEqual(presets.mode_difference(None, "gate"), {"workflow.regressionGate": (None, "gate")})

    def test_arm_record_keeps_the_keys_and_what_visp_reported(self):
        record = presets.arm_record("lean+nocritic", {"critic.mode": "off"})
        self.assertEqual(record["vispMode"], "lean+nocritic")
        self.assertEqual(record["modeConfig"]["critic.mode"], "off")
        self.assertEqual(record["effectiveSettings"], {"critic.mode": "off"})
        self.assertEqual(presets.arm_record(None, None),
                         {"vispMode": None, "modeConfig": {}, "effectiveSettings": None})


if __name__ == "__main__":
    unittest.main()
