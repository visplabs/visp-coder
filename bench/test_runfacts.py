"""Unit tests for runfacts.py's count of VISP hook refusals in a worker transcript.

Run from the repository root: python3 -m unittest bench/test_runfacts.py
The fixtures under bench/fixtures/refusals are the refusal events of three real B2 transcripts
(b2-lighthouse-pixel-develop-1, b2-spreadsheet-extend-develop-2, b2-spreadsheet-extend-candidate-5),
cut to those events and one ordinary failed command (JSON lines, named .txt because *.jsonl is ignored). No models are called.
"""
import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import runfacts  # noqa: E402

FIXTURES = pathlib.Path(__file__).resolve().parent / "fixtures" / "refusals"


def result(text, call):
    block = {"type": "tool_result", "content": text, "is_error": True, "tool_use_id": call}
    return {"type": "user", "message": {"role": "user", "content": [block]}, "toolUseResult": f"Error: {text}"}


class HookRefusalTests(unittest.TestCase):
    def count(self, name):
        return runfacts.hook_refusals([FIXTURES / name])

    def test_a_background_done_is_counted_apart_from_edits(self):
        self.assertEqual(self.count("develop-lighthouse-1.transcript.txt"), {"edit": 0, "done": 1, "other": 0})

    def test_a_transcript_with_both_kinds_counts_each_once_despite_replayed_requests(self):
        self.assertEqual(self.count("develop-spreadsheet-2.transcript.txt"), {"edit": 2, "done": 1, "other": 0})

    def test_a_refused_edit_with_no_task_authorized_is_counted(self):
        self.assertEqual(self.count("candidate-spreadsheet-5.transcript.txt"), {"edit": 1, "done": 0, "other": 0})

    def test_other_refusals_repeated_results_and_ordinary_errors(self):
        state = "PreToolUse:Write hook error: .visp/x.json is VISP state; change it only through `visp` commands."
        events = [
            result(state, "a"),
            result(state, "a"),
            result("PreToolUse:Bash hook error: Run `visp accept` again with the same arguments, by itself", "b"),
            result("PreToolUse:Bash hook error: This command would discard uncommitted changes to a.txt.", "c"),
            result("Exit code 1\nthe words hook error in an ordinary failure", "d"),
        ]
        with tempfile.TemporaryDirectory() as root:
            path = pathlib.Path(root) / "t.transcript.txt"
            path.write_text("\n".join(json.dumps(event) for event in events))
            self.assertEqual(runfacts.hook_refusals([path]), {"edit": 1, "done": 0, "other": 2})

    def test_timing_reports_the_split_and_the_total(self):
        split = runfacts.timing([FIXTURES / "develop-spreadsheet-2.transcript.txt"])
        self.assertEqual((split["refusals"], split["editRefusals"], split["doneRefusals"], split["otherRefusals"]),
                         (3, 2, 1, 0))


if __name__ == "__main__":
    unittest.main()
