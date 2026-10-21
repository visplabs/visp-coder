"""Check hidden_test.py's expected lines against python-dateutil (pip install python-dateutil).

Usage: make_expected.py [--print]. Every expected line other than ERROR must equal dateutil's
rruleset output for its command; ERROR lines are written by hand from task.md. --print shows
dateutil's output for every case, to paste into a new case.
"""
import datetime
import re
import sys
from itertools import islice

from dateutil import rrule

from hidden_test import CASES

FREQS = {"DAILY": rrule.DAILY, "WEEKLY": rrule.WEEKLY, "MONTHLY": rrule.MONTHLY, "YEARLY": rrule.YEARLY}
DAYS = ("MO", "TU", "WE", "TH", "FR", "SA", "SU")


def moment(text):
    return datetime.datetime.strptime(text.upper(), "%Y%m%dT%H%M%S")


def weekday(text):
    ordinal, code = re.fullmatch(r"([+-]?\d+)?([A-Z]{2})", text).groups()
    return rrule.weekday(DAYS.index(code), int(ordinal) if ordinal else None)


def oracle(command):
    """dateutil's output line for a valid EXPAND command."""
    words = command.split()
    options, exdates = {}, []
    for part in words[2].upper().split(";"):
        name, value = part.split("=", 1)
        items = value.split(",")
        if name == "FREQ":
            options["freq"] = FREQS[value]
        elif name in ("INTERVAL", "COUNT"):
            options[name.lower()] = int(value)
        elif name == "UNTIL":
            options["until"] = moment(value)
        elif name in ("BYMONTH", "BYMONTHDAY", "BYHOUR", "BYSETPOS"):
            options[name.lower()] = [int(item) for item in items]
        elif name == "BYDAY":
            options["byweekday"] = [weekday(item) for item in items]
        elif name == "WKST":
            options["wkst"] = DAYS.index(value)
        elif name == "EXDATE":
            exdates = [moment(item) for item in items]
    rules = rrule.rruleset()
    rules.rrule(rrule.rrule(dtstart=moment(words[1]), **options))
    for exdate in exdates:
        rules.exdate(exdate)
    limit = int(words[3]) if len(words) > 3 else 20
    return " ".join(occurrence.isoformat() for occurrence in islice(rules, limit))


def main():
    mismatches = 0
    for name, commands, expected in CASES:
        commands = [command for command in commands if command.strip()]
        assert len(commands) == len(expected), name
        computed = [line if line == "ERROR" else oracle(command) for command, line in zip(commands, expected)]
        if computed != expected:
            mismatches += 1
            print(f"MISMATCH {name}: {computed}")
        elif "--print" in sys.argv:
            print(f"{name}: {computed}")
    print(f"{len(CASES)} cases, {mismatches} mismatches")
    sys.exit(1 if mismatches else 0)


if __name__ == "__main__":
    main()
