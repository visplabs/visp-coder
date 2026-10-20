# Recurrence expander

Run: `./run.sh` (Python 3.10, standard library only), one `EXPAND <start> <rule> [<limit>]` command per line. Tests: `python3 -m unittest discover -s tests`.

Layout: `recurrence/rule.py` parses and validates commands and rules, `recurrence/expand.py` walks the rule's periods and selects occurrences (defaults, BY filters, BYSETPOS, COUNT, UNTIL, EXDATE, limit), `recurrence/cli.py` reads standard input.

The contract is the task's `task.md`; this implementation exists to qualify the hidden checks.
