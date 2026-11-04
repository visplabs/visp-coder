// The SDLC's stage agents (.claude/agents/), which of them work on one task, and which report
// type each hands back.

export const CODERS = new Set(["coder-s", "coder-m", "coder-l"]);

export const TASK_REPORTS = {
  "coder-s": "handoff",
  "coder-m": "handoff",
  "coder-l": "handoff",
  reviewer: "review",
  "qe-verify": "qe-report",
};

// The line the manager puts in a task agent's prompt; hooks find the task through it.
export const TASK_LINE = /SDLC-Task: (F-\d+)\/(T-\d+)/;
