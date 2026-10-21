import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const repository = resolve(import.meta.dirname, "..");
const scratch = await mkdtemp(join(tmpdir(), "visp-package-smoke-"));

try {
  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch],
      { cwd: repository, encoding: "utf8" },
    ),
  );
  const filename = packed[0]?.filename;
  if (!filename) throw new Error("npm pack did not report a package filename");

  // Exercise the same installation shape people use outside a repository.
  // Keeping the prefix inside the disposable smoke directory makes this a
  // real global install without touching the operator's configured prefix.
  const globalPrefix = join(scratch, "global-prefix");
  run(
    "npm",
    ["install", "--global", "--ignore-scripts", "--prefix", globalPrefix, join(scratch, filename)],
    repository,
  );
  const globalBin =
    process.platform === "win32"
      ? join(globalPrefix, "visp.cmd")
      : join(globalPrefix, "bin", "visp");
  if (!existsSync(globalBin)) throw new Error("temporary global install did not expose visp");
  const globalRunner = process.platform === "win32"
    ? join(globalPrefix, "visp-runner.cmd")
    : join(globalPrefix, "bin", "visp-runner");
  if (!existsSync(globalRunner)) throw new Error("temporary global install did not expose visp-runner");
  run(globalRunner, ["--help"], repository);

  const project = join(scratch, "consumer");
  await mkdir(project);
  await writeFile(join(project, "package.json"), '{"name":"visp-package-smoke","private":true}\n');
  await writeFile(join(project, ".gitignore"), "node_modules/\n");
  run("git", ["init", "-q", "-b", "main"], project);
  run("pnpm", ["add", "--ignore-scripts", join(scratch, filename)], project);

  const bin = join(project, "node_modules", ".bin", "visp");
  const runnerBin = join(project, "node_modules", ".bin", "visp-runner");
  // The Codex template launches the reviewer and tester with `codex exec`; a stub that
  // always fails keeps the smoke test from ever calling a model.
  const stubs = join(scratch, "stub-bin");
  await mkdir(stubs);
  await writeFile(join(stubs, "codex"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await writeFile(join(stubs, "codex.cmd"), "@exit /b 1\r\n");
  const env = { ...process.env, PATH: [join(project, "node_modules", ".bin"), stubs, process.env.PATH ?? ""].join(delimiter) };
  run(bin, ["init", "--harness", "codex"], project, env);
  run(bin, ["install", "--harness", "codex", "--dry-run"], project, env);
  run(bin, ["install", "--harness", "codex"], project, env);
  run(runnerBin, ["capabilities"], project, env);
  await writeFile(join(project, "consumer.mts"), `
import {
  taskRefSchema, taskRefKey, type TaskRef, loadWorkspace, runProductWork, runProductMigrate, productBriefSchema, productBriefInputSchema, assessmentSchema, productInputTemplate, productCheckSchema, coverageAssessmentSchema, runProductReviewerHandoff, productFeedbackSchema, runProductHostFeedback, runProductCritic, criticConfigSchema, type ProductCriticHost,
} from "@visporg/visp-coder";
import { GraphStore, queryGraph } from "@visporg/visp-coder/graph";
import * as publicApi from "@visporg/visp-coder";
// @ts-expect-error Fixed legacy templates were removed in the breaking 0.5 API.
void publicApi.proposeFailureSkills;
// @ts-expect-error Project skills were removed.
void publicApi.skillSelectionSnapshot;
// @ts-expect-error Legacy stage gates are removed from the breaking 0.5 API.
void publicApi.evaluateGate;
// @ts-expect-error Use current product reporting.
void publicApi.renderGateResult;
// @ts-expect-error Use current read-only product context.
void publicApi.buildGateContext;
// @ts-expect-error Evidence compaction and its quarantine archive were removed in 0.5.
void publicApi.archiveEvidenceQuarantine;
// @ts-expect-error Uncalled legacy journal writers were removed in 0.5.
void publicApi.recordAttempt;
void publicApi.runProductNext; void publicApi.runProductStatus;
void publicApi.runProductReport; void publicApi.runProductContext;
// @ts-expect-error Project skills were removed.
void publicApi.createProposalFromContent;
import { runnerSpecSchema, adapterFor, type RunnerSpec, type NormalizedUsage, prepareCriticComparison } from "@visporg/visp-coder/runner";
import { activateControl, assertRecovery, assertUiState, assertTransitions, assertBehaviorSensitive, assertCheckpoint, measureCanvasRegion, type UiStateContract, type InteractionPage, type EvidenceReference, openBrowserSession, runSupervisedControl } from "@visporg/visp-coder/testing";
import { browserJourneySchema, type BrowserJourneyResult, type RelativePoint, type ObservationCondition, type BrowserComparison } from "@visporg/visp-coder/testing";
const point: RelativePoint = {x:0.46,y:0.28};
const observation: ObservationCondition = {selector:'#launch',enabled:false};
const comparison: BrowserComparison = {kind:"compare",left:{selector:"#hud"},right:{selector:"#result"},relation:"equal",mode:"number",capture:false};
const journey = browserJourneySchema.parse({url:'http://127.0.0.1:3000/', actions:[{kind:'move',selector:'canvas',position:point},{kind:'wait-for',...observation},comparison,{kind:'drag',selector:'canvas',to:{x:10,y:10},input:'touch',cancel:true}]});
const result: BrowserJourneyResult | undefined = undefined; void result; void journey; void productFeedbackSchema; void runProductHostFeedback; void productInputTemplate; void productBriefInputSchema; void assessmentSchema;
void openBrowserSession; void runSupervisedControl; void coverageAssessmentSchema; void runProductReviewerHandoff;
void runProductCritic; void criticConfigSchema; void prepareCriticComparison;
import { runProductUserFeedback, type UserFeedbackHost } from "@visporg/visp-coder";
void runProductUserFeedback;
const userHost: UserFeedbackHost = { ask: async () => ({action:"defer"}) }; void userHost;
const criticHost: ProductCriticHost | undefined = undefined; void criticHost;
productCheckSchema.parse({id:"C_BROWSER", command:{kind:"browser-journey",journey},outcomes:[]});
void measureCanvasRegion;
const evidence: EvidenceReference = {criterion:'AC001', id:'ready', surface:'data'};
await assertCheckpoint({...evidence, sample:()=>4, verify:actual=>actual===4});
await assertBehaviorSensitive({label:'result', baseline:()=>4, changed:()=>0, verify:actual=>actual===4});
void assertUiState; void assertTransitions; void assertBehaviorSensitive;
const uiContract: UiStateContract = {name:'ready', viewport:{width:390,height:844}, controls:[{selector:'#retry'}]}; void uiContract;
void activateControl; void assertRecovery; const page: InteractionPage | undefined = undefined; void page;
const task: TaskRef = taskRefSchema.parse({ feature: "001-smoke", task: "T001" });
const key: string = taskRefKey(task);
const state = await loadWorkspace(process.cwd());
if (state.ok) { void runProductWork; void runProductMigrate; void productBriefSchema; void state.value.config; }
const graph = GraphStore.open(":memory:");
if (graph.ok) { queryGraph(graph.value, "describe"); graph.value.close(); }
const spec: RunnerSpec = runnerSpecSchema.parse({});
void spec; void key; void adapterFor; const usage: NormalizedUsage | undefined = undefined; void usage;
`);
  // Resolve the packed public declarations as an actual downstream consumer.
  run(process.execPath, [
    join(repository, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "--strict",
    "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022",
    "--types", "node", "--typeRoots", join(repository, "node_modules", "@types"),
    join(project, "consumer.mts"),
  ], project, env);

  for (const path of [
    "AGENTS.md",
    "AGENTS.visp.md",
    "VISP.commands.md",
    ".agents/skills/visp/SKILL.md",
    ".codex/config.toml",
    ".git/hooks/pre-commit",
  ]) {
    if (!existsSync(join(project, path))) throw new Error(`packaged install did not create ${path}`);
  }

  const doctor = JSON.parse(run(bin, ["doctor", "--json"], project, env));
  const runtime = doctor.data?.runtime;
  if (!runtime || runtime.buildId === "dev" || !/^[a-f0-9]{16}$/.test(runtime.buildId)) {
    throw new Error("packaged doctor did not report a deterministic build id");
  }
  if (!runtime.executable.includes(join("node_modules", "@visporg", "visp-coder", "dist", "cli.js"))) {
    throw new Error(`doctor reported an unexpected executable: ${runtime.executable}`);
  }

  const globalDoctor = JSON.parse(
    run(globalBin, ["doctor", "--json"], project, {
      ...process.env,
      PATH: `${process.platform === "win32" ? globalPrefix : join(globalPrefix, "bin")}${delimiter}${process.env.PATH ?? ""}`,
    }),
  );
  const globalRuntime = globalDoctor.data?.runtime;
  if (
    !globalRuntime ||
    globalRuntime.version !== runtime.version ||
    globalRuntime.buildId !== runtime.buildId
  ) {
    throw new Error("local and temporary-global installs did not report the same packaged runtime");
  }

  const skill = readFileSync(join(project, ".agents/skills/visp/SKILL.md"), "utf8");
  if (!skill.includes("AGENTS.visp.md")) throw new Error("Codex skill does not point at the guide");
  const activation = readFileSync(join(project, "AGENTS.md"), "utf8");
  if (
    !activation.includes("AGENTS.visp.md") ||
    !activation.includes("visp:instructions:start")
  ) {
    throw new Error("packaged install did not activate the VISP project instructions");
  }
  // A packed consumer can reach the product loop without old stage artifacts.
  await writeFile(join(project, "value.mjs"), "export const value = 2;\n");
  await writeFile(join(project, "value.test.mjs"), "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from './value.mjs'; test('promised value',()=>assert.equal(value,2));\n");
  run("git", ["config", "user.email", "smoke@example.test"], project, env);
  run("git", ["config", "user.name", "Package Smoke"], project, env);
  run("git", ["add", "-A"], project, env);
  run("git", ["commit", "-qm", "consumer baseline"], project, env);
  // With the Codex template's launch: codex-exec, the tester and reviewer judge against the
  // verbatim request, so feature requires it as the source brief.
  const request = "Return two from the public module: value.mjs exports value = 2.";
  const started = JSON.parse(run(bin, ["feature", "Return two from the public module", "--source-brief", "-", "--json"], project, env, request));
  if (!started.data?.brief) throw new Error("Packaged feature did not return a brief");
  const brief = JSON.parse(run(bin,["brief","--template"],project,env));
  const updated = {
    ...brief,
    outcomes: [{id:"O001",kind:"functional",statement:"The public value is two",priority:"must",provenance:"user-stated"}],
    examples: [{id:"E001",title:"Read public value",given:["The public module is imported"],when:"Read its value export",expected:["The value is number two"],outcomes:["O001"]}],
    checks: [{id:"C001",command:[process.execPath,"--test","value.test.mjs"],outcomes:["O001"],files:["value.mjs","value.test.mjs"],environment:"node"}],
    slices: [{id:"T001",goal:"Return the promised value",outcomes:["O001"],scope:{allowed:["value.mjs","value.test.mjs"],expected:[],forbidden:[]},checks:["C001"]}],
  };
  run(bin,["brief","--from","-","--reason","Define the usable slice","--json"],project,env,JSON.stringify(updated));
  const earlyNext = JSON.parse(run(bin,["next","--json"],project,env));
  if (!earlyNext.data?.command?.startsWith("visp work ")) throw new Error("Packaged workflow inserted a mandatory design gate before scoped work");
  run(bin,["work","--task","T001","--json"],project,env);
  const criticStatus = JSON.parse(run(bin,["critic","--task","T001","--json"],project,env));
  if (criticStatus.data?.enabled !== true || criticStatus.data?.model !== "gpt-5.6-sol" || criticStatus.data?.reasoningEffort !== "medium") throw new Error("Fresh Codex feature did not pin the template's critic settings");
  const criticAgent = readFileSync(join(project, ".codex/agents/visp-critic.toml"), "utf8");
  if (!criticAgent.includes('model = "gpt-5.6-sol"')) throw new Error("Native critic definition missing");
  const criticPreflight = JSON.parse(run(bin,["critic","--task","T001","--preflight","--json"],project,env));
  if (criticPreflight.data?.ready !== false || criticPreflight.data?.callsUsed !== 0) throw new Error("Preflight must expose missing capabilities without spending calls");
  run(bin,["critic","--off","--json"],project,env);
  run(bin,["work","--task","T001","--json"],project,env);
  const criticOff = JSON.parse(run(bin,["critic","--task","T001","--json"],project,env));
  if (criticOff.data?.enabled !== false || criticOff.data?.callsUsed !== 0) throw new Error("Feature opt-out was not respected");
  run(bin,["critic","--on","--json"],project,env);
  const criticOn = JSON.parse(run(bin,["critic","--task","T001","--json"],project,env));
  if (criticOn.data?.enabled !== true || criticOn.data?.model !== "gpt-5.6-sol" || criticOn.data?.callsUsed !== 0) throw new Error("Feature opt-in lost the pinned policy");
  run(bin,["critic","--mode","both","--json"],project,env);
  const manual = JSON.parse(run(bin,["critic","feedback","--task","T001","--ask","Does this match your goal?","--json"],project,env));
  if (manual.data?.delivery !== "native-handoff" || manual.data?.status !== "pending") throw new Error("Standalone manual critic did not return a question handoff");
  const answer = JSON.parse(run(bin,["critic","feedback","--task","T001","--id",manual.data.id,"--reply","The first slice is useful; make the next result clearer.","--json"],project,env));
  if (answer.data?.status !== "answered" || answer.data?.provenance !== "caller-reported") throw new Error("Manual critic did not retain the user's reply");
  const manualWork = JSON.parse(run(bin,["work","--task","T001","--json"],project,env));
  if (manualWork.data?.userFeedback?.feedback[0]?.reply !== answer.data.reply) throw new Error("Manual feedback missing from actor work context");
  if (!readFileSync(join(project,"VISP.commands.md"),"utf8").includes("critic feedback")) throw new Error("Packaged command guide omits manual feedback");
  run(bin,["critic","--mode","auto","--json"],project,env);
  const preparedReview = JSON.parse(run(bin, ["review", "--prepare", "--task", "T001", "--json"], project, env));
  if (!preparedReview.data?.session || !existsSync(preparedReview.data.packetPath)) throw new Error("Packaged review session unavailable");
  const criticConfig = {model:"package-smoke-placeholder",maxCalls:1,timeoutMs:1000,maxImageBytes:1024};
  run(bin,["critic","--task","T001","--configure","-","--json"],project,env,JSON.stringify(criticConfig));
  const configuredCritic = JSON.parse(run(bin,["critic","--task","T001","--json"],project,env));
  if (configuredCritic.data?.callsUsed !== 0) throw new Error("Configuration or status dispatched a critic");
  let retiredDisable;
  try { run(bin,["critic","--task","T001","--disable","--json"],project,env); }
  catch (error) { if (!error.stdout) throw error; retiredDisable = JSON.parse(String(error.stdout)); }
  if (retiredDisable?.error?.code !== "WORKFLOW_REPLACED") throw new Error("Task-level disable bypass remains available");
  run(bin,["critic","--off","--json"],project,env);
  run(bin,["done","--task","T001","--json"],project,env);
  const review = JSON.parse(run(bin,["review","--template"],project,env));
  if (!review.feedback?.probes?.length || review.feedback.probes.some(row=>row.status!=="unclear")) throw new Error("Packaged probe template missing or invents satisfaction");
  if (review.assessments.some(row=>row.status!=="unclear")) throw new Error("Packaged review template invented satisfaction");
  const statePath = join(project,".visp","features",brief.feature,"product-state.json");
  const beforeHandoff = readFileSync(statePath,"utf8");
  const handoff = JSON.parse(run(bin,["review","--handoff","--json"],project,env));
  if (handoff.data?.dispatch?.owner !== "host" || !handoff.data?.challenges?.length) throw new Error("Packaged reviewer handoff lacks host dispatch and challenges");
  if (readFileSync(statePath,"utf8") !== beforeHandoff) throw new Error("Reviewer handoff modified state");
  const session = JSON.parse(run(bin,["review","--prepare","--json"],project,env)).data;
  const packet = JSON.parse(readFileSync(session.packetPath,"utf8"));
  if (packet.feedbackPlan || packet.previousFindings || !packet.responseSchema) throw new Error("Packaged independent response contract is missing or primed with worker verdicts");
  const evidence = packet.evidence.find(entry=>entry.kind==="execution" && entry.status==="available")?.id;
  if (!evidence) throw new Error("No current successful execution in the prepared session");
  const recorded = JSON.parse(run(bin,["review","--session",session.session,"--from","-","--json"],project,env,JSON.stringify({
    summary: "The executed import test observes the requested public value.",
    assessments: [{outcome:"O001",status:"satisfied",summary:"The public module exports two and the executed test checks it.",evidence:[evidence],expectations:[]}],
    findings: [], limitations: [], resolutions: [],
  })));
  if (!recorded.data?.recorded || "captureRuns" in recorded.data || "images" in recorded.data) throw new Error("Review submission did not return a compact receipt");
  // The assembled product is a separate selection; this offline smoke explicitly opts it out too.
  run(bin,["critic","--off","--json"],project,env);
  const accepted = JSON.parse(run(bin,["accept","--json"],project,env));
  if (!accepted.data?.passed) throw new Error("Packaged assembled-product acceptance failed");
  const concise = run(bin,["status"],project,env);
  const detail = run(bin,["status","--json"],project,env);
  if (concise.length >= detail.length / 2) throw new Error("Packaged status did not preserve concise default output");
  for (const file of ["research.json","spec.json","plan.json","tasks.json"]) {
    if (existsSync(join(project,".visp","features",brief.feature,file))) throw new Error(`Product loop created legacy artifact ${file}`);
  }
  // Reproduce unavailable browser recovery through the installed CLI, not an internal mock.
  const uiStarted = JSON.parse(run(bin, ["feature", "Exercise a browser button", "--source-brief", "-", "--json"], project, env, "Exercise a browser button: clicking it shows its result."));
  const uiBrief = {
    ...uiStarted.data.brief,
    outcomes: [{id:"O001",kind:"functional",statement:"A button responds to real input",priority:"must"}],
    checks: [{id:"C001",command:{kind:"browser-journey",journey:{url:"http://127.0.0.1:8123",actions:[{kind:"click",selector:"button"}]}},outcomes:["O001"],files:["value.mjs"]}],
    slices: [{id:"T001",goal:"Exercise one button",outcomes:["O001"],scope:{allowed:["value.mjs"]},checks:["C001"]}],
  };
  run(bin, ["brief","--from","-","--reason","Declare first browser behavior","--json"], project, env, JSON.stringify(uiBrief));
  run(bin, ["critic", "--off", "--json"], project, env); // This offline browser smoke never dispatches a model.
  const unavailableEnv = {...env, CHROME_BIN:join(scratch,"missing-browser")};
  const permitted = JSON.parse(run(bin, ["work","--task","T001","--json"], project, unavailableEnv));
  if (!permitted.ok) throw new Error("Browser startup gap prevented scoped implementation");
  const uiStatePath = join(project,".visp","features",uiBrief.feature,"product-state.json");
  const uiBefore = readFileSync(uiStatePath,"utf8");
  const uiState = JSON.parse(uiBefore);
  if (uiState.executions.length || uiState.slices.T001.status !== "in-progress") throw new Error("Capability became product evidence or prevented scope");
  const recovery = JSON.parse(run(bin,["next","--json"],project,unavailableEnv));
  if (recovery.data?.completion !== "unresolved-environment" || recovery.data?.mayEdit !== true ||
      !recovery.data?.command.includes("--retry-environment")) throw new Error("Packaged next lost environment recovery");
  if (readFileSync(uiStatePath,"utf8") !== uiBefore) throw new Error("Read-only next rewrote capability state");
  process.stdout.write(`Packaged CLI/runner, Codex activation and TypeScript consumer passed (${runtime.version}, ${runtime.buildId}).\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}

function run(command, args, cwd, env = process.env, input) {
  return execFileSync(command, args, { cwd, env, input, encoding: "utf8", stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
}
