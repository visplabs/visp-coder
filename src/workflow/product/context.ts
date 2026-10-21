import { matchesAny } from "../../core/patterns.js";
import { ok, type Result } from "../../core/result.js";
import {
  isIndexableProjectPath,
  openProjectStore,
  type QueryRow,
  refreshRepository,
} from "../../graph/index.js";
import { featureMemories } from "../../memory/memory-service.js";
import { recordActivity } from "../../orchestrate/session.js";
import { checkOutputNotes } from "../product-output-guidance.js";
import type { WorkspaceState } from "../state.js";
import { productBehaviorProbes } from "./behavior-probes.js";
import { fitProductContext } from "./context-budget.js";
import { queryCurrentProductPaths } from "./context-graph.js";
import type { ProductWorkContext } from "./context-types.js";
import { correctionChecks, failedCheckOwners } from "./corrections.js";
import { reviewerPointer } from "./critic/critic-capacity.js";
import { currentJourneyFailures, currentJourneyFeedback } from "./evidence-references.js";
import { productFeedbackPlan } from "./feedback.js";
import { productInputWarnings } from "./input-warnings.js";
import { checksFor, type ProductSlice } from "./model.js";
import { type ProjectRule, readProjectRules } from "./project-rules.js";
import { reviewExcerpt } from "./review/review-excerpts.js";
import { productSkills } from "./skills.js";
import { briefPath, type ProductRecord, productStatePath } from "./store.js";
import { productContractDigest, productSourceDigest } from "./subject.js";
import { reviewerRules } from "./tester/pinned-dispute-model.js";
import { userFeedbackPlan } from "./user-feedback.js";

export async function buildProductContext(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice,
  snapshot: Record<string, string>,
  mayEdit: boolean,
  refresh: boolean,
): Promise<Result<ProductWorkContext>> {
  const { brief } = record;
  const subject = await productSourceDigest(workspace, brief, snapshot);
  if (!subject.ok) return subject;
  const checks = [
    ...new Map(
      [...checksFor(brief, slice), ...correctionChecks(record, slice, subject.value)].map(
        (check) => [check.id, check],
      ),
    ).values(),
  ];
  const feedbackPlan = productFeedbackPlan(
    record,
    subject.value,
    slice,
    workspace.config.workflow.reviewMode,
    {
      reviewer: await reviewerPointer(workspace, brief.feature, subject.value, slice.id),
      requiredOnly: workspace.config.workflow.requestGaps === "required",
    },
  );
  const question = [
    feedbackPlan.trace.question,
    feedbackPlan.research?.question ?? "",
    slice.goal,
    brief.originalRequest,
    ...productBehaviorProbes(record, slice).probes.map((probe) => probe.question),
  ].join(" ");
  // The problem is already delivered in findings; do not repeat its full prose in routing hints.
  for (const finding of feedbackPlan.findings) {
    feedbackPlan.trace.question = feedbackPlan.trace.question.replace(finding.problem, finding.id);
    if (feedbackPlan.research)
      feedbackPlan.research.question = feedbackPlan.research.question.replace(
        finding.problem,
        finding.id,
      );
    feedbackPlan.gaps = feedbackPlan.gaps.filter((gap) => !gap.startsWith(`${finding.id}:`));
  }
  const paths = Object.keys(snapshot)
    .filter((path) =>
      matchesAny(path, [...slice.scope.allowed, ...checks.flatMap((check) => check.files)]),
    )
    .sort((a, b) => Number(question.includes(b)) - Number(question.includes(a)));
  const neighborhood = await productNeighborhood(workspace, paths, refresh, question);
  if (!neighborhood.ok) return neighborhood;
  const { graph, notes } = neighborhood.value;
  const excerptPaths = paths.filter(usefulExcerptPath).sort(
    (a, b) =>
      excerptScore(
        b,
        question,
        graph,
        checks.flatMap((check) => check.files),
      ) -
      excerptScore(
        a,
        question,
        graph,
        checks.flatMap((check) => check.files),
      ),
  );
  notes.unshift(...(await productInputWarnings(workspace, brief)));
  notes.push(...checkOutputNotes(checks));
  const { files, remaining } = await productExcerpts(workspace, excerptPaths, question);
  if (excerptPaths.length > files.length)
    notes.push("Context is bounded; read additional relevant files when needed.");
  const skills = await productSkills(workspace, slice, remaining, excerptPaths);
  if (!skills.ok) return skills;
  const rules = await readProjectRules(workspace);
  const recalled = await featureMemories(workspace, brief.feature);
  notes.push(...skills.value.notes);
  return ok(
    fitProductContext(
      {
        skills: skills.value.skills,
        feedbackPlan,
        userFeedback: userFeedbackPlan(workspace, record, slice, subject.value),
        feature: brief.feature,
        task: slice.id,
        ...(slice.taskClass === undefined ? {} : { taskClass: slice.taskClass }),
        originalRequest: brief.originalRequest,
        ...standingContext(rules, recalled),
        objective: slice.goal,
        outcomes: brief.outcomes.filter((outcome) => slice.outcomes.includes(outcome.id)),
        examples: brief.examples.filter((example) =>
          example.outcomes.some((id) => slice.outcomes.includes(id)),
        ),
        decisions: brief.decisions.filter(
          (decision) =>
            decision.outcomes.length === 0 ||
            decision.outcomes.some((id) => slice.outcomes.includes(id)),
        ),
        uncertainties: brief.uncertainties,
        scope: slice.scope,
        checks,
        files,
        graph,
        notes,
        mayEdit,
        subjectDigest: subject.value,
        reviewFeedback: priorReviewFeedback(record, slice, subject.value),
        acceptanceBaseline: brief.acceptanceBaseline,
        journeyFailures: currentJourneyFailures(record, subject.value, slice.id),
        journeyFeedback: currentJourneyFeedback(
          record,
          subject.value,
          slice.id,
          reviewerRules(workspace),
        ),
        feedback: [
          ...new Map(
            record.state.executions
              .filter(
                (execution) =>
                  execution.task === slice.id ||
                  (!execution.task &&
                    (checks.some((check) => check.id === execution.check) ||
                      failedCheckOwners(record, execution).some((owner) => owner.id === slice.id))),
              )
              .map((execution) => [JSON.stringify([execution.check, execution.task]), execution]),
          ).values(),
        ]
          .filter((execution) => execution.status !== "passed")
          .map((execution) => ({
            check: execution.check,
            status: execution.status,
            output: execution.output,
            current:
              execution.subjectDigest === subject.value &&
              execution.contractDigest ===
                productContractDigest(
                  brief,
                  execution.task
                    ? brief.slices.find((entry) => entry.id === execution.task)
                    : undefined,
                ),
          })),
      },
      workspace.config.context.tokenBudget,
      [
        workspace.paths.relative(briefPath(workspace, brief.feature)) ?? "brief.yaml",
        workspace.paths.relative(productStatePath(workspace, brief.feature)) ??
          "product-state.json",
      ],
    ),
  );
}

function usefulExcerptPath(path: string): boolean {
  return (
    !path.split("/").some((part) => part.startsWith(".")) &&
    !["AGENTS.visp.md", "VISP.commands.md"].includes(path.split("/").at(-1) ?? "")
  );
}

function excerptScore(
  path: string,
  question: string,
  graph: QueryRow[],
  checkFiles: string[],
): number {
  return (
    Number(question.includes(path)) * 5 +
    Number(checkFiles.includes(path)) * 4 +
    graph.reduce(
      (score, row) => score + (row.path === path ? (row.kind === "entrypoint" ? 3 : 1) : 0),
      0,
    )
  );
}

export async function productNeighborhood(
  workspace: WorkspaceState,
  paths: string[],
  refresh: boolean,
  question?: string,
): Promise<Result<{ graph: QueryRow[]; notes: string[] }>> {
  const graph: QueryRow[] = [];
  const notes: string[] = [];
  if (refresh && paths.some(isIndexableProjectPath)) {
    const indexed = await refreshRepository(
      workspace.paths.root,
      workspace.config.graph,
      workspace.paths.graphStore,
    );
    if (!indexed.ok)
      notes.push(
        `Graph unavailable: ${indexed.error.message}. Inspect the relevant files directly.`,
      );
    else
      await recordActivity(workspace, {
        command: "index --refresh",
        outcome: "ok",
        detail: `Automatic product context refresh: ${indexed.value.counts.entities} entities, ${indexed.value.counts.relations} relations`,
      });
  }
  const exists = await workspace.files.exists(workspace.paths.graphStore);
  if (!exists.ok) {
    notes.push(`Graph unavailable: ${exists.error.message}. Inspect the relevant files directly.`);
    return ok({ graph, notes });
  }
  if (exists.value) {
    const store = await openProjectStore(workspace.files, workspace.paths.graphStore, {
      writable: false,
    });
    if (store.ok) {
      try {
        const context = await queryCurrentProductPaths(workspace, store.value, paths, question);
        graph.push(...context.graph);
        notes.push(...context.notes);
      } finally {
        store.value.close();
      }
    } else
      notes.push(`Graph unavailable: ${store.error.message}. Inspect the relevant files directly.`);
  }
  if (!graph.length)
    notes.push(
      "Graph has no relevant declarations or links. Inspect the delivered code directly; refresh through work after implementation exists.",
    );
  return ok({ graph, notes });
}

async function productExcerpts(workspace: WorkspaceState, paths: string[], question: string) {
  const files: Array<{ path: string; content: string; truncated: boolean }> = [];
  let remaining = Math.min(workspace.config.context.tokenBudget * 4, 24000);
  for (const path of paths.slice(0, workspace.config.context.maxSnippets)) {
    if (remaining <= 0) break;
    const metadata = await workspace.files.metadata(path);
    if (!metadata.ok || metadata.value?.type !== "file") continue;
    const content = await workspace.files.readTextIfExists(path);
    if (!content.ok || !content.value || content.value.includes("\0")) continue;
    const excerpt = (await reviewExcerpt(path, content.value, question, Math.min(remaining, 6000)))
      .excerpt;
    files.push({ path, content: excerpt, truncated: excerpt.length < content.value.length });
    remaining -= excerpt.length;
  }
  return { files, remaining };
}

function priorReviewFeedback(
  record: ProductRecord,
  slice: ProductSlice,
  subject: string,
): ProductWorkContext["reviewFeedback"] {
  return record.state.reviews
    .filter(
      (review) =>
        review.assessments.some((assessment) => slice.outcomes.includes(assessment.outcome)) ||
        ((review.task === slice.id || (!review.task && record.brief.slices.length === 1)) &&
          (review.feedback?.summary || review.feedback?.limitations?.length)),
    )
    .slice(-3)
    .map((review, index, recent) => ({
      subjectDigest: review.subjectDigest,
      current:
        review.subjectDigest === subject &&
        review.contractDigest ===
          productContractDigest(
            record.brief,
            review.task ? record.brief.slices.find((entry) => entry.id === review.task) : undefined,
          ),
      assessments: review.assessments
        .filter(
          (assessment) =>
            slice.outcomes.includes(assessment.outcome) &&
            (assessment.status !== "satisfied" ||
              assessment.expectations.some((entry) => entry.status !== "satisfied")),
        )
        .map((assessment) => ({
          ...assessment,
          expectations: assessment.expectations.filter((entry) => entry.status !== "satisfied"),
        })),
      summary: index === recent.length - 1 ? review.feedback?.summary : undefined,
      limitations: review.feedback?.limitations,
    }))
    .filter((review) => review.assessments.length || review.summary || review.limitations?.length);
}

/**
 * Rules and recorded decisions the request carries, shown on every reply. An unreadable
 * rules file fails `visp feature` and `visp rules`; work goes on without it.
 */
function standingContext(
  rules: Result<{ rules: ProjectRule[] }>,
  memory: { memories: readonly string[]; laterChanges: readonly string[] },
): {
  projectRules?: readonly ProjectRule[];
  projectMemory?: readonly string[];
  projectMemoryLaterChanges?: readonly string[];
} {
  return {
    ...(rules.ok && rules.value.rules.length ? { projectRules: rules.value.rules } : {}),
    ...(memory.memories.length ? { projectMemory: memory.memories } : {}),
    ...(memory.memories.length && memory.laterChanges.length
      ? { projectMemoryLaterChanges: memory.laterChanges }
      : {}),
  };
}
