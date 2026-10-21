import { join } from "node:path";
import type { FileMutation } from "../../core/file-transaction.js";
import { filePrecondition } from "../../core/file-transaction.js";
import { hashValue } from "../../core/hash.js";
import { ok, type Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { estimateProductContextTokens } from "./context-budget.js";
import type { ProductWorkContext } from "./context-types.js";

/**
 * Every `work` reply names its context pack with a short `contextId`. A worker that still has
 * that reply in view may pass it back (`work --known <contextId>`, MCP `known`): reference
 * sections unchanged since then are left out of the new reply. Without it, or when the slice's
 * contract changed, the full pack is sent. Only the worker can know what is still in its view,
 * so omission is never VISP's guess. The request, outcomes, scope, checks, findings, feedback
 * and next step are in every reply.
 */

/** Reference sections a worker may already hold from an earlier reply. */
const REPEATABLE = [
  "files",
  "examples",
  "decisions",
  "acceptanceBaseline",
  "projectMemory",
] as const;
type Repeatable = (typeof REPEATABLE)[number];

interface ContextRecord {
  readonly id: string;
  readonly task: string;
  readonly contractDigest: string;
  readonly sections: Partial<Record<Repeatable, string>>;
}

/** The latest packs per feature a worker may name; an older id gets the full pack again. */
const KEPT_RECORDS = 20;

export interface PlannedContext {
  readonly context: ProductWorkContext;
  /** Records this pack's id, so a later `--known` can name it. */
  readonly mutation: FileMutation;
}

export async function planContext(
  workspace: WorkspaceState,
  context: ProductWorkContext,
  contractDigest: string,
  known?: string,
): Promise<Result<PlannedContext>> {
  const sections = sectionDigests(context);
  const id = hashValue({ task: context.task, contractDigest, sections }).slice(0, 12);
  const path = join(workspace.paths.sessionDir, "contexts", `${context.feature}.json`);
  const before = await workspace.files.readTextIfExists(path);
  if (!before.ok) return before;
  const records = parseRecords(before.value);
  const record: ContextRecord = { id, task: context.task, contractDigest, sections };
  const kept = [...records.filter((entry) => entry.id !== id), record].slice(-KEPT_RECORDS);
  const mutation: FileMutation = {
    kind: "write",
    path,
    content: `${JSON.stringify(kept, null, 2)}\n`,
    expectedBefore: filePrecondition(before.value),
  };
  const full = { ...context, contextId: id };
  const previous = known ? records.find((entry) => entry.id === known) : undefined;
  if (!previous || previous.task !== context.task || previous.contractDigest !== contractDigest)
    return ok({ context: full, mutation });
  const unchanged = REPEATABLE.filter(
    (section) =>
      sections[section] !== undefined && sections[section] === previous.sections[section],
  );
  if (unchanged.length === 0) return ok({ context: full, mutation });
  return ok({ context: withoutSections(full, previous.id, unchanged), mutation });
}

/** Digests of the non-empty reference sections; an empty one costs nothing to resend. */
function sectionDigests(context: ProductWorkContext): Partial<Record<Repeatable, string>> {
  const digests: Partial<Record<Repeatable, string>> = {};
  for (const section of REPEATABLE) {
    const value = context[section];
    if (Array.isArray(value) && value.length > 0) digests[section] = hashValue(value);
  }
  return digests;
}

function withoutSections(
  context: ProductWorkContext,
  known: string,
  unchanged: readonly Repeatable[],
): ProductWorkContext {
  const reduced: ProductWorkContext = {
    ...context,
    ...Object.fromEntries(unchanged.map((section) => [section, []])),
    delivery: { known, unchanged },
  };
  const priced = { ...reduced, budget: { ...reduced.budget, estimatedTokens: 0 } };
  return {
    ...priced,
    budget: { ...priced.budget, estimatedTokens: estimateProductContextTokens(priced) },
  };
}

function parseRecords(text: string | undefined): ContextRecord[] {
  if (text === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  } catch {
    // A damaged list only means a named context gets the full pack.
    return [];
  }
}

function isRecord(value: unknown): value is ContextRecord {
  const entry = value as Partial<ContextRecord> | null;
  return (
    typeof entry?.id === "string" &&
    typeof entry.task === "string" &&
    typeof entry.contractDigest === "string" &&
    typeof entry.sections === "object" &&
    entry.sections !== null
  );
}
