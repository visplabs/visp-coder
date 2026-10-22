import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { vispError } from "../../core/errors.js";
import { err, ok } from "../../core/result.js";
import { runProductVerify } from "../../workflow/product/index.js";
import {
  configuredReviewStarter,
  reviewWaitMs,
  runProductAcceptReviewed,
  runProductDoneReviewed,
} from "../../workflow/product/review/done-review.js";
import {
  type IndependentReview,
  independentReviewSchema,
} from "../../workflow/product/review/independent-review.js";
import {
  type ProductReviewRequest,
  parseReviewSubmission,
  runProductReviewRequest,
  validateProductReviewRequest,
} from "../../workflow/product/review/review-request.js";
import { productReviewSubmissionSchema } from "../../workflow/product/review/review-submission-model.js";
import type { ProductSelection } from "../../workflow/product/store.js";
import type { WorkspaceState } from "../../workflow/state.js";
import { TOOL } from "../constants.js";
import { mutatingWorkspaceFor, workspaceFor } from "../context.js";
import { mcpOperationOptions } from "../operation-progress.js";
import { mcpProductFeedbackHost } from "../product-feedback-host.js";
import { failure } from "../reply.js";
import { productReply, productSelectionInput } from "./workflow.js";

/**
 * Judgment payloads are validated in the handler against the same schema. Exporting it as
 * the tool definition cost ~10k characters in every model turn.
 */
const reviewJudgmentInput = productReviewSubmissionSchema
  .partial()
  .extend({ response: independentReviewSchema.optional() });
const looseList = z.array(z.unknown()).optional();
const looseObject = z.record(z.string(), z.unknown()).optional();
const reviewJudgmentFields = {
  assessments: looseList,
  coverage: looseList,
  reviewer: looseObject,
  feedback: looseObject,
  experimentResolutions: looseList,
  subjectDigest: z.string().optional(),
  captures: z.unknown().optional(),
  selection: looseObject,
  response: looseObject,
};

function checkedReviewInput<T extends Record<string, unknown>>(input: T) {
  const judgments = Object.fromEntries(
    Object.keys(reviewJudgmentFields).flatMap((key) =>
      input[key] === undefined ? [] : [[key, input[key]]],
    ),
  );
  const parsed = reviewJudgmentInput.safeParse(judgments);
  return parsed.success
    ? ok({ ...input, ...parsed.data } as ProductReviewRequest & { response?: IndependentReview })
    : err(
        vispError(
          "ARTIFACT_INVALID",
          `Invalid review input:\n${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n")}`,
          { recovery: "visp review --template (MCP: template:true) shows the editable judgments" },
        ),
      );
}

const disputeFields = {
  dispute: z
    .array(z.string())
    .optional()
    .describe(
      "Failing pinned acceptance tests that contradict the request; VISP's own independent reviewer rules; you delegate nothing",
    ),
  reason: z
    .string()
    .optional()
    .describe("With dispute: quote the request sentence the test contradicts, and why"),
  account: z
    .array(z.string())
    .optional()
    .describe(
      'Account for each requirement the request states: "R001=<passing check id> [test name]" or "R001=not done: <reason>"',
    ),
};

export function registerEvidenceTools(server: McpServer, root: string): void {
  for (const [name, run] of [
    [TOOL.verify, runProductVerify],
    [
      TOOL.done,
      (state: WorkspaceState, args: ProductSelection & { reason?: string }) =>
        runProductDoneReviewed(
          state,
          { ...args, disputeReason: args.reason },
          configuredReviewStarter(state, "mcp"),
          reviewWaitMs(state, "mcp"),
        ),
    ],
    [
      TOOL.accept,
      (state: WorkspaceState, args: ProductSelection & { reason?: string }) =>
        runProductAcceptReviewed(
          state,
          { ...args, disputeReason: args.reason },
          configuredReviewStarter(state, "mcp"),
          reviewWaitMs(state, "mcp"),
        ),
    ],
  ] as const) {
    server.registerTool(
      name,
      {
        title: name,
        description:
          "Use the shared product engine to check behavior, close slices, or accept the assembled product.",
        inputSchema: z
          .object({
            ...productSelectionInput,
            detail: z.boolean().optional(),
            retryEnvironment: z.boolean().optional(),
            ...(name === TOOL.verify ? {} : disputeFields),
          })
          .strict(),
      },
      async (args, extra) => {
        const operation = mcpOperationOptions(extra);
        const state = await mutatingWorkspaceFor(root);
        return state.ok
          ? productReply(
              name,
              await run(state.value, { ...args, ...operation } as ProductSelection & {
                reason?: string;
              }),
              args.detail,
            )
          : failure(name, state.error);
      },
    );
  }
  server.registerTool(
    TOOL.review,
    {
      title: "Review actual product evidence",
      description:
        "prepare creates a confined tool-owned review session; submit session plus judgments without hashes or envelope fields. Without assessments or prepare, return relevant brief context and actual evidence. template returns editable unresolved assessments. Read the full result in structuredContent.data. Retain every outcome status; VISP selects at most three consequential corrections at a time.",
      inputSchema: z
        .object({
          ...productSelectionInput,
          ...reviewJudgmentFields,
          groups: z.array(z.string()).optional(),
          template: z.boolean().optional(),
          prepare: z.boolean().optional(),
          session: z.string().uuid().optional(),
          handoff: z.boolean().optional(),
          dispatch: z.boolean().optional(),
          detail: z.boolean().optional(),
        })
        .strict(),
    },
    async (raw) => {
      const input = checkedReviewInput(raw);
      if (!input.ok) return failure(TOOL.review, input.error);
      const parsed = sessionResponse(input.value);
      if (!parsed.ok) return failure(TOOL.review, parsed.error);
      const args = parsed.value;
      const valid = validateProductReviewRequest(args);
      if (!valid.ok) return failure(TOOL.review, valid.error);
      const state = await (args.assessments === undefined && !args.dispatch && !args.prepare
        ? workspaceFor(root)
        : mutatingWorkspaceFor(root));
      return state.ok
        ? productReply(
            TOOL.review,
            await runProductReviewRequest(
              state.value,
              args,
              args.dispatch ? mcpProductFeedbackHost(server) : undefined,
            ),
            args.detail,
          )
        : failure(TOOL.review, state.error);
    },
  );
}

function sessionResponse(input: ProductReviewRequest & { response?: IndependentReview }) {
  const { response, ...selection } = input;
  if (!response) return ok(selection);
  if (
    !selection.session ||
    [
      selection.assessments,
      selection.feedback,
      selection.coverage,
      selection.reviewer,
      selection.experimentResolutions,
    ].some((entry) => entry !== undefined)
  )
    return err(
      vispError(
        "ARTIFACT_INVALID",
        "response requires a prepared session and cannot accompany legacy judgments",
      ),
    );
  const parsed = parseReviewSubmission(response, selection.session);
  return parsed.ok ? ok({ ...selection, ...parsed.value }) : parsed;
}
