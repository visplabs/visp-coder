import { describe, expect, it } from "vitest";
import { parseConfig } from "../../../src/config/load.js";
import { defaultConfig } from "../../../src/config/schema.js";

describe("parseConfig", () => {
  it("rejects unsupported automatic skill admission with an actionable setting", () => {
    const result = parseConfig("skills:\n  mode: auto\n", "visp.yml");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("skills.mode");
    expect(result.error.message).toContain("review");
  });
  it("applies defaults for an empty file", () => {
    const result = parseConfig("", "visp.yml");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(defaultConfig());
  });

  it("reads values the user set", () => {
    const result = parseConfig("preset: python\nharness: codex\n", "visp.yml");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.preset).toBe("python");
    expect(result.value.harness).toBe("codex");
  });

  it("fills in unset keys of a partially specified section", () => {
    const result = parseConfig("workflow:\n  strictness: strict\n", "visp.yml");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.workflow.strictness).toBe("strict");
    expect(result.value.workflow.maxChangedFiles).toBe(40);
    expect(result.value.workflow.blockedPaths).toContain(".env");
  });

  it("rejects an unknown top-level key rather than ignoring it", () => {
    const result = parseConfig("unknownKey: 1\n", "visp.yml");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONFIG_INVALID");
  });

  it("rejects an invalid enum value and names the key", () => {
    const result = parseConfig("workflow:\n  strictness: nonsense\n", "visp.yml");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("workflow.strictness");
  });

  it("rejects a retired query setting even when its value exceeds former bounds", () => {
    const result = parseConfig("graph:\n  queryDepth: 99\n", "visp.yml");
    expect(result.ok).toBe(false);
  });

  it("reports malformed YAML as CONFIG_INVALID", () => {
    const result = parseConfig("preset: [unclosed\n", "visp.yml");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONFIG_INVALID");
  });

  it("offers a recovery hint when settings are invalid", () => {
    const result = parseConfig("preset: nonsense\n", "visp.yml");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.recovery).toContain("visp.yml");
  });
});

it.each(["maxOutputTokens", "maxInputCharacters"])(
  "rejects removed critic setting %s with removal guidance",
  (key) => {
    const result = parseConfig(`critic:\n  ${key}: 4096\n`, "visp.yml");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain(`critic.${key}`);
    expect(result.error.message).toContain("Remove this setting");
    expect(result.error.message).toContain("never enforced");
  },
);

it.each([
  ["ranking", "fused"],
  ["snippetCap", "false"],
  ["maxSnippetLines", "12"],
  ["includeSnippets", "true"],
  ["maxRegionsPerFile", "2"],
])("rejects ignored context setting %s with precise removal guidance", (key, value) => {
  const result = parseConfig(`context:\n  ${key}: ${value}\n`, "visp.yml");
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe("CONFIG_INVALID");
  expect(result.error.message).toContain(`context.${key}`);
  expect(result.error.message).toContain("Remove this setting");
  expect(result.error.message).toContain("current product context");
});

it("rejects the removed Visp Memory service with removal guidance", () => {
  const result = parseConfig("memory:\n  service:\n    command: visp-memory\n", "visp.yml");
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.message).toContain("memory.service");
  expect(result.error.message).toContain("Remove this setting");
});

it.each(["queryDepth", "queryResults"])(
  "rejects ignored graph control %s with request-level recovery",
  (key) => {
    const result = parseConfig(`graph:\n  ${key}: 1\n`, "visp.yml");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain(`graph.${key}`);
    expect(result.error.message).toContain("Remove this setting");
    expect(result.error.message).toContain("--depth");
    expect(result.error.message).toContain("--results");
  },
);

it.each(["maxSourceFileLines", "maxSourceLineChars"])(
  "rejects retired source-size control %s with a precise recovery",
  (key) => {
    const result = parseConfig(`workflow:\n  ${key}: 600\n`, "visp.yml");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Retired control was accepted");
    expect(result.error.message).toContain(`workflow.${key}`);
    expect(result.error.message).toContain("Remove this setting");
    expect(result.error.message).toContain("maxChangedFiles remains supported");
  },
);

it.each([true, false])(
  "rejects retired requireTests=%s without weakening product checks",
  (setting) => {
    const result = parseConfig(`workflow:\n  requireTests: ${setting}\n`, "visp.yml");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("workflow.requireTests");
    expect(result.error.message).toContain("Remove this setting");
    expect(result.error.message).toContain("declared product checks");
  },
);
