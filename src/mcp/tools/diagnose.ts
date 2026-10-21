import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { renderSettings, requestedSettings } from "../../config/effective.js";
import { PRODUCT_NAME } from "../../core/constants.js";
import { ok } from "../../core/result.js";
import { withRuntimeDiagnostic } from "../../core/runtime-agreement.js";
import { runtimeIdentity } from "../../core/version.js";
import { runChecks } from "../../doctor/checks.js";
import { TOOL } from "../constants.js";
import { workspaceFor } from "../context.js";
import { failure, reply } from "../reply.js";

/**
 * Two things an agent could previously only get by shelling out: why a refusal
 * is happening, and what the task it is about to start actually asks for.
 *
 * Both are read-only. Changing the policy, or recording an exception to it,
 * stays a human decision at the CLI — an agent that can widen the rules it is
 * being held to is not being held to them.
 */
export function registerDiagnoseTools(server: McpServer, root: string): void {
  server.registerTool(
    TOOL.doctor,
    {
      title: "Check the setup",
      description:
        "Report whether this project is set up correctly and what is enforcing scope. " +
        "Call this when a command fails in a way that looks like a broken install.",
      inputSchema: {
        settings: z
          .boolean()
          .optional()
          .describe("Explain effective settings without changing them"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const state = await workspaceFor(root);
      if (!state.ok) return failure(TOOL.doctor, withRuntimeDiagnostic(state.error));

      const report = await runChecks(state.value);
      const settings = await requestedSettings(state.value, args.settings);

      return reply(TOOL.doctor, ok({ runtime: runtimeIdentity(), ...report, ...settings }), {
        text: (data) =>
          [
            `${PRODUCT_NAME} is ${data.verdict}.`,
            ...renderSettings(settings.settings),
            `Runtime: ${data.runtime.version} build ${data.runtime.buildId} (${data.runtime.executable})`,
            ...data.checks.map(
              (check) =>
                `  ${check.status.padEnd(7)} ${check.name}: ${check.detail}` +
                (check.recovery ? ` (fix: ${check.recovery})` : ""),
            ),
          ].join("\n"),
      });
    },
  );
}
