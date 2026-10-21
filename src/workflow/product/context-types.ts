import type { QueryRow } from "../../graph/index.js";
import type { criticUnderstanding } from "./critic/critic-understanding.js";
import type { currentJourneyFeedback } from "./evidence-references.js";
import type { productFeedbackPlan } from "./feedback.js";
import type { ProductAssessment, ProductBrief, ProductSlice } from "./model.js";
import type { ProductNext } from "./status.js";

export interface ProductContextContent {
  readonly next?: ProductNext;
  /** Current product-review routing, after any recorded observations. */
  readonly criticAdvice?: ProductNext["criticAdvice"];
  readonly criticUnderstanding?: Extract<
    Awaited<ReturnType<typeof criticUnderstanding>>,
    { ok: true }
  >["value"];
  /** Acceptance tests an independent tester wrote from the original request. */
  readonly independentTests?: import("./tester/independent-tests-model.js").IndependentTestsSummary;
  readonly userFeedback?: ReturnType<typeof import("./user-feedback.js").userFeedbackPlan>;
  readonly feedbackPlan?: ReturnType<typeof productFeedbackPlan>;
  readonly feature: string;
  readonly task: string;
  readonly taskClass?: ProductSlice["taskClass"];
  readonly originalRequest: string;
  /** Rules the user stated for all later work; never trimmed by the context budget. */
  readonly projectRules?: readonly import("./project-rules.js").ProjectRule[];
  /** Recorded decisions from earlier features that the reviewer's model selected for this request. */
  readonly projectMemory?: readonly string[];
  /** Commits made after those decisions were recorded; the code wins where they differ. */
  readonly projectMemoryLaterChanges?: readonly string[];
  readonly objective: string;
  readonly outcomes: ProductBrief["outcomes"];
  readonly examples: ProductBrief["examples"];
  readonly decisions: ProductBrief["decisions"];
  readonly uncertainties: readonly string[];
  readonly scope: ProductSlice["scope"];
  readonly checks: ProductBrief["checks"];
  readonly files: readonly { path: string; content: string; truncated: boolean }[];
  readonly graph: readonly QueryRow[];
  readonly notes: readonly string[];
  readonly mayEdit: boolean;
  readonly subjectDigest: string;
  readonly skills: readonly {
    path: string;
    content: string;
    truncated: boolean;
    reason: "skill";
    advisory: true;
  }[];
  readonly reviewFeedback: readonly {
    subjectDigest: string;
    current: boolean;
    assessments: readonly ProductAssessment[];
    summary?: string;
    limitations?: readonly string[];
  }[];
  readonly acceptanceBaseline?: ProductBrief["acceptanceBaseline"];
  readonly journeyFailures?: readonly string[];
  readonly journeyFeedback?: ReturnType<typeof currentJourneyFeedback>;
  readonly feedback: readonly {
    check: string;
    status: string;
    output: string;
    current: boolean;
    truncated?: boolean;
  }[];
  /** Names this pack, so a later `work --known <contextId>` can leave out what is unchanged. */
  readonly contextId?: string;
  /** Reference sections left out: unchanged since the reply the worker named with `--known`. */
  readonly delivery?: { readonly known: string; readonly unchanged: readonly string[] };
}

export interface ProductWorkContext extends ProductContextContent {
  readonly budget: {
    readonly tokenBudget: number;
    readonly estimatedTokens: number;
    readonly status: "within-budget" | "essential-overflow";
    readonly omitted: {
      readonly files: number;
      readonly graphRows: number;
      readonly skills: number;
      readonly feedbackCharacters: number;
      readonly probes?: number;
      readonly observationGuidance?: boolean;
    };
    readonly sources: readonly string[];
  };
}
