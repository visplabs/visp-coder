// Follows each intent clause to its acceptance criteria, their test cases and, when test results
// are given, the result of each linked test. Errors block a merge; warnings go to the owner.

import { relative, sep } from "node:path";

const NEEDS_CRITERIA = new Set(["must", "should"]);

export function trace(spec, results) {
  const { clauses } = spec.intent;
  const { criteria } = spec.acceptance;
  const { cases } = spec.testCases;
  const caseStatus = new Map(cases.map((tc) => [tc.id, testStatus(tc, results)]));
  const criterionStatus = new Map(
    criteria.map((criterion) => [criterion.id, criterionState(criterion, cases, caseStatus)]),
  );
  const clauseReport = clauses.map((clause) =>
    clauseState(clause, criteria, criterionStatus, results),
  );
  const problems = [
    ...duplicates("clause", clauses),
    ...duplicates("criterion", criteria),
    ...duplicates("test case", cases),
    ...criterionProblems(criteria, clauses, cases),
    ...caseProblems(cases, criteria),
    ...resultProblems(cases, caseStatus, results),
    ...gapProblems(clauseReport),
  ];
  const criteriaReport = criteria.map((criterion) => ({
    id: criterion.id,
    status: criterionStatus.get(criterion.id),
  }));
  return { problems, clauses: clauseReport, criteria: criteriaReport };
}

// Keys a vitest JSON report (`--reporter=json`) as "<path> > <describe titles> > <title>".
export function resultsIndex(report, root) {
  const index = new Map();
  for (const file of report.testResults ?? []) {
    const path = relative(root, file.name).split(sep).join("/");
    for (const test of file.assertionResults ?? []) {
      index.set([path, ...(test.ancestorTitles ?? []), test.title].join(" > "), test.status);
    }
  }
  return index;
}

function testStatus(testCase, results) {
  if (!testCase.test) return "unlinked";
  if (!results) return "linked";
  return results.get(testCase.test) ?? "not found";
}

function criterionState(criterion, cases, caseStatus) {
  const statuses = cases
    .filter((testCase) => testCase.criteria.includes(criterion.id))
    .map((testCase) => caseStatus.get(testCase.id));
  if (statuses.length === 0) return "untested";
  if (statuses.every((status) => status === "passed")) return "passing";
  if (statuses.every((status) => status === "linked" || status === "unlinked")) return "planned";
  return "not passing";
}

function clauseState(clause, criteria, criterionStatus, results) {
  const linked = criteria.filter((criterion) => criterion.clauses.includes(clause.id));
  const base = { id: clause.id, kind: clause.kind, text: clause.text };
  const ids = linked.map((criterion) => criterion.id);
  if (linked.length === 0) {
    const status = NEEDS_CRITERIA.has(clause.kind) ? "missing" : "not applicable";
    return { ...base, status, criteria: ids };
  }
  const states = ids.map((id) => criterionStatus.get(id));
  if (!results) {
    const planned = states.every((state) => state === "planned" || state === "passing");
    return { ...base, status: planned ? "planned" : "open", criteria: ids };
  }
  const passing = states.filter((state) => state === "passing").length;
  const status = passing === states.length ? "delivered" : passing > 0 ? "partial" : "open";
  return { ...base, status, criteria: ids };
}

function duplicates(label, items) {
  const seen = new Set();
  const problems = [];
  for (const { id } of items) {
    if (seen.has(id)) problems.push(error("duplicate", `${label} ${id} appears more than once`));
    seen.add(id);
  }
  return problems;
}

function criterionProblems(criteria, clauses, cases) {
  const clauseIds = new Set(clauses.map((clause) => clause.id));
  const covered = new Set(cases.flatMap((testCase) => testCase.criteria));
  const problems = [];
  for (const criterion of criteria) {
    if (criterion.clauses.length === 0) {
      problems.push(
        error("scope", `${criterion.id} cites no intent clause; the owner must approve it`),
      );
    }
    for (const id of criterion.clauses.filter((clause) => !clauseIds.has(clause))) {
      problems.push(error("dangling", `${criterion.id} cites unknown clause ${id}`));
    }
    if (!covered.has(criterion.id)) {
      problems.push(error("untested", `${criterion.id} has no test case`));
    }
  }
  return problems;
}

function caseProblems(cases, criteria) {
  const criterionIds = new Set(criteria.map((criterion) => criterion.id));
  return cases.flatMap((testCase) =>
    testCase.criteria
      .filter((id) => !criterionIds.has(id))
      .map((id) => error("dangling", `${testCase.id} cites unknown criterion ${id}`)),
  );
}

function resultProblems(cases, caseStatus, results) {
  if (!results) return [];
  const notPassing = cases
    .filter((testCase) => testCase.test && caseStatus.get(testCase.id) !== "passed")
    .map((testCase) => `${testCase.id} (${caseStatus.get(testCase.id)}: ${testCase.test})`);
  const unlinked = cases.filter((testCase) => !testCase.test).map((testCase) => testCase.id);
  const problems = [];
  if (notPassing.length > 0) {
    problems.push(error("failing", `linked tests not passing: ${notPassing.join(", ")}`));
  }
  if (unlinked.length > 0) {
    problems.push(warning("unlinked", `test cases with no test yet: ${unlinked.join(", ")}`));
  }
  return problems;
}

function gapProblems(clauseReport) {
  return clauseReport
    .filter((clause) => clause.status === "missing")
    .map((clause) =>
      clause.kind === "must"
        ? error("gap", `must clause ${clause.id} has no acceptance criterion`)
        : warning("gap", `should clause ${clause.id} has no acceptance criterion`),
    );
}

function error(kind, message) {
  return { severity: "error", kind, message };
}

function warning(kind, message) {
  return { severity: "warning", kind, message };
}
