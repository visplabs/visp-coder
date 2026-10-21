import { z } from "zod";
import type { RuleExtractor } from "./project-rules.js";
import {
  askReviewerModel,
  type ReviewerModel,
  type ReviewerModelOptions,
} from "./reviewer-model.js";

/**
 * Users state lasting rules in many ways: "house style", "whenever you touch X", "for the
 * rest of this project", or plain prose. Phrase matching found 4 of 18 such prompts in a
 * held-out set; this prompt, at low effort on the reviewer's model, found all 18 and no
 * rule in 12 ordinary requests, at about nine seconds a prompt. Without the exclusion of
 * instructions for carrying out the request, it recorded a benchmark's operating
 * instructions (paths, "do not ask questions") as project rules when no real rule was stated.
 */
const INSTRUCTIONS = `You read the messages a user sent to an AI coding assistant working in their repository, in order. List the STANDING RULES they state, as they stand after the last message (a later message may withdraw or replace an earlier rule; then list only the current one): requirements the user says also apply beyond this request, to later requests, future sessions or the whole project (conventions, house style, "from now on", "always when you touch X", "for the rest of this project").
Only list a requirement when the messages themselves say or clearly imply that it lasts beyond this request. Do NOT list: requirements that only concern the current task or this change's specification, acceptance criteria, plans that might happen later, or instructions for how to carry out this request (where to work, which directories or commands to use, tools, dependencies, whether to ask questions, how to report).
For each standing rule return "rule": the rule as one self-contained sentence that keeps every exact name, number, status code and example, and "quote": a verbatim excerpt of one message (copied exactly, at least a few words) that states it in its current form. Return {"rules": []} when there are none. Do not read files or run commands.
`;

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rules"],
  properties: {
    rules: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["rule", "quote"],
        properties: { rule: { type: "string" }, quote: { type: "string" } },
      },
    },
  },
} as const;
const responseSchema = z.object({
  rules: z.array(z.object({ rule: z.string(), quote: z.string() })),
});

/** The reader on the model of the reviewer VISP launches, Codex or Claude. */
export function reviewerRuleExtractor(
  reviewer: ReviewerModel,
  options: ReviewerModelOptions = {},
): RuleExtractor {
  return async (prompts) => {
    const response = await askReviewerModel(reviewer, options, {
      name: "visp-rules",
      purpose: "rule reader",
      schema: RESPONSE_SCHEMA,
      prompt: `${INSTRUCTIONS}\n${prompts
        .map((prompt, index) => `Message ${index + 1}:\n${prompt}`)
        .join("\n\n")}`,
    });
    return responseSchema.parse(response).rules;
  };
}
