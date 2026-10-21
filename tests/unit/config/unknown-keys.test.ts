import { expect, it } from "vitest";
import { parseConfig } from "../../../src/config/load.js";
import { configSchema } from "../../../src/config/schema.js";

it.each(["workflow", "graph", "context", "memory", "telemetry", "critic"])(
  "rejects an unknown key in %s instead of silently applying defaults",
  (section) => {
    const result = configSchema.safeParse({ [section]: { misspelledSetting: true } });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Misspelled setting was accepted");
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        code: "unrecognized_keys",
        path: [section],
        keys: ["misspelledSetting"],
      }),
    );
  },
);

it("reports the complete misspelled path without recommending deletion of the configuration", () => {
  const result = parseConfig("context:\n  tokenBudegt: 500\n", "visp.yml");
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Misspelled setting was accepted");
  expect(result.error.message).toContain("context.tokenBudegt");
  expect(result.error.recovery).not.toContain("delete");
});
