import * as publicApi from "../../src/index.js";

// Breaking 0.5 boundary: callers choose read-only context or authorized work explicitly.
// @ts-expect-error Removed mutation alias; use runProductWork.
void publicApi.authorizeImplement;
// @ts-expect-error Removed ambiguous context alias; use runProductContext or runProductWork.
void publicApi.buildContextPack;
// @ts-expect-error Removed acceptance alias; use runProductAccept.
void publicApi.runProductAcceptance;
// @ts-expect-error Removed fixed legacy templates; project skills were removed later.
void publicApi.proposeFailureSkills;
// @ts-expect-error Removed with project skills: no context pack carries skills.
void publicApi.createProposalFromContent;
// @ts-expect-error Removed with project skills.
void publicApi.transitionSkill;
// @ts-expect-error Removed with project skills.
void publicApi.skillSelectionSnapshot;
// @ts-expect-error Removed with project skills.
void publicApi.rollbackSkill;
// @ts-expect-error Removed with project skills.
void publicApi.readSkillHistory;
// @ts-expect-error Removed with project skills.
void publicApi.readSkillRevision;
// @ts-expect-error Removed with project skills.
void publicApi.recordSkillEvaluation;
// @ts-expect-error Removed with project skills.
void publicApi.promoteSkill;
// @ts-expect-error Removed with project skills.
void publicApi.checkSkillEvaluation;
// @ts-expect-error Removed with project skills.
void publicApi.readSkillEvaluation;
// @ts-expect-error Removed with project skills.
void publicApi.skillPreregistrationSchema;
// @ts-expect-error Removed legacy stage inspection; use runProductNext/runProductStatus.
void publicApi.evaluateGate;
// @ts-expect-error Removed legacy gate rendering; use runProductReport.
void publicApi.renderGateResult;
// @ts-expect-error Removed legacy artifact context; use runProductContext.
void publicApi.buildGateContext;
// @ts-expect-error Removed uncalled legacy journal writer; the product loop records executions.
void publicApi.recordAttempt;
// @ts-expect-error Removed uncalled legacy journal writer; the product loop records executions.
void publicApi.recordCheck;
// @ts-expect-error Removed legacy evidence quarantine archiving with evidence compaction.
void publicApi.archiveEvidenceQuarantine;
// @ts-expect-error Removed legacy evidence quarantine restore with evidence compaction.
void publicApi.restoreEvidenceQuarantine;

async function supportedProductCalls(root: string, feature: string, task: string) {
  const workspace = await publicApi.loadWorkspace(root);
  if (!workspace.ok) return;
  await publicApi.runProductContext(workspace.value, { feature, task });
  await publicApi.runProductWork(workspace.value, { feature, task });
  await publicApi.runProductAccept(workspace.value, { feature });
}
void supportedProductCalls;

function currentContextConfig(config: publicApi.VispConfig) {
  void config.context.tokenBudget;
  void config.context.maxSnippets;
  // @ts-expect-error Removed ignored context ranking control in 0.5.
  void config.context.ranking;
  // @ts-expect-error Removed ignored snippet cap in 0.5.
  void config.context.snippetCap;
  // @ts-expect-error Removed ignored snippet line limit in 0.5.
  void config.context.maxSnippetLines;
  // @ts-expect-error Removed ignored stored snippet switch in 0.5.
  void config.context.includeSnippets;
  // @ts-expect-error Removed ignored region limit in 0.5.
  void config.context.maxRegionsPerFile;
}
void currentContextConfig;

function currentGraphConfig(config: publicApi.VispConfig) {
  void config.graph.languages;
  void config.graph.exclude;
  void config.graph.maxFileBytes;
  // @ts-expect-error Query depth belongs to the query request, not project config.
  void config.graph.queryDepth;
  // @ts-expect-error Query results belong to the query request, not project config.
  void config.graph.queryResults;
}
void currentGraphConfig;

function currentWorkflowConfig(config: publicApi.VispConfig) {
  void config.workflow.maxChangedFiles;
  // @ts-expect-error Retired legacy gate-only setting.
  void config.workflow.requireTests;
  // @ts-expect-error Removed inactive source-file length control in 0.5.
  void config.workflow.maxSourceFileLines;
  // @ts-expect-error Removed inactive source-line length control in 0.5.
  void config.workflow.maxSourceLineChars;
}
void currentWorkflowConfig;
