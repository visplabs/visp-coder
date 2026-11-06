// sdlc.config.json at the repository root: the Jira and Confluence ids, the owner's account,
// loop bounds, the run budget, the Codex reviewer and each agent's model, effort and MCP tools.
// Read fresh on every call, because hooks are short-lived processes.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { repoRoot } from "./paths.mjs";

const bounds = z.object({ min: z.number().int().min(1), max: z.number().int().min(1) });
const agent = z.object({
  model: z.string().min(1),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
  mcp: z.array(z.string().startsWith("mcp__")),
});

const configSchema = z.object({
  baseBranch: z.string().min(1),
  owner: z.object({ accountId: z.string().min(1) }),
  jira: z.object({
    site: z.string().min(1),
    cloudId: z.string().min(1),
    project: z.object({ key: z.string().regex(/^[A-Z][A-Z0-9]+$/), id: z.string() }),
    issueTypes: z.record(z.string(), z.string()),
    statuses: z.object({
      todo: z.string(),
      ready: z.string(),
      inProgress: z.string(),
      inReview: z.string(),
      done: z.string(),
    }),
    secret: z.object({ service: z.string(), account: z.string() }),
  }),
  confluence: z.object({
    spaceKey: z.string(),
    spaceId: z.string(),
    pages: z.record(z.string(), z.string()),
  }),
  loops: z.object({ inner: bounds, verify: bounds, ci: bounds }),
  budget: z.object({
    agentRunsPerEpic: z.number().int().positive(),
    coderRunsPerEpic: z.number().int().positive(),
  }),
  reviewer: z.object({
    host: z.literal("codex"),
    model: z.string().min(1),
    effort: z.string().min(1),
    codexHome: z.string().min(1),
    timeoutMinutes: z.number().positive(),
    fallbackAgent: z.string().min(1),
  }),
  agents: z.record(z.string(), agent),
});

export function loadConfig(cwd = process.cwd()) {
  const path = join(repoRoot(cwd), "sdlc.config.json");
  if (!existsSync(path)) throw new Error(`no SDLC config at ${path}`);
  const result = configSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!result.success) {
    const errors = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`${path}: ${errors.join("; ")}`);
  }
  return result.data;
}
