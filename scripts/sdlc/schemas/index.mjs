// Picks the schema a document names in its `schema` field and checks the document against it.

import { handoffSchema, qeReportSchema, reviewSchema, worklogSchema } from "./artifacts.mjs";
import {
  acceptanceSchema,
  intentSchema,
  taskSchema,
  testCasesSchema,
  testLinksSchema,
} from "./spec.mjs";

const SCHEMAS = {
  "intent@1": intentSchema,
  "acceptance@1": acceptanceSchema,
  "test-cases@1": testCasesSchema,
  "task@1": taskSchema,
  "test-links@1": testLinksSchema,
  "handoff@1": handoffSchema,
  "review@1": reviewSchema,
  "qe-report@1": qeReportSchema,
  "worklog@1": worklogSchema,
};

export function validateDocument(doc) {
  const name = doc && typeof doc === "object" ? doc.schema : undefined;
  const schema = SCHEMAS[name];
  if (!schema) {
    const known = Object.keys(SCHEMAS).join(", ");
    return { ok: false, errors: [`unknown schema "${name}"; known: ${known}`] };
  }
  const result = schema.safeParse(doc);
  if (result.success) return { ok: true, value: result.data };
  const errors = result.error.issues.map(
    (issue) => `${issue.path.join(".") || "(document)"}: ${issue.message}`,
  );
  return { ok: false, errors };
}
