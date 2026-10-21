import os
import subprocess
import unittest

from recurrence.cli import respond

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class ExpandTest(unittest.TestCase):
    def test_skipped_dates_are_not_clamped(self):
        self.assertEqual(respond("EXPAND 20260131T090000 FREQ=MONTHLY;COUNT=3"),
                         "2026-01-31T09:00:00 2026-03-31T09:00:00 2026-05-31T09:00:00")

    def test_start_is_not_forced(self):
        self.assertEqual(respond("EXPAND 20260107T090000 FREQ=WEEKLY;BYDAY=TU;COUNT=1"), "2026-01-13T09:00:00")

    def test_setpos_counts_the_whole_period(self):
        self.assertEqual(respond("EXPAND 20260115T090000 FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1;COUNT=1"),
                         "2026-02-02T09:00:00")

    def test_week_start_changes_biweekly_weeks(self):
        rule = "FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST="
        self.assertEqual(respond(f"EXPAND 19970805T090000 {rule}SU").split()[1], "1997-08-17T09:00:00")
        self.assertEqual(respond(f"EXPAND 19970805T090000 {rule}MO").split()[1], "1997-08-10T09:00:00")

    def test_exdate_counts_toward_count(self):
        self.assertEqual(respond("EXPAND 20260101T090000 FREQ=DAILY;COUNT=2;EXDATE=20260101T090000"),
                         "2026-01-02T09:00:00")

    def test_never_matching_rule_ends_at_year_9999(self):
        self.assertEqual(respond("EXPAND 20260101T090000 FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30"), "")

    def test_invalid_input(self):
        for line in ("EXPAND 20260230T090000 FREQ=DAILY", "EXPAND 20260101T090000 FREQ=DAILY;COUNT=1;UNTIL=20260102T000000",
                     "EXPAND 20260101T090000 FREQ=WEEKLY;BYDAY=1MO", "EXPAND 20260101T090000 FREQ=MONTHLY;BYSETPOS=1",
                     "EXPAND 20260101T090000 FREQ=DAILY 0", "LIST"):
            with self.subTest(line=line):
                self.assertEqual(respond(line), "ERROR")

    def test_cli_skips_blank_lines(self):
        completed = subprocess.run([os.path.join(ROOT, "run.sh")], input="\nEXPAND 20260101T090000 FREQ=DAILY 2\n",
                                   capture_output=True, text=True, timeout=30)
        self.assertEqual(completed.stdout, "2026-01-01T09:00:00 2026-01-02T09:00:00\n")


if __name__ == "__main__":
    unittest.main()
