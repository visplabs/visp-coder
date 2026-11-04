// The feature issue's body: the owner's words between sdlc:owner-text markers, written once by
// /feature, and the spec between sdlc:spec markers, written by the qe-spec stop hook with a
// generated Mermaid mind map of clause -> criterion -> test case.

import { stringify } from "yaml";

const OWNER = ["<!-- sdlc:owner-text -->", "<!-- /sdlc:owner-text -->"];
const SPEC = ["<!-- sdlc:spec -->", "<!-- /sdlc:spec -->"];

export function newFeatureBody(ownerText) {
  return [
    "## The owner's words",
    "",
    "Recorded verbatim by `/feature`. Agents never edit this section.",
    "",
    OWNER[0],
    ownerText,
    OWNER[1],
    "",
    "## Spec",
    "",
    SPEC[0],
    "_No spec yet. The qe-spec agent writes it here; the owner approves it with `/approve`._",
    SPEC[1],
    "",
  ].join("\n");
}

export function ownerTextOf(body) {
  const text = (body ?? "").replace(/\r\n/g, "\n");
  const start = text.indexOf(`${OWNER[0]}\n`);
  const end = text.indexOf(`\n${OWNER[1]}`);
  if (start < 0 || end < start) return undefined;
  return text.slice(start + OWNER[0].length + 1, end);
}

export function withSpec(body, specMarkdown) {
  const text = (body ?? "").replace(/\r\n/g, "\n");
  const start = text.indexOf(SPEC[0]);
  const end = text.indexOf(SPEC[1]);
  const section = `${SPEC[0]}\n${specMarkdown}\n${SPEC[1]}`;
  if (start < 0 || end < start) return `${text.trimEnd()}\n\n## Spec\n\n${section}\n`;
  return `${text.slice(0, start)}${section}${text.slice(end + SPEC[1].length)}`;
}

export function specMarkdown(feature, title, spec) {
  const yaml = (doc) => ["```yaml", stringify(doc).trimEnd(), "```"].join("\n");
  return [
    "### Mind map",
    "",
    "```mermaid",
    mindmap(feature, title, spec),
    "```",
    "",
    "### Intent clauses",
    "",
    yaml(spec.intent),
    "",
    "### Acceptance criteria",
    "",
    yaml(spec.acceptance),
    "",
    "### Test cases",
    "",
    yaml(spec.testCases),
  ].join("\n");
}

function mindmap(feature, title, { intent, acceptance, testCases }) {
  const lines = ["mindmap", `  root((${label(`${feature} ${title}`)}))`];
  for (const clause of intent.clauses) {
    lines.push(`    ${label(`${clause.id} ${clause.kind}: ${clause.text}`)}`);
    for (const criterion of acceptance.criteria.filter((c) => c.clauses.includes(clause.id))) {
      lines.push(`      ${label(`${criterion.id} ${criterion.expect}`)}`);
      for (const testCase of testCases.cases.filter((tc) => tc.criteria.includes(criterion.id))) {
        lines.push(`        ${label(`${testCase.id} ${testCase.title}`)}`);
      }
    }
  }
  return lines.join("\n");
}

// Mermaid reads brackets, quotes and backticks as shape syntax; keep labels plain and short.
function label(text) {
  const plain = text
    .replace(/[()[\]{}"`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > 70 ? `${plain.slice(0, 67)}...` : plain;
}
