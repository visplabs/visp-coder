// Files the spec qe-spec drafted: its three yaml blocks must validate, keep the owner's words
// exactly, and trace (every must clause to a criterion, every criterion to a test case). Then the
// spec and a generated mind map replace the spec section of the feature issue. Returns why the
// spec was refused, or undefined once it is written.

import { ghJson, ghWithBody } from "./gh.mjs";
import { ownerTextOf, specMarkdown, withSpec } from "./issue-body.mjs";
import { pullFeature } from "./pull-feature.mjs";
import { specDocuments } from "./spec-store.mjs";
import { trace } from "./trace.mjs";

const MAX_BODY = 60_000;

export function fileSpec(cwd, feature, report) {
  const number = feature.slice(2);
  const issue = ghJson(["issue", "view", number, "--json", "title,body,updatedAt,url"]);
  const ownerText = ownerTextOf(issue.body);
  if (ownerText === undefined) return `issue #${number} has no owner's words section`;
  let docs;
  try {
    docs = specDocuments(report ?? "", feature);
  } catch (error) {
    return `the spec report is not complete: ${error.message}`;
  }
  if (docs["intent@1"].owner_text.trim() !== ownerText.trim()) {
    return "intent@1 owner_text must be exactly the owner's words in the feature issue, unchanged";
  }
  const spec = {
    intent: docs["intent@1"],
    acceptance: docs["acceptance@1"],
    testCases: docs["test-cases@1"],
  };
  const errors = trace(spec).problems.filter((problem) => problem.severity === "error");
  if (errors.length > 0) {
    return `the spec does not trace:\n- ${errors.map((e) => `${e.kind}: ${e.message}`).join("\n- ")}`;
  }
  const body = withSpec(issue.body, specMarkdown(feature, issue.title, spec));
  if (body.length > MAX_BODY) {
    return `the issue body would be ${body.length} characters (limit ${MAX_BODY}); split the feature`;
  }
  ghWithBody(["issue", "edit", number], body);
  pullFeature(feature, cwd);
  return undefined;
}
