// The feature spec kept in the feature's GitHub issue: the owner's intent, the acceptance
// criteria and the test cases, each a fenced YAML block whose `schema` line names its type.
// Ids are local to a feature: clauses I-01, criteria AC-01, test cases TC-01.

import { z } from "zod";

export const featureId = z.string().regex(/^F-\d+$/, "expected F-<feature issue number>");
export const taskId = z.string().regex(/^T-\d+$/, "expected T-<task issue number>");
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
export const taskSchema = z
  .object({
    schema: z.literal("task@1"),
    feature: featureId,
    task: taskId,
    criteria: z.array(criterionId).min(1),
    scope: z.object({ paths: z.array(z.string().min(1)).min(1) }).strict(),
    track: z.enum(["trivial", "standard", "complex"]),
    size: z.enum(["S", "M", "L"]),
  })
  .strict();
