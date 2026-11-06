// The JSON schema Codex must answer a review in (`codex exec --output-schema`). Structured
// output needs every property listed as required and no extra properties, so optional fields
// are nullable instead; reviewBody() drops the nulls to get a review@1 body.

const nullable = (type) => ({ type: [type, "null"] });
const strict = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

export const REVIEW_OUTPUT_SCHEMA = strict({
  status: { type: "string", enum: ["done", "blocked"] },
  body: strict({
    verdict: { type: "string", enum: ["approve", "changes_requested"] },
    findings: {
      type: "array",
      items: strict({
        id: { type: "string" },
        severity: { type: "string", enum: ["blocking", "advisory"] },
        cites: nullable("string"),
        text: { type: "string" },
        file: nullable("string"),
        line: nullable("integer"),
        evidence_command: nullable("string"),
      }),
    },
    clauses: {
      type: "array",
      items: strict({
        clause: { type: "string" },
        status: { type: "string", enum: ["delivered", "partial", "missing"] },
        note: nullable("string"),
      }),
    },
    unrequested: { type: "array", items: { type: "string" } },
    uncaptured: { type: "array", items: { type: "string" } },
  }),
});

export function reviewBody(body) {
  return {
    verdict: body.verdict,
    findings: body.findings.map(({ evidence_command: command, ...finding }) => ({
      ...withoutNulls(finding),
      ...(command ? { evidence: { command } } : {}),
    })),
    clauses: body.clauses.map(withoutNulls),
    unrequested: body.unrequested,
    uncaptured: body.uncaptured,
  };
}

function withoutNulls(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null));
}
