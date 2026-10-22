import { expect, it } from "vitest";
import {
  renderAgentGuide,
  renderMinimalGuide,
  SLASH_COMMANDS,
} from "../../../src/harness/instructions.js";

it("keeps the verbatim request in full, minimal and shortcut feature guidance", () => {
  expect(renderAgentGuide()).toContain(
    'visp feature "<goal>" --check "<test command>" --source-brief -',
  );
  expect(renderMinimalGuide()).toContain(
    'visp feature "<goal>" --check "<test command>" --source-brief -',
  );
  expect(SLASH_COMMANDS.find((command) => command.name === "visp-feature")?.body).toContain(
    "--source-brief",
  );
});

it("starts the minimal guide with a one-slice check in the feature command and a shell-safe request", () => {
  expect(renderMinimalGuide()).toContain('--check "<test command>"');
  expect(renderMinimalGuide()).toContain("--source-brief -");
  expect(renderMinimalGuide()).toContain("<<'REQUEST'");
});

it("tells every guide to show user-readable information as labeled text", () => {
  for (const guide of [renderAgentGuide(), renderMinimalGuide()]) {
    expect(guide).toContain(
      "If the request has a UI, show status, counts, errors as word-labeled text",
    );
    expect(guide).toContain("Score: 1500");
    expect(guide).toContain("not only canvas/icons");
  }
});

it("routes review through visp next and starts work while feature writes tests", () => {
  for (const guide of [renderAgentGuide(), renderMinimalGuide()]) {
    expect(guide).toContain(
      "If visp done runs VISP's reviewer, run or delegate no review; visp next waits.",
    );
    expect(guide).toContain("Run visp critic/review only when visp next prints it.");
    expect(guide).toContain(
      "Run done/verify/accept/next/pr in the foreground, alone, with the host's maximum shell timeout: no run_in_background, loop or file redirect.",
    );
    expect(guide).toContain(
      "Only feature may be backgrounded (leave it running on blocking hosts). When it prints, run visp work unless --check did; never rerun feature; after kill/error recover by id.",
    );
    // "Poll" invited shell loops around visp status, which the hook now refuses.
    expect(guide).not.toContain("Poll; never duplicate");
    expect(guide).not.toContain("Poll done/verify/accept handles");
    expect(guide).not.toContain("Retain and poll the command handle");
    expect(guide).not.toContain("delegate nothing");
  }
  expect(renderAgentGuide()).toContain(
    "Wait on done/verify/accept until they return, in the foreground; completed checks are saved for retry after interruption.",
  );
  expect(renderAgentGuide()).toContain(
    "Use at least 10 minutes for feature/done/verify/accept/next",
  );
  expect(renderAgentGuide()).toContain(
    "When visp next hands you a\n  review, pause scoped edits until it returns.",
  );
  expect(renderAgentGuide()).not.toContain("feedbackLoop");
});

it("tells every guide that UI previews use the real action's function and start point", () => {
  for (const guide of [renderAgentGuide(), renderMinimalGuide()]) {
    expect(guide).toContain(
      "- UI previews (aim line, predicted path): use the real action's function and start point; check with real input. Do not delete or shrink requested content to pass a check.",
    );
  }
});
