import { compactProductReply } from "../product-compact-text.js";
import type { ProductContextContent, ProductWorkContext } from "./context-types.js";

/** Approximation prices one full payload: MCP text is a bounded summary of structured data. */
export function estimateProductContextTokens(value: ProductWorkContext): number {
  const cli = JSON.stringify({ command: "handoff", ok: true, data: value }, null, 2);
  const mcp = JSON.stringify({
    content: [{ type: "text", text: compactProductReply("visp_work", value, "mcp") ?? "" }],
    structuredContent: { tool: "visp_work", ok: true, data: value },
  });
  // Leave room for the next action and envelope fields without pricing a second full context.
  return Math.ceil(Math.max(cli.length + 1, mcp.length + 256) / 4);
}

/** Keep authored intent and safety boundaries whole; a tiny budget cannot weaken them. */
export function fitProductContext(
  input: ProductContextContent,
  tokenBudget: number,
  sources: readonly string[],
): ProductWorkContext {
  let feedbackCharacters = 0;
  let fitted: ProductWorkContext = {
    ...input,
    feedback: input.feedback.map((entry) => {
      const output = entry.output.slice(0, 2000);
      feedbackCharacters += entry.output.length - output.length;
      return {
        ...entry,
        output,
        truncated: entry.truncated === true || output.length < entry.output.length,
      };
    }),
    budget: {
      tokenBudget,
      estimatedTokens: 0,
      status: "within-budget",
      omitted: { files: 0, skills: 0, feedbackCharacters: 0 },
      sources,
    },
  };
  fitted = price({
    ...fitted,
    budget: { ...fitted.budget, omitted: { ...fitted.budget.omitted, feedbackCharacters } },
  });
  fitted = fitAdvisoryContext(fitted);
  // Admitted skills are small and are the only place a procedure reaches the worker;
  // source excerpts go first because the worker can read those files itself.
  for (const [key, counter] of [
    ["files", "files"],
    ["skills", "skills"],
  ] as const) {
    if (fitted.budget.estimatedTokens <= tokenBudget) break;
    fitted = fitPrefix(fitted, key, counter);
  }
  return fitted.budget.estimatedTokens <= tokenBudget
    ? fitted
    : price({ ...fitted, budget: { ...fitted.budget, status: "essential-overflow" } });
}

/** Derived instructions yield before source; the full outstanding probe list remains visible. */
function fitAdvisoryContext(context: ProductWorkContext): ProductWorkContext {
  let fitted = context;
  const { tokenBudget } = context.budget;
  if (fitted.budget.estimatedTokens > tokenBudget && fitted.feedbackPlan?.nextProbe)
    fitted = price({
      ...fitted,
      feedbackPlan: { ...fitted.feedbackPlan, nextProbe: undefined },
      budget: { ...fitted.budget, omitted: { ...fitted.budget.omitted, probes: 1 } },
    });
  if (fitted.budget.estimatedTokens > tokenBudget && fitted.feedbackPlan?.observationPlan)
    fitted = price({
      ...fitted,
      feedbackPlan: {
        ...fitted.feedbackPlan,
        observationPlan: {
          session: "Browser checks: same session; captures start fresh.",
          sequence: [],
          probes: fitted.feedbackPlan.observationPlan.probes,
          review: "Full lifecycle and probe instructions: visp review --template.",
        },
      },
      budget: {
        ...fitted.budget,
        omitted: { ...fitted.budget.omitted, observationGuidance: true },
      },
    });
  return fitted;
}

/** Bounded prefix search avoids repeatedly copying a growing omission ledger. */
function fitPrefix(
  context: ProductWorkContext,
  key: "skills" | "files",
  counter: "skills" | "files",
): ProductWorkContext {
  const entries = context[key];
  const candidate = (count: number) =>
    price({
      ...context,
      [key]: entries.slice(0, count),
      budget: {
        ...context.budget,
        omitted: { ...context.budget.omitted, [counter]: entries.length - count },
      },
    });
  let best = candidate(0);
  let low = 1;
  let high = entries.length - 1;
  while (low <= high && best.budget.estimatedTokens <= context.budget.tokenBudget) {
    const middle = Math.floor((low + high) / 2);
    const next = candidate(middle);
    if (next.budget.estimatedTokens <= context.budget.tokenBudget) {
      best = next;
      low = middle + 1;
    } else high = middle - 1;
  }
  return best;
}

function price(value: ProductWorkContext): ProductWorkContext {
  let current = value;
  for (let pass = 0; pass < 5; pass++) {
    const estimatedTokens = estimateProductContextTokens(current);
    if (estimatedTokens === current.budget.estimatedTokens) break;
    current = { ...current, budget: { ...current.budget, estimatedTokens } };
  }
  return current;
}
