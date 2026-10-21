Build a command-line tool that expands recurrence rules into date-times. The rules are a subset of the RRULE format of the iCalendar standard (RFC 5545), with the semantics stated below.

Contract (follow it exactly; it will be tested by piping commands to your program):

- Start command: `./run.sh` reads commands from standard input, one per line, and writes exactly one output line for every command. Blank lines (empty or only spaces) are ignored and print nothing.
- Use only the standard library of Python 3.10. Do not use `dateutil` (python-dateutil), `arrow`, `pendulum`, `pytz` or any other third-party package, even if one is installed. No file in the project may import one, tests included.
- The only command is `EXPAND <start> <rule>` or `EXPAND <start> <rule> <limit>`. Arguments are separated by one or more spaces.
- Keywords are case-insensitive: the command name, part names, `FREQ` values and weekday codes. So `expand 20260105t090000 freq=weekly;byday=mo` is valid.
- Any invalid command prints `ERROR` on its line. The rules for invalid input are listed at the end.

## Dates and output

- `<start>` and every other date-time in a command are written `YYYYMMDDTHHMMSS`, for example `20260131T090000`: a 4-digit year, then 2 digits each for month, day, hour (`00`-`23`), minute and second (`00`-`59`), with the `T` in either case. It must be a real calendar date (`20260230T090000` is invalid).
- Times are plain local times: no time zones and no daylight saving.
- `<limit>` is a whole number from 1 to 1000. Without it the limit is 20.
- Output: the first occurrences in ascending order, at most `<limit>` of them, each written `YYYY-MM-DDTHH:MM:SS`, separated by single spaces, on one line. A rule with no occurrences prints an empty line.
- Example: `EXPAND 20260131T090000 FREQ=MONTHLY;COUNT=3` prints `2026-01-31T09:00:00 2026-03-31T09:00:00 2026-05-31T09:00:00`.

## Rules

`<rule>` is one or more parts `NAME=VALUE` separated by `;`, with no spaces. A list value is separated by commas. `FREQ` is required. Each part name may appear at most once. A value repeated within one list counts once.

| Part | Value |
| --- | --- |
| `FREQ` | `DAILY`, `WEEKLY`, `MONTHLY` or `YEARLY` |
| `INTERVAL` | a whole number of at least 1; the default is 1 |
| `COUNT` | a whole number of at least 1: the rule has at most COUNT occurrences |
| `UNTIL` | a date-time: no occurrence is later than it. An occurrence exactly at UNTIL is included. An UNTIL earlier than the start gives no occurrences |
| `BYMONTH` | list of months `1` to `12` |
| `BYMONTHDAY` | list of days `1` to `31` or `-31` to `-1`. `-1` is the last day of the month, `-2` the day before it, and so on |
| `BYDAY` | list of weekdays `MO`, `TU`, `WE`, `TH`, `FR`, `SA`, `SU`, each optionally preceded by an ordinal: an optional `+` or `-` and a number from `1` to `53`, for example `2TU`, `-1FR`, `+3MO` |
| `BYHOUR` | list of hours `0` to `23` |
| `BYSETPOS` | list of positions `1` to `366` or `-366` to `-1` |
| `WKST` | the weekday a week starts on, without an ordinal; the default is `MO` |
| `EXDATE` | list of date-times to leave out |

Numbers are written in decimal digits. Only BYMONTHDAY values, BYSETPOS values and BYDAY ordinals may have a sign (`+` or `-`).

## How occurrences are found

This is how python-dateutil's `rrule` and `rruleset` behave. Follow these steps exactly.

1. Defaults. When the rule has neither BYMONTHDAY nor BYDAY:
   - YEARLY: BYMONTHDAY is the start's day of the month, and BYMONTH is the start's month unless the rule gives BYMONTH.
   - MONTHLY: BYMONTHDAY is the start's day of the month.
   - WEEKLY: BYDAY is the start's weekday.
   - DAILY: nothing is added.
   - In every case, the hours are the BYHOUR values, or the start's hour without BYHOUR. The minute and second are always the start's.
2. Periods. A DAILY rule walks days, a WEEKLY rule weeks (a week starts on WKST), a MONTHLY rule calendar months and a YEARLY rule calendar years. The first period is the one that contains the start; after it comes every INTERVAL-th period. So with `FREQ=WEEKLY;INTERVAL=2`, the weeks used are the start's week, the week two weeks later, and so on, and WKST decides where those weeks begin.
3. Candidates. In each period, a day is a candidate day when it matches every one of BYMONTH, BYMONTHDAY and BYDAY that the rule has (after the defaults):
   - BYMONTH: its month is in the list.
   - BYMONTHDAY: it matches at least one value; a negative value counts back from the end of that day's month.
   - BYDAY without ordinals: its weekday is in the list.
   - BYDAY with ordinals: it is one of the listed n-th weekdays, `-n` counting from the end. For MONTHLY, n counts within the month. For YEARLY, n counts within each month of BYMONTH when the rule has BYMONTH, and within the whole year otherwise. So `FREQ=YEARLY;BYDAY=20MO` is the 20th Monday of the year, and `FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU` the last Sunday of October.
   - Days that do not exist are never candidates and are never moved to another day: `BYMONTHDAY=31` matches nothing in a 30-day month, and February 29 exists only in leap years. An n-th weekday that the month or year does not have matches nothing.
   - Each candidate day gives one candidate date-time at each hour from step 1, with the start's minute and second.
4. BYSETPOS. With BYSETPOS, sort the candidates of each period and keep only those at the listed positions: `1` is the first, `-1` the last, and a position beyond the number of candidates selects nothing. Positions count every candidate of the period, including candidates earlier than the start.
5. Start. Candidates earlier than the start are dropped. The start itself is an occurrence only if it is a candidate; it is never added otherwise (RFC 5545 says otherwise; follow this rule).
6. COUNT and UNTIL. The rule's occurrences are the remaining candidates in ascending order. They end after COUNT occurrences, or before the first candidate later than UNTIL.
7. EXDATE. Occurrences equal to an EXDATE date-time are then removed. Removed occurrences still count toward COUNT: `FREQ=DAILY;COUNT=3` with one matching EXDATE prints two occurrences. An EXDATE that matches no occurrence changes nothing.
8. Limit. The limit applies last, to the occurrences left after EXDATE.
9. Year 9999. The expansion ends with the year 9999; no occurrence is later than `9999-12-31T23:59:59`. A rule that has no further occurrences before then simply ends, so a rule that never matches prints an empty line.

## Invalid input

Each of these prints `ERROR`:

- A line whose first word is not `EXPAND`, or an `EXPAND` with fewer than two or more than three arguments.
- A start, UNTIL or EXDATE date-time not in the form above or not a real date and time.
- A limit that is not a whole number from 1 to 1000.
- A rule part without `=`, an empty part (for example a trailing `;`), an empty value or an empty list item, an unknown part name, a part name given twice, or no `FREQ`.
- A FREQ, WKST or weekday code not in the lists above, or any number out of its range above: INTERVAL or COUNT `0`, BYMONTH `13`, BYMONTHDAY `0` or `32`, BYHOUR `24`, BYSETPOS `0` or `367`, a BYDAY ordinal `0` or `54`, and a sign where none is allowed.
- Both COUNT and UNTIL.
- A BYDAY ordinal with DAILY or WEEKLY.
- A BYDAY list that mixes entries with and without ordinals, for example `BYDAY=1MO,FR`.
- BYMONTHDAY with WEEKLY.
- BYSETPOS with DAILY or WEEKLY, or BYSETPOS in a rule that gives none of BYMONTH, BYMONTHDAY, BYDAY and BYHOUR (defaults from step 1 do not count).

Include a README with run instructions and your own automated tests.
