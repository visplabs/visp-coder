import { parse } from "yaml";
import type { z } from "zod";
import { vispError } from "../core/errors.js";
import { ProjectFileSystem } from "../core/fs.js";
import type { ProjectPaths } from "../core/paths.js";
import { err, ok, type Result } from "../core/result.js";
import { configSchema, defaultConfig, type VispConfig } from "./schema.js";

/**
 * Loads `visp.yml`. A missing file is not an error: defaults apply, so a project
 * works before it is configured.
 */
export async function loadConfig(paths: ProjectPaths): Promise<Result<VispConfig>> {
  const text = await new ProjectFileSystem(paths.root).readTextIfExists(paths.config);
  if (!text.ok) return text;
  if (text.value === undefined) return ok(defaultConfig());
  return parseConfig(text.value, paths.config);
}

export function parseConfig(text: string, source: string): Result<VispConfig> {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err(vispError("CONFIG_INVALID", `${source} is not valid YAML: ${message}`));
  }

  // An empty file parses to null, which is a valid "all defaults" config.
  const parsed = configSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return err(
      vispError(
        "CONFIG_INVALID",
        `${source} has invalid settings:\n${formatConfigIssues(parsed.error)}`,
        {
          recovery: "Correct the listed keys in visp.yml; preserve the other project settings",
        },
      ),
    );
  }
  return ok(parsed.data);
}

export function formatConfigIssues(error: z.ZodError, critic = false): string {
  return error.issues
    .flatMap((issue) => {
      if (issue.code === "unrecognized_keys")
        return issue.keys.map((key) => {
          const path = [...issue.path, key].join(".");
          const message = removedSettingMessage(issue.path.join("."), key, critic);
          return `  ${path}: ${message}`;
        });
      const path = issue.path.join(".");
      return `  ${path === "" ? "(root)" : path}: ${issue.message}`;
    })
    .join("\n");
}

function removedSettingMessage(section: string, key: string, critic: boolean): string {
  if ((critic || section === "critic") && ["maxOutputTokens", "maxInputCharacters"].includes(key))
    return "Remove this setting: VISP never enforced this critic limit; the native host owns generation and context limits";
  if (
    section === "context" &&
    ["ranking", "snippetCap", "maxSnippetLines", "includeSnippets", "maxRegionsPerFile"].includes(
      key,
    )
  )
    return "Remove this setting: it has no effect on current product context; tokenBudget and maxSnippets remain supported";
  if (section === "graph" && ["queryDepth", "queryResults"].includes(key))
    return "Remove this setting: graph queries use request --depth and --results (MCP depth/results), or built-in defaults";
  if (section === "" && key === "skills")
    return "Remove this setting: project skills were removed; no context pack carries them";
  if (section === "memory" && key === "service")
    return "Remove this setting: the Visp Memory service was removed; memory.recall selects earlier decisions with the reviewer's model";
  if (section === "workflow") return removedWorkflowMessage(key);
  return "Unknown setting";
}

function removedWorkflowMessage(key: string): string {
  if (["maxSourceFileLines", "maxSourceLineChars"].includes(key))
    return "Remove this setting: current product review does not enforce source-size heuristics; maxChangedFiles remains supported";
  if (key === "reviewMode")
    return "Remove this setting: the observation-preview review mode was removed; review always uses the current mode";
  if (key === "requireTests")
    return "Remove this setting: the legacy gate is retired; declared product checks and outcome evidence govern current closure and acceptance";
  return "Unknown setting";
}
