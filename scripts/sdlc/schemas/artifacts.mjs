// What each pipeline stage hands back. An agent returns only `body`; the SubagentStop hook adds
// the envelope from its own input and the transcript, so no envelope field is self-reported.

import { z } from "zod";
import { clauseId, featureId, taskId, testCaseId } from "./spec.mjs";

const envelope = z.object({
  id: z.string().min(1),
  feature: featureId,
  task: taskId.optional(),
  agent: z.string().min(1),
  agent_id: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  // The commit the report covers: the coder's head at handoff, the head the reviewer saw.
  commit: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  created_at: z.string().datetime({ offset: true }),
  intent_hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  inputs: z.array(z.string()).optional(),
  status: z.enum(["done", "blocked", "failed"]),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      cache_read_tokens: z.number().int().nonnegative(),
      cache_write_tokens: z.number().int().nonnegative(),
    })
    .partial()
    .optional(),
});

const artifact = (type, body) => envelope.extend({ schema: z.literal(`${type}@1`), body }).strict();

const command = z.object({ run: z.string().min(1), exit_code: z.number().int() }).strict();

export const handoffSchema = artifact(
  "handoff",
  z
    .object({
      summary: z.string().min(1),
      changed_files: z.array(z.string().min(1)),
      tests: z.array(z.object({ case: testCaseId, test: z.string().min(1) }).strict()),
      commands: z.array(command).optional(),
      notes: z.string().optional(),
    })
    .strict(),
);

// A blocking finding must cite what it enforces (a clause, a criterion, a standing rule or a
// defect class) and carry a command that shows the problem, which the orchestrator re-runs.
const finding = z
  .object({
    id: z.string().min(1),
    severity: z.enum(["blocking", "advisory"]),
    cites: z.string().min(1).optional(),
    text: z.string().min(1),
    file: z.string().optional(),
    line: z.number().int().positive().optional(),
    evidence: z
      .object({ command: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.severity !== "blocking") return;
    if (!value.cites) ctx.addIssue({ code: "custom", path: ["cites"], message: "required" });
    if (!value.evidence) ctx.addIssue({ code: "custom", path: ["evidence"], message: "required" });
  });

export const reviewSchema = artifact(
  "review",
  z
    .object({
      verdict: z.enum(["approve", "changes_requested"]),
      findings: z.array(finding),
      clauses: z
        .array(
          z
            .object({
              clause: clauseId,
              status: z.enum(["delivered", "partial", "missing"]),
              note: z.string().optional(),
            })
            .strict(),
        )
        .optional(),
      unrequested: z.array(z.string()).optional(),
      uncaptured: z.array(z.string()).optional(),
    })
    .strict(),
);

export const qeReportSchema = artifact(
  "qe-report",
  z
    .object({
      verdict: z.enum(["pass", "fail"]),
      cases: z.array(
        z
          .object({
            id: testCaseId,
            result: z.enum(["pass", "fail", "skipped"]),
            evidence: z.string().optional(),
            test: z.string().min(1).optional(),
          })
          .strict(),
      ),
      sentry_events: z.number().int().nonnegative().optional(),
    })
    .strict(),
);

export const worklogSchema = artifact(
  "worklog",
  z
    .object({
      event: z.string().min(1),
      summary: z.string().min(1),
      duration_ms: z.number().int().nonnegative().optional(),
    })
    .strict(),
);
