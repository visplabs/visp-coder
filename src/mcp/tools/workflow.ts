import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { vispError } from "../../core/errors.js";
import { featureIdSchema, parseFeatureStart, taskIdSchema } from "../../core/input.js";
import type { Result } from "../../core/result.js";
import { productCheckTemplate } from "../../workflow/product/check/check-guidance.js";
import {
  readProductBrief,
  runProductContext,
  runProductStatus,
  runProductWork,
  updateProductBrief,
} from "../../workflow/product/index.js";
import { runProductNextAfterReview } from "../../workflow/product/review/done-review.js";
import type { ProductSelection } from "../../workflow/product/store.js";
import { createProductFeatureWithTests } from "../../workflow/product/tester/independent-tests.js";
import { configuredTestsStarter } from "../../workflow/product/tester/independent-tests-starters.js";
import { testsWaitMs } from "../../workflow/product/tester/tester-session.js";
import { compactProductReply } from "../../workflow/product-compact-text.js";
import { PRODUCT_BRIEF_ENTRY_GUIDE, productInputTemplate } from "../../workflow/product-inputs.js";
import {
  compactProductStatus,
  productImages,
  productNextCommand,
  productWithoutImageBytes,
  renderProductResult,
} from "../../workflow/product-presentation.js";
import type { WorkspaceState } from "../../workflow/state.js";
import { mcpAction, mcpActionText } from "../action.js";
import { TOOL } from "../constants.js";
import { mutatingWorkspaceFor, workspaceFor } from "../context.js";
import { mcpOperationOptions } from "../operation-progress.js";
import { failure, reply } from "../reply.js";

export const productSelectionInput = {
  feature: featureIdSchema.optional(),
  task: taskIdSchema.optional(),
};

// Brief content is validated by the shared parser after alias normalization. Exporting its
// full schema here cost ~15k characters in every turn and rejected input before
// normalization could run.
const authoredBrief = z.record(z.string(), z.unknown());
const briefInputSchema = z
  .object({
    feature: featureIdSchema.optional(),
    brief: authoredBrief.optional(),
    patch: authoredBrief.optional(),
    template: z.boolean().optional(),
    checkTemplate: z.enum(["command", "browser"]).optional(),
    reason: z.string().optional(),
    intentChange: z.object({ reason: z.string().min(1), provenance: z.string().min(1) }).optional(),
  })
  .strict();
type BriefInput = z.infer<typeof briefInputSchema>;

function conflictingBriefInput(args: BriefInput): boolean {
  return (
    [
      args.template === true,
      args.checkTemplate !== undefined,
      args.brief !== undefined,
      args.patch !== undefined,
    ].filter(Boolean).length > 1
  );
}

async function briefOperation(state: WorkspaceState, args: BriefInput) {
  if (args.checkTemplate) return productCheckTemplate(state, args.checkTemplate, args);
  if (args.template) return productInputTemplate(state, "brief", args);
  if (args.brief !== undefined || args.patch !== undefined) return updateProductBrief(state, args);
  return readProductBrief(state, args);
}

function withBriefGuidance(response: CallToolResult, template?: boolean): CallToolResult {
  if (!template || response.isError) return response;
  return {
    ...response,
    // Some hosts deliver only structuredContent to the model.
    // Keep advice outside data so the editable brief stays schema-valid.
    structuredContent: {
      ...response.structuredContent,
      guidance: PRODUCT_BRIEF_ENTRY_GUIDE,
    },
    content: [...response.content, { type: "text", text: PRODUCT_BRIEF_ENTRY_GUIDE }],
  };
}

/** StructuredContent carries the complete result once; text keeps only actionable context. */
export function productReply(
  name: string,
  result: Result<unknown>,
  detail = false,
): CallToolResult {
  const response = reply(name, result, {
    text: (value) => {
      const compact = compactProductReply(name, value, "mcp") ?? renderProductResult(value);
      const command = productNextCommand(value);
      const rendered = command ? mcpActionText(command) : undefined;
      if (!command || !rendered) return compact;
      const escaped = compact.replaceAll(
        JSON.stringify(command).slice(1, -1),
        JSON.stringify(rendered).slice(1, -1),
      );
      return escaped.replaceAll(
        `Next: ${JSON.stringify(rendered).slice(1, -1)}`,
        `Next: ${rendered}`,
      );
    },
    nextCommand: (value) => mcpActionText(productNextCommand(value) ?? ""),
    data: (value) => {
      const data = productWithoutImageBytes(value);
      if (name === TOOL.capture && data && typeof data === "object" && !Array.isArray(data)) {
        const { images: _images, ...receipt } = data as Record<string, unknown>;
        return {
          ...receipt,
          imageIds: Array.isArray(receipt.captures)
            ? receipt.captures.flatMap((capture) =>
                capture && typeof capture === "object" && "id" in capture ? [capture.id] : [],
              )
            : [],
        };
      }
      return !detail && name === TOOL.status ? compactProductStatus(data) : data;
    },
  });
  const command = result.ok ? productNextCommand(result.value) : undefined;
  const nextAction = command ? mcpAction(command) : undefined;
  const textContent = response.content as { type: "text"; text: string }[];
  return result.ok
    ? {
        ...response,
        content: [...textContent, ...productImages(result.value)],
        structuredContent: { ...response.structuredContent, ...(nextAction ? { nextAction } : {}) },
      }
    : { ...response, content: textContent };
}

export function registerWorkflowTools(server: McpServer, root: string): void {
  for (const [name, run] of [
    [
      TOOL.next,
      (state: WorkspaceState, args: ProductSelection) =>
        runProductNextAfterReview(state, args, "mcp"),
    ],
    [TOOL.status, runProductStatus],
  ] as const) {
    server.registerTool(
      name,
      {
        title: name === TOOL.next ? "Next product action" : "Product status",
        description: "Read outcomes, current evidence and the next action without changing state.",
        inputSchema: z
          .object({ ...productSelectionInput, detail: z.boolean().optional() })
          .strict(),
        annotations: { readOnlyHint: true },
      },
      async (args, extra) => {
        const operation = mcpOperationOptions(extra);
        const state = await workspaceFor(root);
        return state.ok
          ? productReply(name, await run(state.value, { ...args, ...operation }), args.detail)
          : failure(name, state.error);
      },
    );
  }
  server.registerTool(
    TOOL.feature,
    {
      title: "Start a product brief",
      description: "Preserve the original request and begin planning the first usable slice.",
      inputSchema: z
        .object({
          goal: z.string().min(1),
          sourceBrief: z.string().optional(),
          branch: z.boolean().optional(),
          riskLevel: z.enum(["low", "medium", "high", "critical"]).optional(),
          workflow: z.enum(["full", "compact"]).optional(),
        })
        .strict(),
    },
    async (args) => {
      const risk = parseFeatureStart(args.riskLevel, args.workflow);
      if (!risk.ok) return failure(TOOL.feature, risk.error);
      const state = await mutatingWorkspaceFor(root);
      return state.ok
        ? productReply(
            TOOL.feature,
            await createProductFeatureWithTests(
              state.value,
              args,
              configuredTestsStarter(state.value, "mcp"),
            ),
          )
        : failure(TOOL.feature, state.error);
    },
  );
  server.registerTool(
    TOOL.brief,
    {
      title: "Read or revise the working brief",
      description:
        "Omit brief/patch to read. Prefer patch with changed fields: arrays update by id, entries without id append; omitted entries and protected fields are preserved. Use brief only for full replacement. template:true supplies the editable brief and field examples; checkTemplate returns a command or browser example without execution. Brief fields: outcomes{kind:functional|quality|experience,statement}, examples{title,given[],when,expected[]}, decisions{statement,rationale}, checks{command,outcomes[],files[]}, slices{id:T001,goal,outcomes[],scope{allowed[]},checks[]}. Unambiguous alternative field names are normalized and listed in normalized. Intent changes still require reason and provenance.",
      inputSchema: briefInputSchema,
    },
    async (args) => {
      if (conflictingBriefInput(args))
        return failure(
          TOOL.brief,
          vispError(
            "ARTIFACT_INVALID",
            "template, checkTemplate, brief and patch are mutually exclusive",
          ),
        );
      const editing = args.brief !== undefined || args.patch !== undefined;
      const state = await (editing ? mutatingWorkspaceFor(root) : workspaceFor(root));
      if (!state.ok) return failure(TOOL.brief, state.error);
      // Reading or templating asks for the content itself; only updates are acknowledged.
      return withBriefGuidance(
        productReply(TOOL.brief, await briefOperation(state.value, args), !editing),
        args.template,
      );
    },
  );
  server.registerTool(
    TOOL.work,
    {
      title: "Work on a usable slice",
      description:
        "Deliver context and authorize the selected scope. inspect:true reads existing context without authorization or graph refresh. The full result is in structuredContent.data.",
      inputSchema: z
        .object({
          ...productSelectionInput,
          retryEnvironment: z.boolean().optional(),
          inspect: z.boolean().optional(),
          check: z
            .string()
            .optional()
            .describe(
              "Test command for the slice; on a feature without slices, work the whole request as one slice",
            ),
          detail: z.boolean().optional(),
          known: z
            .string()
            .optional()
            .describe(
              "contextId of an earlier work reply still in view; its unchanged source excerpts are not repeated",
            ),
        })
        .strict(),
    },
    async (args) => {
      const state = await (args.inspect ? workspaceFor(root) : mutatingWorkspaceFor(root));
      return state.ok
        ? productReply(
            TOOL.work,
            await (args.inspect
              ? runProductContext(state.value, args)
              : runProductWork(
                  state.value,
                  args,
                  configuredTestsStarter(state.value, "mcp"),
                  testsWaitMs(state.value, "mcp"),
                )),
            args.detail,
          )
        : failure(TOOL.work, state.error);
    },
  );
}
