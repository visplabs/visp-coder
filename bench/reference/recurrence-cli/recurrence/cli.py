"""Read EXPAND commands from standard input and print one line per command."""
import sys

from .expand import expand
from .rule import InvalidInput, parse_command


def respond(line):
    try:
        command = parse_command(line)
    except InvalidInput:
        return "ERROR"
    return " ".join(moment.isoformat() for moment in expand(command))


def main():
    for line in sys.stdin:
        if line.strip():
            print(respond(line), flush=True)


if __name__ == "__main__":
    main()
