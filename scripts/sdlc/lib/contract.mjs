// The task contract the agent-contract hook appends to a task agent's prompt: the owner's words,
// the clauses and criteria the task serves, the role's rules and the report it must hand back.

import { CODERS } from "./agents.mjs";

export function renderContract(agentType, spec, task) {
  const criteria = spec.acceptance.criteria.filter((c) => task.criteria.includes(c.id));
  const clauseIds = new Set(criteria.flatMap((criterion) => criterion.clauses));
  const clauses = spec.intent.clauses.filter((clause) => clauseIds.has(clause.id));
  const cases = spec.testCases.cases.filter((testCase) =>
    testCase.criteria.some((id) => task.criteria.includes(id)),
  );
  return [
    "## SDLC contract",
    "",
    "Added by the agent-contract hook. Where it and the rest of this prompt differ, it wins.",
    "",
    "### The owner's words",
    "",
    ...quote(spec.intent.owner_text),
    "",
    "### Intent clauses this task serves",
    "",
    ...clauses.map((clause) => `- ${clause.id} (${clause.kind}): ${clause.text}`),
    "",
    "### Acceptance criteria",
    "",
    ...criteria.map(
      (c) =>
        `- ${c.id} [${c.clauses.join(", ")}] (${c.level}) Given ${c.given}; when ${c.when}; expect ${c.expect}.`,
    ),
    "",
    "### Test cases",
    "",
    ...cases.map(
      (tc) => `- ${tc.id} [${tc.criteria.join(", ")}] ${tc.title}${tc.test ? ` (${tc.test})` : ""}`,
    ),
    "",
    ...roleRules(agentType, task),
  ].join("\n");
}

// The contract for qe-spec: the owner's words and the three spec blocks it must hand back.
export function renderSpecContract(feature, ownerText) {
  return [
    "## SDLC contract",
    "",
    "Added by the agent-contract hook. Where it and the rest of this prompt differ, it wins.",
    "",
    "### The owner's words",
    "",
    ...quote(ownerText),
    "",
    "### Your report",
    "",
    "End your final message, or your SubagentHandback report, with three yaml blocks:",
    `\`schema: intent@1\`, \`schema: acceptance@1\` and \`schema: test-cases@1\`, each with`,
    `\`feature: ${feature}\`. In intent@1, \`owner_text\` is the owner's words above, character for`,
    "character. The stop hook validates the blocks, checks that every must clause has a criterion",
    "and every criterion a test case, and writes them into the feature issue with a generated mind",
    "map for the owner to approve. If it refuses the report, fix what it says and report again.",
  ].join("\n");
}

function quote(text) {
  return text
    .trimEnd()
    .split("\n")
    .map((line) => `> ${line}`);
}

function roleRules(agentType, task) {
  if (CODERS.has(agentType)) return coderRules(task);
  if (agentType === "reviewer") return reviewerRules();
  return qeVerifyRules();
}

function coderRules(task) {
  return [
    "### Your job",
    "",
    `You may change only: ${task.scope.paths.join(", ")}. Hooks refuse other paths.`,
    "Write unit and integration tests that cover the branches of the code you change. In your",
    "report, link every unit and integration test case above to the test that checks it, as",
    "`<path> > <describe titles> > <test title>`. The stop hook runs each linked test and refuses",
    "a name it cannot find or a test that does not pass.",
    "",
    ...reportRules("handoff@1", [
      "status: done",
      "body:",
      "  summary: What changed and why, in one or two sentences",
      "  changed_files: [src/x.ts, tests/unit/x.test.ts]",
      "  tests:",
      "    - { case: TC-01, test: 'tests/unit/x.test.ts > x > does y' }",
      "  notes: Anything the reviewer should know (optional)",
    ]),
  ];
}

function reviewerRules() {
  return [
    "### Your job",
    "",
    "Read the owner's words first, then the criteria, then the diff of this task's branch.",
    "A blocking finding must cite a clause, criterion or standing-rule id in `cites` and give a",
    "command in `evidence` that shows the problem; the orchestrator re-runs it. Every other",
    "finding is advisory and goes to the owner, not the coder.",
    "For each clause say delivered, partial or missing. List work no clause asked for under",
    "`unrequested`, and requirements in the owner's words no clause captured under `uncaptured`.",
    "",
    ...reportRules("review@1", [
      "status: done",
      "body:",
      "  verdict: changes_requested",
      "  findings:",
      "    - id: R-1",
      "      severity: blocking",
      "      cites: AC-01",
      "      text: The stop hook writes two files",
      "      evidence: { command: 'pnpm exec vitest run tests/unit/x.test.ts' }",
      "  clauses: [{ clause: I-01, status: partial }]",
      "  unrequested: []",
      "  uncaptured: []",
    ]),
  ];
}

function qeVerifyRules() {
  return [
    "### Your job",
    "",
    "Run every test case above, including journeys, and record each result with its evidence.",
    "Give each journey and performance case the test that runs it in `test`.",
    "",
    ...reportRules("qe-report@1", [
      "status: done",
      "body:",
      "  verdict: pass",
      "  cases: [{ id: TC-01, result: pass, evidence: 'pnpm exec vitest run ...', test: 'tests/x.test.ts > x > y' }]",
      "  sentry_events: 0",
    ]),
  ];
}

function reportRules(schema, example) {
  return [
    "### Your report",
    "",
    "End your final message, or your SubagentHandback report, with exactly one yaml block that",
    `holds \`status\` (done, blocked or failed) and a \`body\` matching ${schema}. The stop hook`,
    "validates it, checks it and files it. If it refuses the report, fix what it says and report",
    "again. Example:",
    "",
    "```yaml",
    ...example,
    "```",
  ];
}
