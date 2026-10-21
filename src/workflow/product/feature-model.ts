import type { RiskLevel } from "../../core/constants.js";
import type { Intent } from "../artifacts/feature.js";
import type { ProductBrief } from "./model.js";
import type { FeatureProfile } from "./profile.js";
import type { ProjectRule } from "./project-rules.js";

export interface ProductFeatureOptions {
  readonly goal: string;
  readonly sourceBrief?: string;
  readonly riskLevel?: RiskLevel;
  readonly branch?: boolean;
}

export interface ProductFeatureOutcome {
  readonly brief: ProductBrief;
  readonly intent: Intent;
  readonly projectRules?: readonly ProjectRule[];
  readonly projectMemory?: readonly string[];
  /** Commits made after the recalled requests were given, listed with the memory. */
  readonly projectMemoryLaterChanges?: readonly string[];
  readonly branchCreated?: string;
  readonly branchWarning?: string;
  readonly redactionNotice?: string;
  readonly hostHooksWarning?: string;
  /** Uncommitted files the feature started from: Git cannot be written, or they are an accepted feature's work. */
  readonly inheritedChanges?: readonly string[];
  readonly inheritedChangesNote?: string;
  /** The earlier feature that already records this request; no second feature was created. */
  readonly duplicateOf?: string;
  readonly duplicateNote?: string;
  /** Set by `visp feature` when its tester is writing tests in the same process, or was refused. */
  readonly testsNote?: string;
  /** The workflow profile the feature starts with, and why it is full. */
  readonly profile?: FeatureProfile;
  /** The requirements the request states, as `R001: <statement>`, each to be accounted for at `done`. */
  readonly requirements?: readonly string[];
  readonly requirementsNote?: string;
  /** Lean draft-first start: the command that authorizes the draft, and why. */
  readonly draftCommand?: string;
  readonly draftNote?: string;
}
