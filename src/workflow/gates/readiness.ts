import { PRODUCT_NAME } from "../../core/constants.js";
import { type VispError, vispError } from "../../core/errors.js";
import { repositoryRequiredError } from "../../core/git.js";
import { err, ok, type Result } from "../../core/result.js";
import { buildFoundationContext, type FoundationContext, type WorkspaceState } from "../state.js";

export type FoundationState = FoundationContext;

/**
 * The implementation bridge is fail-closed. Context and handoff expose an
 * actionable coding brief, so they must not run before the surface that can
 * enforce it.
 */
export async function requireImplementationFoundation(
  state: WorkspaceState,
  recovery: string,
): Promise<Result<void>> {
  const context = await buildFoundationContext(state);
  if (!context.ok) return context;
  const blocked = implementationFoundationError(context.value, recovery);
  return blocked ? err(blocked) : ok(undefined);
}

/**
 * A feature starts from a committed project baseline. When Git cannot be written, so the
 * earlier work can never be committed, or when `acceptedOwner` names the accepted feature
 * whose work every uncommitted change is, the uncommitted files it starts from are returned
 * for the caller to record as the feature's inherited starting state. Nothing is committed
 * or discarded for the worker.
 */
export async function requireFeatureFoundation(
  state: WorkspaceState,
  recovery: string,
  acceptedOwner?: (changed: readonly string[]) => Promise<string | undefined>,
): Promise<Result<{ readonly inherited: readonly string[]; readonly acceptedFeature?: string }>> {
  const context = await buildFoundationContext(state, { probeGit: true });
  if (!context.ok) return context;
  const blockers = foundationBlockers(context.value, recovery, true);
  const changed = context.value.changedFiles ?? [];
  if (acceptedOwner && blockers.length === 1 && blockers[0]?.requirement === "clean-baseline") {
    const acceptedFeature = await acceptedOwner(changed);
    if (acceptedFeature) return ok({ inherited: changed, acceptedFeature });
  }
  const blocked = featureFoundationError(context.value, recovery);
  return blocked ? err(blocked) : ok({ inherited: inheritedChangedFiles(context.value) });
}

/** Uncommitted files a feature must inherit because Git cannot be written to commit them. */
export function inheritedChangedFiles(context: FoundationState): readonly string[] {
  return context.gitWritable === false ? (context.changedFiles ?? []) : [];
}

export function featureFoundationError(
  context: FoundationState,
  recovery: string,
): VispError | undefined {
  return combinedFoundationError(foundationBlockers(context, recovery, true));
}

export function implementationFoundationError(
  context: FoundationState,
  recovery: string,
): VispError | undefined {
  return combinedFoundationError(foundationBlockers(context, recovery));
}

export interface FoundationBlocker {
  readonly requirement: "repository" | "harness" | "enforcement" | "baseline" | "clean-baseline";
  readonly error: VispError;
}

/** Report every known prerequisite without making one failed check hide the next. */
export function foundationBlockers(
  context: FoundationState,
  recovery: string,
  cleanBaseline = false,
): FoundationBlocker[] {
  const blockers: FoundationBlocker[] = [];
  if (context.repositoryAvailable === false) {
    blockers.push({ requirement: "repository", error: repositoryRequiredError() });
  }
  if (context.harnessInstalled === false) {
    blockers.push({
      requirement: "harness",
      error: vispError(
        "STAGE_BLOCKED",
        "The Visp workflow is unavailable until the selected coding harness is installed",
        { recovery: `${PRODUCT_NAME} install` },
      ),
    });
  }
  if (context.enforcementInstalled === false) {
    blockers.push({
      requirement: "enforcement",
      error: vispError(
        "STAGE_BLOCKED",
        "No installed local hook can enforce task scope; assets-only or CI-only installation cannot authorize coding",
        { recovery: `${PRODUCT_NAME} install` },
      ),
    });
  }
  if (context.hasBaseline === false) {
    blockers.push({
      requirement: "baseline",
      error: vispError(
        "STAGE_BLOCKED",
        "The Visp workflow needs a committed before-tree for scope and evidence checks",
        { recovery: `git commit the project baseline, then ${recovery}` },
      ),
    });
  }
  // Only committable changes need committing: where Git is read-only, as in Codex's
  // sandbox, the commit is impossible and the changes are inherited instead.
  if (
    cleanBaseline &&
    (context.changedFiles?.length ?? 0) > 0 &&
    inheritedChangedFiles(context).length === 0
  ) {
    blockers.push({
      requirement: "clean-baseline",
      error: vispError(
        "STAGE_BLOCKED",
        "A feature must start from a committed baseline, but the working tree has uncommitted changes and Git accepts writes here. They may be earlier work, so commit them; do not discard them with git checkout, restore or reset. If the commit fails, fix what is fixable (an unset author identity with git config user.name and user.email, or a failing hook) and commit again; stop and tell the user only when Git reports a read-only or permission error. Never discard the changes to get past it",
        {
          recovery: `git add -A && git commit -m "<what these changes are>", then ${recovery}`,
          details: { changedFiles: context.changedFiles },
        },
      ),
    });
  }
  return blockers;
}

function combinedFoundationError(blockers: readonly FoundationBlocker[]): VispError | undefined {
  const first = blockers[0]?.error;
  if (!first) return undefined;
  return {
    ...first,
    message:
      blockers.length === 1
        ? first.message
        : [
            "Workflow setup is incomplete. Resolve these known requirements together:",
            ...blockers.map(
              ({ requirement, error }) =>
                `- ${requirement}: ${error.message} Recovery: ${error.recovery}`,
            ),
            "Complete installation before committing the reviewed project baseline.",
          ].join("\n"),
    details: {
      ...first.details,
      mayEdit: false,
      blockers: blockers.map(({ requirement, error }) => ({
        requirement,
        message: error.message,
        recovery: error.recovery,
        ...error.details,
      })),
    },
  };
}
