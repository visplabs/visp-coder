import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  codexHooksWarning,
  codexSessionPrompts,
  HOST_PROMPTS_FILE,
  hasUntakenPrompts,
  hostRequest,
} from "../../../../src/workflow/product/host-prompts.js";
import { TestWorkspace } from "../../support/workspace.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

async function codexSession(text: string): Promise<{ home: string; thread: string }> {
  const home = await mkdtemp(join(tmpdir(), "visp-codex-session-"));
  const thread = "01a0e3cf-fc9f-71d3-9b4d-dc086a0db889";
  const day = join(home, "sessions", "2026", "09", "27");
  await mkdir(day, { recursive: true });
  await writeFile(
    join(day, `rollout-2026-09-27T22-30-53-${thread}.jsonl`),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: { type: "UserMessage", content: [{ type: "text", text }] },
      },
    }),
  );
  return { home, thread };
}

// A headless codex exec in a project whose hooks were never trusted ran with no Stop
// reminder and no shell protection, and nothing said so.
it("warns a Codex feature when the request came from the session file, not VISP's hook", async () => {
  const workspace = await TestWorkspace.create();
  const state = await workspace.state();
  const { home, thread } = await codexSession("Build an Angry Birds-style game.");
  vi.stubEnv("CODEX_HOME", home);
  vi.stubEnv("CODEX_THREAD_ID", thread);

  const unhooked = await hostRequest(state, undefined);
  expect(unhooked.ok && unhooked.value?.recordedByHook).toBe(false);
  expect(unhooked.ok && codexHooksWarning("codex", unhooked.value)).toContain("/hooks");
  expect(unhooked.ok && codexHooksWarning("claude-code", unhooked.value)).toBeUndefined();

  await mkdir(state.paths.sessionDir, { recursive: true });
  await writeFile(
    join(state.paths.sessionDir, HOST_PROMPTS_FILE),
    `${JSON.stringify({ prompt: "Build an Angry Birds-style game." })}\n`,
  );
  const hooked = await hostRequest(state, undefined);
  expect(hooked.ok && hooked.value?.recordedByHook).toBe(true);
  expect(hooked.ok && codexHooksWarning("codex", hooked.value)).toBeUndefined();
  expect(codexHooksWarning("codex", undefined)).toBeUndefined();
});

// Codex workers passed short summaries as the verbatim request; Codex has no prompt hook,
// but commands see their session id and the session file records the user messages.
it("reads the user messages of the Codex session running the command", async () => {
  const home = await mkdtemp(join(tmpdir(), "visp-codex-session-"));
  const thread = "01a0d848-dc5d-7ef0-8a4f-d9e6a54948ef";
  const day = join(home, "sessions", "2026", "09", "25");
  await mkdir(day, { recursive: true });
  const user = (text: string) =>
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: { type: "UserMessage", content: [{ type: "text", text }] },
      },
    });
  await writeFile(
    join(day, `rollout-2026-09-25T16-47-28-${thread}.jsonl`),
    [
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<environment_context>x</environment_context>" }],
        },
      }),
      user("Build the spreadsheet engine.\nContract: ..."),
      user("continue"),
    ].join("\n"),
  );
  expect(await codexSessionPrompts({ CODEX_THREAD_ID: thread, CODEX_HOME: home })).toEqual([
    "Build the spreadsheet engine.\nContract: ...",
    "continue",
  ]);
  expect(await codexSessionPrompts({ CODEX_THREAD_ID: "other", CODEX_HOME: home })).toEqual([]);
  expect(await codexSessionPrompts({ CODEX_HOME: home })).toEqual([]);
});

// Codex Desktop records `event_msg/user_message {message}` instead of the item form.
it("falls back to the string user_message shape and never reads response_item messages", async () => {
  const home = await mkdtemp(join(tmpdir(), "visp-codex-session-"));
  const thread = "01a0e3cf-0000-71d3-9b4d-dc086a0db889";
  const day = join(home, "sessions", "2026", "09", "29");
  await mkdir(day, { recursive: true });
  const message = (text: unknown) =>
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: text } });
  const item = (type: string, text: string) =>
    JSON.stringify({
      type: "event_msg",
      payload: { type: "item_completed", item: { type, content: [{ type: "text", text }] } },
    });
  const injected = JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "# AGENTS.md instructions for /project" }],
    },
  });
  const rollout = async (lines: string[]) => {
    await writeFile(join(day, `rollout-2026-09-29T10-00-00-${thread}.jsonl`), lines.join("\n"));
    return codexSessionPrompts({ CODEX_THREAD_ID: thread, CODEX_HOME: home });
  };
  expect(
    await rollout([
      injected,
      message("Build the game.\nMake the birds fly."),
      message("   "),
      message(7),
      message("continue"),
    ]),
  ).toEqual(["Build the game.\nMake the birds fly.", "continue"]);
  // The item form wins when both exist; its type may be written user_message.
  expect(
    await rollout([message("Desktop text"), item("user_message", "Item text"), injected]),
  ).toEqual(["Item text"]);
  expect(await rollout([injected])).toEqual([]);
  expect(await codexSessionPrompts({ CODEX_THREAD_ID: "other-thread", CODEX_HOME: home })).toEqual(
    [],
  );
});

// Claude Code delivers a background command's completion to the session as a prompt. In bench
// run co1-conventions-carryover-prose-visp-dev-1 one was recorded as the user's request.
it("never takes a host task notification as the user's request", async () => {
  const workspace = await TestWorkspace.create();
  const state = await workspace.state();
  const notification = [
    "<task-notification>",
    "<task-id>bwvi3ofw5</task-id>",
    "<tool-use-id>toolu_01FnqbrfCS92xFPPZxFp4dgL</tool-use-id>",
    "<output-file>/tmp/claude/tasks/bwvi3ofw5.output</output-file>",
    "<status>completed</status>",
    '<summary>Background command "Create VISP feature from the request" completed (exit code 0)</summary>',
    "</task-notification>",
  ].join("\n");
  const record = (prompts: string[]) =>
    writeFile(
      join(state.paths.sessionDir, HOST_PROMPTS_FILE),
      prompts
        .map((prompt) => `${JSON.stringify({ at: "2026-10-20T22:06:05.995Z", prompt })}\n`)
        .join(""),
    );
  await mkdir(state.paths.sessionDir, { recursive: true });
  await record([notification]);
  expect(await hasUntakenPrompts(state)).toEqual({ ok: true, value: false });
  expect(await hostRequest(state, undefined)).toEqual({ ok: true, value: undefined });
  await record(["Add item prices.", `${notification}\n${notification}`]);
  const host = await hostRequest(state, undefined);
  expect(host.ok && host.value).toMatchObject({
    request: "Add item prices.",
    prompts: ["Add item prices."],
  });
  // A user who pastes a notification into a request of their own is still asking for something.
  await record([`Why did this fail?\n${notification}`]);
  expect(await hasUntakenPrompts(state)).toEqual({ ok: true, value: true });
});
