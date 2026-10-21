import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCriticPolicy } from "../../config/critic-defaults.js";
import type { WorkspaceState } from "../state.js";
import {
  CLAUDE_HOSTS,
  reachesModel,
  runClaudeStructured,
  runCodexStructured,
} from "./critic/critic-exec.js";

/** The reviewer VISP launches, whose model also reads rules and chooses memories. */
export interface ReviewerModel {
  readonly launch: "codex-exec" | "claude-exec";
  readonly model: string;
}

/**
 * The model of the reviewer VISP launches (`critic.launch: codex-exec` or `claude-exec`).
 * Only codex-exec was read, so under claude-exec (bench batch co1) no rule was read by a model
 * and no earlier decision reached a later feature. A reviewer the host runs gives VISP no
 * model of its own to call: VISP launches a model only where the project lets it.
 */
export async function reviewerModel(workspace: WorkspaceState): Promise<ReviewerModel | undefined> {
  const launch = workspace.config.critic?.launch;
  if (launch !== "codex-exec" && launch !== "claude-exec") return undefined;
  const critic = await resolveCriticPolicy(workspace.config.harness, workspace.config.critic);
  const model = critic.ok ? critic.value.config?.model : undefined;
  return model ? { launch, model } : undefined;
}

export interface ReviewerModelOptions {
  readonly executable?: string;
  /** Resolves a model endpoint; injectable so tests need no network. */
  readonly lookup?: (host: string) => Promise<unknown>;
}

/**
 * One low-effort structured answer from the reviewer's model. The model sees only the
 * prompt, in an empty temporary directory, never the repository.
 */
export async function askReviewerModel(
  reviewer: ReviewerModel,
  options: ReviewerModelOptions,
  request: {
    readonly name: string;
    readonly purpose: string;
    readonly schema: unknown;
    readonly prompt: string;
  },
): Promise<unknown> {
  const { lookup: dnsLookup } = await import("node:dns/promises");
  const lookup = options.lookup ?? ((host: string) => dnsLookup(host));
  const claude = reviewer.launch === "claude-exec";
  if (!(await reachesModel(lookup, claude ? CLAUDE_HOSTS : undefined)))
    throw new Error(`The ${request.purpose} cannot reach its model from this process`);
  const directory = await mkdtemp(join(tmpdir(), `${request.name}-`));
  try {
    const call = {
      ...(options.executable ? { executable: options.executable } : {}),
      root: directory,
      directory,
      model: reviewer.model,
      reasoningEffort: "low",
      schema: request.schema,
      prompt: request.prompt,
      signal: AbortSignal.timeout(90_000),
    };
    return await (claude ? runClaudeStructured(call) : runCodexStructured(call));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
