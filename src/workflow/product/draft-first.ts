import { cliCommand } from "../next-action.js";
import type { WorkspaceState } from "../state.js";
import { checksFor, type ProductBrief, type ProductSlice } from "./model.js";

/**
 * Lean mode's draft-first start (`workflow.draftFirst: visual`). In October picture runs with a
 * Haiku 5.5 worker, VISP's first drafts were about half the size of bare drafts (pagoda
 * generators 244 vs 357 lines), VISP commands took 43% of worker turns, and bare work won the
 * pairwise comparison 9–4. A picture request therefore gets one whole-request slice and edit
 * rights at `visp work` with no check, brief or slice plan first; the worker declares its check
 * after the draft, and review starts at `visp done`.
 */

const PICTURE =
  /\b(?:svgs?|pngs?|pixel[- ]art|voxels?|illustrations?|drawings?|paintings?|pictures?|images?|posters?|logos?|icons?|sprites?|artwork|isometric|scenes?)\b/i;
const APPLICATION =
  /\b(?:games?|apps?|applications?|websites?|web ?pages?|servers?|apis?|endpoints?|cli|command[- ]line|librar(?:y|ies)|engines?|repository|codebase|database|forms?|dashboards?|plugins?|extensions?)\b/i;

/** A request for a picture itself (a drawing, a render, a chart image), not an app that draws. */
export function visualRequest(request: string): boolean {
  return PICTURE.test(request) && !APPLICATION.test(request);
}

function draftFirstRequest(workspace: WorkspaceState, brief: ProductBrief): boolean {
  return workspace.config.workflow.draftFirst === "visual" && visualRequest(brief.originalRequest);
}

/** A picture feature with no slices yet: bare `visp work` starts the draft. */
export function draftFirstApplies(workspace: WorkspaceState, brief: ProductBrief): boolean {
  return !brief.slices.length && draftFirstRequest(workspace, brief);
}

/** The draft slice before its check is declared: it may be authorized without one. */
export function draftSlice(
  workspace: WorkspaceState,
  brief: ProductBrief,
  slice: ProductSlice,
): boolean {
  return (
    brief.slices.length === 1 &&
    slice.scope.allowed.length === 1 &&
    slice.scope.allowed[0] === "**" &&
    !checksFor(brief, slice).length &&
    draftFirstRequest(workspace, brief)
  );
}

export const DRAFT_SLICE_GOAL = "Deliver the original request: draft the whole picture first";

export function draftObjective(): string {
  return "Draft first: write the whole picture now, in one pass, with every part, object and look the request names, at full size and detail. No brief, slice plan or tests are needed before the draft. When it is complete and renders, declare the command that renders or checks it, then run visp done; VISP's review starts there";
}

export function draftCheckCommand(feature: string): string {
  return cliCommand("work", {
    feature,
    check: { quoted: "<command that renders or checks the picture>" },
  });
}

export function draftStartCommand(feature: string): string {
  return cliCommand("work", { feature });
}

export function draftStartNote(feature: string): string {
  return `A picture request: ${draftStartCommand(feature)} authorizes the whole request at once. Draft the whole picture before any test, brief or slice plan.`;
}
