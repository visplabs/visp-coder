import type { WorkspaceState } from "../../state.js";
import type { ProductOutcomeStatus } from "../assessment.js";
import { REVIEWER_ACTIVITY_FILE } from "../critic/critic-exec.js";
import { readFeatureDiff } from "../feature-diff.js";
import { unchangedInheritedPaths } from "../inherited-changes.js";
import { readRegressionGate } from "../regression/regression-report.js";
import type { ProductNext } from "../status.js";
import type { ProductRecord } from "../store.js";
import { readTestsRecord } from "../tester/independent-tests-record.js";
import { TESTER_ACTIVITY_FILE, testerNetworkCommands } from "../tester/tester-activity.js";
import { buildEvidenceRecord } from "./record-build.js";
import { evidenceChanges } from "./record-changes.js";
import type { EvidenceRecord } from "./record-types.js";

/** Reads what the record needs: git, the tester and gate records and the activity logs. */
export async function productEvidenceRecord(
  workspace: WorkspaceState,
  record: ProductRecord,
  outcomes: readonly ProductOutcomeStatus[],
  subject: string,
  next: ProductNext,
): Promise<EvidenceRecord> {
  const feature = record.brief.feature;
  const readAt = new Date().toISOString();
  const [tests, report, diff, earlierWork, reviewer, tester, networkCommands] = await Promise.all([
    readTestsRecord(workspace, feature),
    readRegressionGate(workspace, feature),
    readFeatureDiff(workspace, feature),
    unchangedInheritedPaths(workspace, feature),
    activityEntries(workspace, feature, REVIEWER_ACTIVITY_FILE),
    activityEntries(workspace, feature, TESTER_ACTIVITY_FILE),
    testerNetworkCommands(workspace, feature),
  ]);
  return buildEvidenceRecord({
    record,
    subject,
    outcomes,
    next,
    ...(tests.ok && tests.value ? { tests: tests.value } : {}),
    gate: {
      mode: workspace.config.workflow.regressionGate,
      ...(report ? { report } : {}),
    },
    changes: evidenceChanges(record, diff, earlierWork, workspace.overrides, readAt),
    activity: {
      reviewerLaunched: reviewer.length,
      // A tester launched by the host, or by a build before the log, leaves only its record.
      testerSessions: Math.max(tester.length, tests.ok && tests.value ? 1 : 0),
    },
    outsideAccess: {
      webSearches: reviewer.flatMap((entry) =>
        (entry.webSearches ?? []).map((query) => ({ at: entry.at ?? "", query })),
      ),
      testerNetworkCommands: networkCommands.reduce(
        (sum, session) => sum + session.commands.length,
        0,
      ),
    },
    readAt,
  });
}

/** One entry per session in VISP's reviewer or tester log; unreadable lines still count. */
async function activityEntries(
  workspace: WorkspaceState,
  feature: string,
  file: string,
): Promise<{ at?: string; webSearches?: string[] }[]> {
  const text = await workspace.files.readTextIfExists(workspace.paths.featureFile(feature, file));
  if (!text.ok || !text.value) return [];
  return text.value
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        const entry = JSON.parse(line) as { at?: unknown; webSearches?: unknown };
        return {
          ...(typeof entry.at === "string" ? { at: entry.at } : {}),
          ...(Array.isArray(entry.webSearches)
            ? { webSearches: entry.webSearches.filter((query) => typeof query === "string") }
            : {}),
        };
      } catch {
        return {};
      }
    });
}
