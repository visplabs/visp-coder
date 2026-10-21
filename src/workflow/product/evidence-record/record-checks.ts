import { describeProductCheck, productCheckSupportsBehavior } from "../check/check-command.js";
import type { ProductCheck, ProductExecution } from "../model.js";
import type { CheckEvidence } from "./record-types.js";

export interface CheckRuns {
  /** The latest run of the check per slice on the current version of the product. */
  readonly current: readonly ProductExecution[];
  /** Every recorded run of the check, on any version. */
  readonly all: readonly ProductExecution[];
}

export interface CheckContext {
  readonly author: CheckEvidence["author"];
  readonly record: string;
}

/**
 * A check's result as a reviewer may rely on it. Only a run on the current version can
 * report `passed`; an older run makes the check `stale`, whatever that run returned.
 */
export function checkEvidence(
  check: ProductCheck,
  runs: CheckRuns,
  context: CheckContext,
): CheckEvidence {
  const base = {
    check: check.id,
    author: context.author,
    exercisesBehavior: productCheckSupportsBehavior(check),
    command: describeProductCheck(check),
    record: context.record,
  };
  const deciding = decidingRun(runs.current);
  if (deciding) {
    const flip = deciding.flip?.failsWithoutChange;
    return {
      ...base,
      result: deciding.status,
      ...(typeof flip === "boolean" ? { failsWithoutChange: flip } : {}),
      ranAt: deciding.createdAt,
      exitCode: deciding.exitCode,
      durationMs: deciding.durationMs,
      execution: deciding.id,
    };
  }
  const last = runs.all.findLast((run) => run.check === check.id);
  return last
    ? { ...base, result: "stale", ranAt: last.createdAt }
    : { ...base, result: "not-run" };
}

/** A failure in any slice decides, then any other non-pass, then the newest pass. */
function decidingRun(current: readonly ProductExecution[]): ProductExecution | undefined {
  return (
    current.find((run) => run.status === "failed") ??
    current.find((run) => run.status !== "passed") ??
    current.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)
  );
}
