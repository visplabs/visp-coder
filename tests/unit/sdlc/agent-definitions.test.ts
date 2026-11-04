import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = process.cwd();
const agentsDir = join(root, ".claude/agents");
const skillsDir = join(root, ".claude/skills");
const { TASK_REPORTS } = (await import(
  pathToFileURL(join(root, "scripts/sdlc/lib/agents.mjs")).href
)) as { TASK_REPORTS: Record<string, string> };

type Frontmatter = Record<string, unknown> & { name: string; description: string };

function frontmatter(path: string): Frontmatter {
  const match = readFileSync(path, "utf8").match(/^---\n([\s\S]*?)\n---\n/);
  if (!match?.[1]) throw new Error(`${path} has no frontmatter`);
  return parse(match[1]) as Frontmatter;
}

const agents = readdirSync(agentsDir).map((file) => ({
  file,
  meta: frontmatter(join(agentsDir, file)),
}));
const skills = readdirSync(skillsDir);

describe("SDLC agent and skill definitions", () => {
  it("names every agent after its file and gives it a model and effort Claude Code accepts", () => {
    for (const { file, meta } of agents) {
      expect(meta.name, file).toBe(file.replace(/\.md$/, ""));
      expect(meta.description.length, file).toBeGreaterThan(40);
      expect(["haiku", "sonnet", "opus"], file).toContain(meta.model);
      expect(["low", "medium", "high", "xhigh", "max"], file).toContain(meta.effort);
    }
  });

  it("defines every agent the hooks and the manager rely on", () => {
    const names = agents.map(({ meta }) => meta.name);
    for (const name of Object.keys(TASK_REPORTS)) expect(names).toContain(name);
    const manager = agents.find(({ meta }) => meta.name === "manager")?.meta;
    const spawnable =
      String(manager?.tools)
        .match(/Agent\(([^)]*)\)/)?.[1]
        ?.split(/,\s*/) ?? [];
    expect([...spawnable].sort()).toEqual(names.filter((name) => name !== "manager").sort());
  });

  it("keeps subagents from spawning agents and coders in their own worktree", () => {
    for (const { file, meta } of agents.filter(({ meta }) => meta.name !== "manager")) {
      expect(String(meta.disallowedTools), file).toContain("Agent");
    }
    for (const { file, meta } of agents.filter(({ meta }) => meta.name.startsWith("coder-"))) {
      expect(meta.isolation, file).toBe("worktree");
    }
  });

  it("keeps the owner commands out of the model's reach", () => {
    for (const command of ["feature", "approve"]) {
      const meta = frontmatter(join(root, ".claude/commands", `${command}.md`));
      expect(meta["disable-model-invocation"], command).toBe(true);
    }
  });

  it("preloads only skills that exist, each with a name and description", () => {
    for (const { file, meta } of agents) {
      for (const skill of (meta.skills as string[] | undefined) ?? []) {
        expect(existsSync(join(skillsDir, skill, "SKILL.md")), `${file}: ${skill}`).toBe(true);
      }
    }
    for (const skill of skills) {
      const meta = frontmatter(join(skillsDir, skill, "SKILL.md"));
      expect(meta.name).toBe(skill);
      expect(meta.description.length).toBeGreaterThan(40);
    }
  });
});
