"""Append one claude -p JSON result's cost and usage to a JSONL log (used by claude_shim/claude).

Usage: record_call.py <log> <claude argv...>   (the CLI's JSON output on stdin)
The role is `worker` for the bench's own worker session (bypassPermissions, or auto for a scope +auto
arm) and `critic` for a call VISP launches (its reviewer or tester, in dontAsk).
"""
import json
import sys
import time

log, argv = sys.argv[1], sys.argv[2:]
try:
    result = json.loads(sys.stdin.read())
except ValueError:
    result = {}
model = argv[argv.index("--model") + 1] if "--model" in argv[:-1] else None
mode = argv[argv.index("--permission-mode") + 1] if "--permission-mode" in argv[:-1] else None
role = "worker" if mode in ("bypassPermissions", "auto") else "critic"
entry = {"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "role": role, "model": model,
         "cost": result.get("total_cost_usd"), "durationMs": result.get("duration_ms"),
         "turns": result.get("num_turns"), "isError": result.get("is_error"), "usage": result.get("usage")}
with open(log, "a") as handle:
    handle.write(json.dumps(entry) + "\n")
