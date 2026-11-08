// The links from a task's test cases to the tests that check them. The spec's test cases are
// written before the code exists, so their `test` fields are mostly empty; the coder and
// qe-verify name the tests in their reports, the stop hook checks them and keeps them as a
// test-links@1 block in the task's Jira issue. Readers lay those links over the spec's.

import { stringify } from "yaml";
import { validateDocument } from "../schemas/index.mjs";
import { yamlBlocks } from "./yaml-blocks.mjs";

const SCHEMA = "test-links@1";
export const CODER_LEVELS = new Set(["unit", "integration"]);
export const QE_LEVELS = new Set(["journey", "performance"]);

// The task's test cases whose criteria are at one of `levels`: the ones a stage must link.
export function casesToLink(spec, task, levels) {
  const owned = new Set(
    spec.acceptance.criteria
      .filter((c) => task.criteria.includes(c.id) && levels.has(c.level))
      .map((c) => c.id),
  );
  return spec.testCases.cases.filter((tc) => tc.criteria.some((id) => owned.has(id)));
}

// The test-links@1 block of a task issue body, or an empty one.
export function linksOf(body, feature, task) {
  const block = yamlBlocks(body ?? "").find((doc) => doc.schema === SCHEMA);
  if (!block) return { schema: SCHEMA, feature, task, links: [] };
  const result = validateDocument(block);
  if (!result.ok) throw new Error(`${task} ${SCHEMA} block: ${result.errors.join("; ")}`);
  return result.value;
}

// The body with its links merged with `added` (a newer link for a case replaces the older).
export function withLinks(body, feature, task, added) {
  const current = linksOf(body, feature, task);
  const byCase = new Map(current.links.map((link) => [link.case, link]));
  for (const link of added) byCase.set(link.case, { case: link.case, test: link.test });
  const links = [...byCase.values()].sort((a, b) => a.case.localeCompare(b.case));
  const block = `\`\`\`yaml\n${stringify({ schema: SCHEMA, feature, task, links }).trim()}\n\`\`\``;
  const fence = /```ya?ml[^\n]*\nschema: test-links@1[\s\S]*?```/;
  return fence.test(body) ? body.replace(fence, block) : `${body.trimEnd()}\n\n${block}\n`;
}

// Test cases with the tasks' links laid over the spec's own `test` fields.
export function applyLinks(cases, links) {
  const byCase = new Map(links.map((link) => [link.case, link.test]));
  return cases.map((tc) => (byCase.has(tc.id) ? { ...tc, test: byCase.get(tc.id) } : tc));
}
