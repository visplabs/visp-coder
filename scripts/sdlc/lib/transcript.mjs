// Reads a subagent's Claude Code transcript (JSON lines): the task line in its prompt, its final
// report, the model it ran on and the tokens it used.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { TASK_LINE } from "./agents.mjs";

// SubagentStop names the transcript; tool events only give the session's, so the subagent's
// agent-<id>.jsonl is looked for below the session transcript's folder.
export function findAgentTranscript(event) {
  if (event.agent_transcript_path && existsSync(event.agent_transcript_path)) {
    return event.agent_transcript_path;
  }
  if (!event.transcript_path || !event.agent_id) return undefined;
  return search(dirname(event.transcript_path), `agent-${event.agent_id}.jsonl`, 4);
}

function search(dir, name, depth) {
  if (depth < 0 || !existsSync(dir)) return undefined;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry === name) return path;
    if (statSync(path).isDirectory()) {
      const found = search(path, name, depth - 1);
      if (found) return found;
    }
  }
  return undefined;
}

export function readTranscript(path) {
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

export function taskMarker(entries) {
  for (const entry of entries) {
    if (entry.type !== "user") continue;
    const match = textOf(entry.message?.content).match(TASK_LINE);
    if (match) return { feature: match[1], task: match[2] };
  }
  return undefined;
}

// Since Claude Code 2.1.271 a subagent may report through SubagentHandback; its report is that
// call's `message`, and the final assistant text is only a closing line.
export function finalReport(entries, lastMessage) {
  for (const entry of [...entries].reverse()) {
    if (entry.type !== "assistant" || !Array.isArray(entry.message?.content)) continue;
    const handback = entry.message.content.find(
      (part) => part.type === "tool_use" && part.name === "SubagentHandback",
    );
    if (handback?.input?.message) return handback.input.message;
  }
  if (lastMessage) return lastMessage;
  const last = [...entries].reverse().find((entry) => entry.type === "assistant");
  return textOf(last?.message?.content);
}

// Streaming writes one line per content block with the same message id and usage, so usage is
// counted once per message id.
export function modelAndUsage(entries) {
  const seen = new Set();
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
  let model;
  for (const entry of entries) {
    const message = entry.type === "assistant" ? entry.message : undefined;
    if (!message) continue;
    model = message.model ?? model;
    if (!message.usage || seen.has(message.id)) continue;
    seen.add(message.id);
    usage.input_tokens += message.usage.input_tokens ?? 0;
    usage.output_tokens += message.usage.output_tokens ?? 0;
    usage.cache_read_tokens += message.usage.cache_read_input_tokens ?? 0;
    usage.cache_write_tokens += message.usage.cache_creation_input_tokens ?? 0;
  }
  return { model, usage };
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
