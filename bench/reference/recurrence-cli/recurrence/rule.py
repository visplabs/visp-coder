"""Parse EXPAND commands and recurrence rules into validated values."""
import datetime
import re
from dataclasses import dataclass, field

WEEKDAYS = ("MO", "TU", "WE", "TH", "FR", "SA", "SU")
FREQUENCIES = ("DAILY", "WEEKLY", "MONTHLY", "YEARLY")
DEFAULT_LIMIT = 20
MAX_LIMIT = 1000

_DATETIME = re.compile(r"([0-9]{4})([0-9]{2})([0-9]{2})[Tt]([0-9]{2})([0-9]{2})([0-9]{2})")
_UNSIGNED = re.compile(r"[0-9]+")
_SIGNED = re.compile(r"[+-]?[0-9]+")
_WEEKDAY = re.compile(r"(?:([+-]?)([0-9]+))?(MO|TU|WE|TH|FR|SA|SU)")


class InvalidInput(ValueError):
    """Raised for any command that must print ERROR."""


@dataclass
class Rule:
    freq: str
    interval: int = 1
    count: int | None = None
    until: datetime.datetime | None = None
    bymonth: set[int] = field(default_factory=set)
    bymonthday: set[int] = field(default_factory=set)
    byday: set[int] = field(default_factory=set)             # weekdays, 0 = Monday
    bynthday: set[tuple[int, int]] = field(default_factory=set)  # (weekday, ordinal)
    byhour: set[int] = field(default_factory=set)
    bysetpos: set[int] = field(default_factory=set)
    wkst: int = 0
    exdates: set[datetime.datetime] = field(default_factory=set)


@dataclass
class Command:
    start: datetime.datetime
    rule: Rule
    limit: int


def parse_command(line):
    words = line.split()
    if not words or words[0].upper() != "EXPAND" or len(words) not in (3, 4):
        raise InvalidInput(line)
    limit = DEFAULT_LIMIT if len(words) == 3 else _number(words[3], 1, MAX_LIMIT)
    return Command(parse_datetime(words[1]), parse_rule(words[2]), limit)


def parse_datetime(text):
    match = _DATETIME.fullmatch(text)
    if not match:
        raise InvalidInput(text)
    try:
        return datetime.datetime(*(int(part) for part in match.groups()))
    except ValueError as error:
        raise InvalidInput(text) from error


def parse_rule(text):
    parts = {}
    for part in text.split(";"):
        name, separator, value = part.partition("=")
        name = name.upper()
        if not separator or not value or name not in _PARSERS or name in parts:
            raise InvalidInput(text)
        parts[name] = value
    if "FREQ" not in parts:
        raise InvalidInput(text)
    rule = Rule(freq=_frequency(parts.pop("FREQ")))
    for name, value in parts.items():
        _PARSERS[name](rule, value)
    _check_combinations(rule, parts)
    return rule


def _check_combinations(rule, parts):
    if rule.count is not None and rule.until is not None:
        raise InvalidInput("COUNT with UNTIL")
    if rule.bynthday and rule.freq in ("DAILY", "WEEKLY"):
        raise InvalidInput("BYDAY ordinal needs MONTHLY or YEARLY")
    if "BYMONTHDAY" in parts and rule.freq == "WEEKLY":
        raise InvalidInput("BYMONTHDAY with WEEKLY")
    if rule.bysetpos:
        if rule.freq in ("DAILY", "WEEKLY"):
            raise InvalidInput("BYSETPOS needs MONTHLY or YEARLY")
        if not {"BYMONTH", "BYMONTHDAY", "BYDAY", "BYHOUR"} & parts.keys():
            raise InvalidInput("BYSETPOS without another BY part")


def _items(value):
    items = value.split(",")
    if any(not item for item in items):
        raise InvalidInput(value)
    return items


def _number(text, low, high=None, signed=False):
    """A whole number whose size (absolute value when signed) is from low to high."""
    if not (_SIGNED if signed else _UNSIGNED).fullmatch(text):
        raise InvalidInput(text)
    number = int(text)
    if abs(number) < low or (high is not None and abs(number) > high):
        raise InvalidInput(text)
    return number


def _frequency(value):
    if value.upper() not in FREQUENCIES:
        raise InvalidInput(value)
    return value.upper()


def _weekday(value):
    if value.upper() not in WEEKDAYS:
        raise InvalidInput(value)
    return WEEKDAYS.index(value.upper())


def _set_interval(rule, value):
    rule.interval = _number(value, 1)


def _set_count(rule, value):
    rule.count = _number(value, 1)


def _set_until(rule, value):
    rule.until = parse_datetime(value)


def _set_bymonth(rule, value):
    rule.bymonth = {_number(item, 1, 12) for item in _items(value)}


def _set_bymonthday(rule, value):
    rule.bymonthday = {_number(item, 1, 31, signed=True) for item in _items(value)}


def _set_byhour(rule, value):
    rule.byhour = {_number(item, 0, 23) for item in _items(value)}


def _set_bysetpos(rule, value):
    rule.bysetpos = {_number(item, 1, 366, signed=True) for item in _items(value)}


def _set_wkst(rule, value):
    rule.wkst = _weekday(value)


def _set_exdate(rule, value):
    rule.exdates = {parse_datetime(item) for item in _items(value)}


def _set_byday(rule, value):
    for item in _items(value):
        match = _WEEKDAY.fullmatch(item.upper())
        if not match:
            raise InvalidInput(item)
        sign, digits, code = match.groups()
        if digits is None:
            if sign:
                raise InvalidInput(item)
            rule.byday.add(WEEKDAYS.index(code))
        else:
            ordinal = _number(digits, 1, 53)
            rule.bynthday.add((WEEKDAYS.index(code), -ordinal if sign == "-" else ordinal))
    if rule.byday and rule.bynthday:
        raise InvalidInput("BYDAY mixes ordinals and plain weekdays")


_PARSERS = {
    "FREQ": None, "INTERVAL": _set_interval, "COUNT": _set_count, "UNTIL": _set_until,
    "BYMONTH": _set_bymonth, "BYMONTHDAY": _set_bymonthday, "BYDAY": _set_byday,
    "BYHOUR": _set_byhour, "BYSETPOS": _set_bysetpos, "WKST": _set_wkst, "EXDATE": _set_exdate,
}
