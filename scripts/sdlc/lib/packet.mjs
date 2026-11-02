// Renders the owner packet: one page with each intent clause and its status, the problems the
// trace found, what each stage reported, advisory findings, and the tokens spent.

export function renderPacket({ feature, spec, hash, report, artifacts, invalid }) {
  const tokens = artifacts.reduce(
    (sum, artifact) =>
      sum + (artifact.usage?.input_tokens ?? 0) + (artifact.usage?.output_tokens ?? 0),
    0,
  );
  return [
    `# Owner packet: ${feature} — ${spec.source.title}`,
    "",
    `Spec hash: \`${hash}\``,
    `Spec from ${spec.source.issue}, updated ${spec.source.updated_at}.`,
    "",
    "## Clauses",
    "",
    "| Clause | Kind | Status | Criteria | Text |",
    "| --- | --- | --- | --- | --- |",
    ...report.clauses.map(
      (clause) =>
        `| ${clause.id} | ${clause.kind} | ${clause.status} | ${clause.criteria.join(", ") || "none"} | ${cell(clause.text)} |`,
    ),
    "",
    "## Problems",
    "",
    ...orNone([
      ...report.problems.map(
        (problem) => `- ${problem.severity} ${problem.kind}: ${problem.message}`,
      ),
      ...invalid.map((file) => `- error invalid report: ${file.path}: ${file.errors.join("; ")}`),
    ]),
    "",
    "## Stage reports",
    "",
    ...orNone(artifacts.map(stageLine)),
    "",
    "## Advisory findings",
    "",
    ...orNone(artifacts.flatMap(advisoryLines)),
    "",
    `Usage: ${tokens.toLocaleString("en-US")} tokens across ${artifacts.length} stage reports.`,
    "",
  ].join("\n");
}

function stageLine(artifact) {
  const outcome = artifact.body.verdict ?? artifact.status;
  return `- ${artifact.task ?? "feature"} ${artifact.agent}: ${outcome} (${artifact.schema}, ${artifact.created_at})`;
}

function advisoryLines(artifact) {
  if (artifact.schema !== "review@1") return [];
  return artifact.body.findings
    .filter((finding) => finding.severity === "advisory")
    .map((finding) => {
      const where = finding.file
        ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})`
        : "";
      return `- ${artifact.task ?? "feature"} ${finding.id}: ${finding.text}${where}`;
    });
}

function orNone(lines) {
  return lines.length > 0 ? lines : ["None."];
}

function cell(text) {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
