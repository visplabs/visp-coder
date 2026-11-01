import { describe, expect, it } from "vitest";
import { parseConfig } from "../../../src/config/load.js";
import { renderConfigTemplate, suggestedValidationCommands } from "../../../src/config/template.js";
import { HARNESSES, PRESETS } from "../../../src/core/constants.js";

describe("renderConfigTemplate", () => {
  /**
   * The file init writes must load. A commented-out YAML list parses as null,
   * which once made a freshly initialised project unusable.
   */
  it("produces a loadable config for every preset and harness", () => {
    for (const preset of PRESETS) {
      for (const harness of HARNESSES) {
        const text = renderConfigTemplate({ preset, harness, validationCommands: [] });
        const parsed = parseConfig(text, "visp.yml");

        expect(parsed.ok, `${preset}/${harness} produced an invalid config`).toBe(true);
      }
    }
  });

  it("lets VISP launch the reviewer only where a launcher exists", () => {
    const load = (harness: (typeof HARNESSES)[number]) => {
      const parsed = parseConfig(
        renderConfigTemplate({ preset: "generic", harness, validationCommands: [] }),
        "visp.yml",
      );
      if (!parsed.ok) throw new Error(parsed.error.message);
      return parsed.value.critic;
    };
    expect(load("codex")?.launch).toBe("codex-exec");
    expect(load("codex")?.reasoningEffort).toBe("medium");
    expect(load("codex")?.webSearch).toBe(true);
    expect(load("claude-code")?.launch).toBe("claude-exec");
    expect(load("claude-code")?.harness).toBe("claude-code");
    expect(load("cursor")?.launch).toBeUndefined();
  });

  it("loads when validation commands are present", () => {
    const text = renderConfigTemplate({
      preset: "typescript",
      harness: "claude-code",
      validationCommands: ["pnpm test", "pnpm typecheck"],
    });

    const parsed = parseConfig(text, "visp.yml");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.workflow.validationCommands).toEqual(["pnpm test", "pnpm typecheck"]);
  });

  it("writes an empty list rather than nothing when there are no commands", () => {
    const text = renderConfigTemplate({
      preset: "generic",
      harness: "generic",
      validationCommands: [],
    });

    const parsed = parseConfig(text, "visp.yml");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.workflow.validationCommands).toEqual([]);
  });

  it("records the detected preset and harness", () => {
    const text = renderConfigTemplate({
      preset: "python",
      harness: "cursor",
      validationCommands: [],
    });

    const parsed = parseConfig(text, "visp.yml");
    expect(parsed.ok && parsed.value.preset).toBe("python");
    expect(parsed.ok && parsed.value.harness).toBe("cursor");
    expect(parsed.ok && parsed.value.profile).toBe("minimal");
    expect(parsed.ok && Object.keys(parsed.value.context).sort()).toEqual([
      "maxSnippets",
      "tokenBudget",
    ]);
  });
});

describe("suggestedValidationCommands", () => {
  it("writes the expected runnable starter commands for every detected preset", () => {
    const scripts = { test: "run tests", typecheck: "check types", lint: "check style" };
    const expected = new Map([
      ["react", ["npm run test", "npm run typecheck", "npm run lint"]],
      ["node-api", ["npm run test", "npm run typecheck", "npm run lint"]],
      ["typescript", ["npm run test", "npm run typecheck", "npm run lint"]],
      ["javascript", ["npm run test", "npm run typecheck", "npm run lint"]],
      ["python", ["pytest"]],
      ["go", ["go test ./..."]],
      ["rust", ["cargo test"]],
      ["generic", []],
    ]);
    expect([...expected.keys()]).toEqual([...PRESETS]);
    for (const preset of PRESETS) {
      const commands = expected.get(preset);
      if (!commands) throw new Error(`Missing expected commands for ${preset}`);
      const config = parseConfig(
        renderConfigTemplate({
          preset,
          harness: "generic",
          validationCommands: suggestedValidationCommands(preset, scripts),
        }),
        "visp.yml",
      );
      expect(config.ok, `${preset} starter config failed to load`).toBe(true);
      if (!config.ok) continue;
      expect(config.value.preset).toBe(preset);
      expect(config.value.workflow.validationCommands).toEqual(commands);
    }
  });

  it("suggests only scripts the project actually has", () => {
    expect(suggestedValidationCommands("typescript", { test: "vitest" })).toEqual(["npm run test"]);
    expect(suggestedValidationCommands("typescript", {})).toEqual([]);
  });

  it("suggests the standard command for non-script ecosystems", () => {
    expect(suggestedValidationCommands("python")).toEqual(["pytest"]);
    expect(suggestedValidationCommands("go")).toEqual(["go test ./..."]);
    expect(suggestedValidationCommands("rust")).toEqual(["cargo test"]);
  });

  it("suggests nothing for a generic project", () => {
    expect(suggestedValidationCommands("generic")).toEqual([]);
  });
});
