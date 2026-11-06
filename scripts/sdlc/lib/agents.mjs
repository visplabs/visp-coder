// The SDLC's stage agents (.claude/agents/), which of them work on one task, and which report
// type each hands back.

export const CODERS = new Set(["coder"]);

export const TASK_REPORTS = {
  coder: "handoff",
  reviewer: "review",
  "reviewer-fallback": "review",
  "qe-verify": "qe-report",
};

// The agent that turns the owner's words into the spec; it works on a feature, not a task.
export const SPEC_AGENT = "qe-spec";

// The lines the manager puts in an agent's prompt; hooks find the work through them.
export const TASK_LINE = /SDLC-Task: ([A-Z][A-Z0-9]*-\d+)\/([A-Z][A-Z0-9]*-\d+)/;
export const FEATURE_LINE = /SDLC-Feature: ([A-Z][A-Z0-9]*-\d+)/;
