// The feature spec kept in the feature's GitHub issue: the owner's intent, the acceptance
// criteria and the test cases, each a fenced YAML block whose `schema` line names its type.
// Ids are local to a feature: clauses I-01, criteria AC-01, test cases TC-01.

import { z } from "zod";

// A Jira issue key (VISP-12). F-12 and T-13, the GitHub issue form, still match until CI reads
// Jira.
export const workKey = /^[A-Z][A-Z0-9]*-\d+$/;
export const featureId = z.string().regex(workKey, "expected the epic's Jira key, like VISP-12");
export const taskId = z.string().regex(workKey, "expected the task's Jira key, like VISP-13");
export const clauseId = z.string().regex(/^I-\d{2,}$/, "expected I-01 style id");
export const criterionId = z.string().regex(/^AC-\d{2,}$/, "expected AC-01 style id");
export const testCaseId = z.string().regex(/^TC-\d{2,}$/, "expected TC-01 style id");

const clause = z
  .object({
    id: clauseId,
    text: z.string().min(1),
    kind: z.enum(["must", "should", "must_not", "out_of_scope"]),
    verbatim: z.boolean().optional(),
  })
  .strict();

export const intentSchema = z
  .object({
    schema: z.literal("intent@1"),
    feature: featureId,
    owner_text: z.string().min(1),
    clauses: z.array(clause).min(1),
  })
  .strict();

const criterion = z
  .object({
    id: criterionId,
    clauses: z.array(clauseId),
    given: z.string().min(1),
    when: z.string().min(1),
    // "then" in Given/When/Then; named so a parsed object is never a thenable.
    expect: z.string().min(1),
    level: z.enum(["unit", "integration", "journey", "performance", "manual"]),
  })
  .strict();

export const acceptanceSchema = z
  .object({
    schema: z.literal("acceptance@1"),
    feature: featureId,
    criteria: z.array(criterion).min(1),
  })
  .strict();

const testCase = z
  .object({
    id: testCaseId,
    title: z.string().min(1),
    criteria: z.array(criterionId).min(1),
    technique: z
      .enum(["example", "boundary", "equivalence", "state", "error", "performance", "journey"])
      .optional(),
    // "<path from repository root> > <describe titles> > <test title>", once the test exists.
    test: z.string().min(1).optional(),
  })
  .strict();

export const testCasesSchema = z
  .object({
    schema: z.literal("test-cases@1"),
    feature: featureId,
    cases: z.array(testCase).min(1),
  })
  .strict();

// A task sub-issue of the feature: the criteria it delivers and the paths its coder may edit.
// A scope path is a glob over files (glob.mjs); "docs/adr/" matches none, so name its files.
const scopePath = z
  .string()
  .min(1)
  .refine((path) => !path.endsWith("/"), {
    message: "a folder matches no file; write it as a glob, like docs/adr/**",
  });

export const taskSchema = z
  .object({
    schema: z.literal("task@1"),
    feature: featureId,
    task: taskId,
    criteria: z.array(criterionId).min(1),
    scope: z.object({ paths: z.array(scopePath).min(1) }).strict(),
    track: z.enum(["trivial", "standard", "complex"]),
    size: z.enum(["S", "M", "L"]),
    // Each re-plan by the manager (sdlc jira edit-task): when, what scope it added or removed,
    // and why. The owner packet lists them.
    changes: z
      .array(
        z
          .object({
            at: z.string().min(1),
            added: z.array(z.string()),
            removed: z.array(z.string()),
            why: z.string().min(1),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

// The tests that cover a task's test cases, kept in the task's Jira issue (never the epic, whose
// edits would void the owner's approval). The stop hook writes them from the coder's handoff and
// qe-verify's report; the CI gate and the trace read them over the spec's own links.
export const testLinksSchema = z
  .object({
    schema: z.literal("test-links@1"),
    feature: featureId,
    task: taskId,
    links: z.array(z.object({ case: testCaseId, test: z.string().min(1) }).strict()),
  })
  .strict();
