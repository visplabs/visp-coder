"""Expand a parsed rule into its occurrences, following python-dateutil's rrule semantics."""
import calendar
import dataclasses
import datetime
from itertools import groupby, islice

LAST_ORDINAL = datetime.date.max.toordinal()  # 9999-12-31: the expansion ends there


def expand(command):
    """The first command.limit occurrences that EXDATE does not remove."""
    exdates = command.rule.exdates
    kept = (moment for moment in occurrences(command.start, command.rule) if moment not in exdates)
    return list(islice(kept, command.limit))


def occurrences(start, rule):
    """The rule's occurrences in ascending order, counted by COUNT before EXDATE applies."""
    rule = with_defaults(start, rule)
    times = [datetime.time(hour, start.minute, start.second) for hour in sorted(rule.byhour or {start.hour})]
    produced = 0
    for days in periods(start.date(), rule):
        candidates = [datetime.datetime.combine(day, time) for day in candidate_days(days, rule) for time in times]
        if rule.bysetpos:
            candidates = select_positions(candidates, rule.bysetpos)
        for moment in candidates:
            if moment < start:
                continue
            if rule.until is not None and moment > rule.until:
                return
            yield moment
            produced += 1
            if produced == rule.count:
                return


def with_defaults(start, rule):
    """Fill BYMONTHDAY, BYMONTH or BYDAY from the start when the rule has neither day part."""
    if rule.bymonthday or rule.byday or rule.bynthday:
        return rule
    if rule.freq == "YEARLY":
        return dataclasses.replace(rule, bymonthday={start.day}, bymonth=rule.bymonth or {start.month})
    if rule.freq == "MONTHLY":
        return dataclasses.replace(rule, bymonthday={start.day})
    if rule.freq == "WEEKLY":
        return dataclasses.replace(rule, byday={start.weekday()})
    return rule


def periods(start, rule):
    """For each period from the start's, every INTERVAL-th, the list of its days."""
    if rule.freq == "DAILY":
        for ordinal in range(start.toordinal(), LAST_ORDINAL + 1, rule.interval):
            yield [datetime.date.fromordinal(ordinal)]
    elif rule.freq == "WEEKLY":
        week = start.toordinal() - (start.weekday() - rule.wkst) % 7
        for first in range(week, LAST_ORDINAL + 1, 7 * rule.interval):
            yield [datetime.date.fromordinal(o) for o in range(max(first, 1), min(first + 7, LAST_ORDINAL + 1))]
    elif rule.freq == "MONTHLY":
        for index in range(start.year * 12 + start.month - 1, 10000 * 12, rule.interval):
            year, month = divmod(index, 12)
            yield month_days(year, month + 1) if not rule.bymonth or month + 1 in rule.bymonth else []
    else:
        for year in range(start.year, 10000, rule.interval):
            yield [day for month in sorted(rule.bymonth or range(1, 13)) for day in month_days(year, month)]


def month_days(year, month):
    return [datetime.date(year, month, day) for day in range(1, calendar.monthrange(year, month)[1] + 1)]


def candidate_days(days, rule):
    nth = nth_weekdays(days, rule) if rule.bynthday else None
    return [day for day in days if matches(day, rule) and (nth is None or day in nth)]


def matches(day, rule):
    """Whether the day passes BYMONTH, BYMONTHDAY and plain BYDAY."""
    if rule.bymonth and day.month not in rule.bymonth:
        return False
    if rule.bymonthday:
        from_end = day.day - calendar.monthrange(day.year, day.month)[1] - 1
        if day.day not in rule.bymonthday and from_end not in rule.bymonthday:
            return False
    return not rule.byday or day.weekday() in rule.byday


def nth_weekdays(days, rule):
    """The days that are a listed n-th weekday of their month (MONTHLY, or YEARLY with BYMONTH) or year."""
    if rule.freq == "MONTHLY" or rule.bymonth:
        scopes = [list(group) for _, group in groupby(days, key=lambda day: day.month)]
    else:
        scopes = [days]
    chosen = set()
    for scope in scopes:
        for weekday, ordinal in rule.bynthday:
            same = [day for day in scope if day.weekday() == weekday]
            if abs(ordinal) <= len(same):
                chosen.add(same[ordinal - 1 if ordinal > 0 else ordinal])
    return chosen


def select_positions(candidates, positions):
    """BYSETPOS over one period's sorted candidates; out-of-range positions select nothing."""
    size = len(candidates)
    picked = {candidates[p - 1 if p > 0 else p] for p in positions if abs(p) <= size}
    return sorted(picked)
