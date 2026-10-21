import { realpathSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join, posix } from "node:path";
import type { CommandOutput } from "../../../core/exec.js";
import { hashValue } from "../../../core/hash.js";
import type { Result } from "../../../core/result.js";
import type { WorkspaceState } from "../../state.js";
import { describeProductCheck, isBrowserCheckCommand } from "../check/check-command.js";
import { configuredMissingTool } from "../check/configured-checks.js";
import type { ProductCheck, ProductExecution, ProductSlice } from "../model.js";
import { sandboxDenial } from "../sandbox-denial.js";
import { type ProductAuthorization, readProductAuthorizationBaseline } from "../scopes.js";
import { MISSING_SOURCE_ENTRY } from "../source-entry.js";
import type { ProductRecord } from "../store.js";
import { productSourceChanges, productSourceSnapshot } from "../subject.js";
import {
  captureFlipEnvironment,
  type FlipEnvironment,
  projectNeedles,
  type RootNeedles,
  scanProjectFile,
} from "./flip-environment.js";
import { type FlipEntry, inFlipTree, recoverFlipBaseline } from "./flip-tree.js";
import { flipValidationPaths } from "./flip-validation.js";

type FlipCheck = NonNullable<ProductExecution["flip"]>;

export type ProductFlip = Pick<ProductExecution, "flip" | "flipCacheKey" | "flipDurationMs">;

/**
 * Snapshot before the original command can mutate writable dependency state. Never throws:
 * a failure here is returned as a reason, so the original check is not failed by the advisory.
 */
export async function prepareProductFlipEnvironment(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice | undefined,
  check: ProductCheck,
  environmentIdentity?: () => Promise<string>,
): Promise<FlipEnvironment | undefined> {
  try {
    if (!slice?.checks.includes(check.id) || workspace.config.workflow.flipCheck === "off") return;
    const authorization = await readProductAuthorizationBaseline(workspace, record);
    if (!authorization.ok || !matchingAuthorization(authorization.value, slice.id)) return;
    const snapshot = await productSourceSnapshot(workspace, record.brief);
    if (!snapshot.ok) return { reason: snapshot.error.message };
    const changes = await productSourceChanges(
      workspace,
      authorization.value.baseline,
      snapshot.value,
    );
    if (!changes.ok) return { reason: changes.error.message };
    if (!flipApplies(workspace.config.workflow.flipCheck, changes.value, authorization.value))
      return;
    const identity = environmentIdentity ? await environmentIdentity() : undefined;
    if (cachedFlip(record, check, identity, authorization.value, snapshot.value, changes.value))
      return;
    return await captureFlipEnvironment(workspace.paths.root);
  } catch (cause) {
    return { reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * Display-only: the passing receipt and all gate/evidence semantics remain the original run's.
 * A comparison runs the check a second time on the work-authorization baseline, in a temporary
 * tree with tests kept. External side effects of the check (databases, services, files outside the
 * project) happen again. Set `workflow.flipCheck: off` to stop comparisons.
 */
export async function productFlipCheck(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice | undefined,
  check: ProductCheck,
  environmentIdentity: string | undefined,
  execute: (directory: string) => Promise<Result<CommandOutput>>,
  redact: (text: string) => string,
  environment?: FlipEnvironment,
): Promise<ProductFlip> {
  if (
    !slice?.checks.includes(check.id) ||
    workspace.config.workflow.flipCheck === "off" ||
    isBrowserCheckCommand(check.command)
  )
    return {};
  const started = Date.now();
  let revertedFiles: string[] = [];
  let preservedValidationFiles: string[] = [];
  let flipCacheKey: string | undefined;
  const unchecked = (reason: string): ProductFlip => ({
    flip: {
      failsWithoutChange: "unchecked",
      reason: redact(reason),
      revertedFiles,
      preservedValidationFiles,
      commands: [],
    },
    ...(flipCacheKey ? { flipCacheKey } : {}),
    flipDurationMs: Date.now() - started + (environment?.durationMs ?? 0),
  });
  try {
    const authorization = await readProductAuthorizationBaseline(workspace, record);
    if (!authorization.ok || !matchingAuthorization(authorization.value, slice.id)) return {};
    const auth = authorization.value;
    const snapshot = await productSourceSnapshot(workspace, record.brief);
    if (!snapshot.ok) return unchecked(snapshot.error.message);
    const changes = await productSourceChanges(workspace, auth.baseline, snapshot.value);
    if (!changes.ok) return unchecked(changes.error.message);
    // Cheap greenfield fast path: no reconstruction, import scan, receipt, or packet changes.
    if (
      workspace.config.workflow.flipCheck === "auto" &&
      !changes.value.some(
        (path) => auth.baseline[path] !== undefined && auth.baseline[path] !== MISSING_SOURCE_ENTRY,
      )
    )
      return {};
    const priorFlip = cachedFlip(
      record,
      check,
      environmentIdentity,
      auth,
      snapshot.value,
      changes.value,
    );
    if (priorFlip) return priorFlip;
    const baseline = await recoverFlipBaseline(workspace, auth);
    const validation = await flipValidationPaths(
      workspace,
      check,
      snapshot.value,
      baseline,
      auth.baseline,
    );
    revertedFiles = changes.value.filter((path) => !validation.has(path)).sort();
    if (!flipApplies(workspace.config.workflow.flipCheck, revertedFiles, auth)) return {};
    preservedValidationFiles = [...validation].sort();
    flipCacheKey = flipIdentity(
      check,
      environmentIdentity,
      auth,
      snapshot.value,
      preservedValidationFiles,
      revertedFiles,
    );
    const blocker = await comparisonBlocker(workspace, auth, baseline, validation, snapshot.value);
    if (blocker) return unchecked(blocker);
    const flip = await inFlipTree(
      workspace,
      auth,
      baseline,
      validation,
      snapshot.value,
      async (directory) =>
        classifyFlip(
          await execute(directory),
          check,
          revertedFiles,
          preservedValidationFiles,
          directory,
          redact,
        ),
      environment,
    );
    return {
      flip,
      flipCacheKey,
      flipDurationMs: Date.now() - started + (environment?.durationMs ?? 0),
    };
  } catch (cause) {
    return unchecked(cause instanceof Error ? cause.message : String(cause));
  }
}

/** Why a comparison must not run, or undefined when it may. Nothing here runs the check. */
export async function comparisonBlocker(
  workspace: WorkspaceState,
  auth: ProductAuthorization,
  baseline: ReadonlyMap<string, FlipEntry>,
  validation: ReadonlySet<string>,
  snapshot: Record<string, string>,
): Promise<string | undefined> {
  const missing = Object.keys(auth.baseline).find(
    (path) => !validation.has(path) && !baseline.has(path),
  );
  if (missing) return `baseline bytes unavailable for ${missing}`;
  return projectPathReference(workspace, Object.keys(snapshot));
}

/** Bound on the tracked files the absolute-path scan reads, across the whole project. */
const REFERENCE_SCAN_TOTAL_BYTES = 256 * 1024 * 1024;

/**
 * A project file that names the project by its absolute path. The comparison runs the check in a
 * different tree, but such a path still reaches the user's project. Every snapshot file is read in
 * full (any size, in steps, so a path across a step boundary is found); a symlink's target is its
 * text. A file that cannot be read, or a scan past the bound, is never skipped: it is reported.
 * Returns the reason, or undefined when no file names the project that way.
 */
async function projectPathReference(
  workspace: WorkspaceState,
  files: string[],
): Promise<string | undefined> {
  const needles = await projectNeedles(workspace.paths.root);
  const budget = { total: 0 };
  for (const path of [...files].sort()) {
    const reason = await fileReference(join(workspace.paths.root, path), path, needles, budget);
    if (reason) return reason;
  }
  return undefined;
}

/** Why one snapshot file names the project, or undefined when it does not (or is reproduced by the overlay). */
async function fileReference(
  full: string,
  path: string,
  needles: RootNeedles,
  budget: { total: number },
): Promise<string | undefined> {
  let referenced: boolean;
  try {
    const info = await lstat(full);
    // A symbolic link is reproduced by the tree overlay: a project-internal target is rebound and
    // an external one refuses the comparison. Its text is not content the check reads.
    if (info.isSymbolicLink()) return undefined;
    if (!info.isFile())
      return `${path} is not a regular file; the absolute-path scan cannot read it`;
    budget.total += info.size;
    if (budget.total > REFERENCE_SCAN_TOTAL_BYTES)
      return "the tracked files exceed the absolute-path scan bound; the comparison cannot rule out a reference to the project";
    const scan = await scanProjectFile(full, needles);
    referenced = scan.reference || scan.wide;
  } catch (cause) {
    // Listed by the snapshot but deleted since: the check cannot read it.
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return `${path} could not be read for the absolute-path scan: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  return referenced
    ? `${path} refers to the project by absolute path; the comparison could change the project`
    : undefined;
}

export function classifyFlip(
  output: Result<CommandOutput>,
  check: ProductCheck,
  revertedFiles: string[],
  preservedValidationFiles: string[],
  root: string,
  redact: (text: string) => string,
): FlipCheck {
  const raw = output.ok ? `${output.value.stdout}\n${output.value.stderr}` : output.error.message;
  const full = redact(raw);
  const commands = [
    {
      command: describeProductCheck(check),
      exitCode: output.ok ? output.value.exitCode : -1,
      passed:
        output.ok && output.value.exitCode === 0 && !output.value.timedOut && !output.value.aborted,
      durationMs: output.ok ? output.value.durationMs : 0,
      output: full.slice(0, 4000),
    },
  ];
  const base = { revertedFiles, preservedValidationFiles, commands };
  const environment = flipRunEnvironmentFailure(output, check, raw, revertedFiles, root);
  if (environment)
    return { ...base, failsWithoutChange: "unchecked", reason: redact(environment).slice(0, 600) };
  if (output.ok && output.value.exitCode === 0) return { ...base, failsWithoutChange: false };
  const structural =
    /SyntaxError|IndentationError|TabError|ImportError|ModuleNotFoundError|FileNotFoundError|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|collection error|error (?:during|collecting) collection|ERROR collecting|Cannot find (?:module|package)/i.test(
      raw,
    );
  const assertion =
    /AssertionError|ERR_ASSERTION|\bAssertion failed\b|\bFAIL(?:ED|URE|URES)?\b|\bnot ok\b|✖|\b[1-9]\d* failed\b/i.test(
      raw,
    );
  const first =
    reasonLine(full, /AssertionError|ERR_ASSERTION|\bFAIL|\bnot ok\b|Error|✖/i).slice(0, 500) ||
    full.trim().split(/\r?\n/)[0]?.slice(0, 500);
  return structural || assertion
    ? {
        ...base,
        failsWithoutChange: true,
        signal: structural ? "structural" : "behavioral",
        ...(first ? { reason: first } : {}),
      }
    : {
        ...base,
        failsWithoutChange: "unchecked",
        reason: first || "reverted command failed without a recognizable test failure",
      };
}

/** Tree-relative spellings of the comparison tree: as given, and as the OS resolved it. */
function treeRoots(root: string): string[] {
  let real: string | undefined;
  try {
    real = realpathSync(root);
  } catch {
    real = undefined;
  }
  return [...new Set([root, real].filter((path): path is string => path !== undefined))];
}

/**
 * The tree-relative path a reported name denotes, or undefined when it is outside the tree.
 * Only an exact normalized path matches a reverted file: a missing fixture named
 * fixtures/config/app.json is not the reverted config/app.json.
 */
function treeRelativeName(name: string, roots: readonly string[]): string | undefined {
  let text = name.trim().replace(/^file:\/\//, "");
  const inside = roots.find((root) => text.startsWith(`${root}/`));
  if (inside !== undefined) text = text.slice(inside.length + 1);
  if (posix.isAbsolute(text)) return undefined;
  const normal = posix.normalize(text.replace(/^(?:\.\/)+/, ""));
  return normal === "." || normal === ".." || normal.startsWith("../") ? undefined : normal;
}

/**
 * How a reverted file may be named: a file error names its path exactly, while a module
 * error may name it by its module spelling (no extension, dotted, package, or the emitted
 * .js, .mjs or .cjs name of a TypeScript source).
 */
const TYPESCRIPT_EMITTED = new Map([
  ["ts", "js"],
  ["tsx", "js"],
  ["mts", "mjs"],
  ["cts", "cjs"],
]);

function namesOfReverted(path: string, kind: "file" | "module") {
  if (kind === "file") return new Set([path]);
  const bare = path.replace(/\.[^./]+$/, "");
  const pkg = bare.replace(/\/__init__$/, "");
  const emitted = TYPESCRIPT_EMITTED.get(/\.([^./]+)$/.exec(path)?.[1] ?? "");
  return new Set([
    path,
    bare,
    pkg,
    bare.replaceAll("/", "."),
    pkg.replaceAll("/", "."),
    ...(emitted ? [`${bare}.${emitted}`] : []),
  ]);
}

/**
 * A relative module specifier names a file beside the module that imports it. Only an absolute
 * importer can be resolved; otherwise the name is unknown and is not attributed to a revert.
 */
function resolvedSpecifier(specifier: string, importer: string | undefined) {
  if (!specifier.startsWith(".")) return specifier;
  const from = importer?.trim().replace(/^file:\/\//, "");
  return from !== undefined && posix.isAbsolute(from)
    ? posix.join(posix.dirname(from), specifier)
    : undefined;
}

function revertedName(
  name: string,
  reverted: string[],
  roots: readonly string[],
  kind: "file" | "module",
  importer?: string,
) {
  const spelled = kind === "module" ? resolvedSpecifier(name, importer) : name;
  const relative = spelled === undefined ? undefined : treeRelativeName(spelled, roots);
  return (
    relative !== undefined && reverted.some((path) => namesOfReverted(path, kind).has(relative))
  );
}

function structuralAttribution(output: string, reverted: string[], roots: readonly string[]) {
  const missing = [
    ...output.matchAll(
      /(Cannot find (?:module|package)|No module named|FileNotFoundError:[^\n]*?directory:|ENOENT:[^\n]*?\b(?:open|stat|access))\s+['"]([^'"\n]+)['"]/gi,
    ),
  ].map((match) => ({
    kind: /^(?:Cannot find|No module)/i.test(match[1] ?? "")
      ? ("module" as const)
      : ("file" as const),
    name: match[2] ?? "",
    // The error's own line names its importer ("imported from <file>"), quoted or not.
    importer: /\bimported from\s+['"]?([^'"\n]+?)['"]?\s*$/.exec(
      output.slice(match.index ?? 0).split(/\r?\n/, 1)[0] ?? "",
    )?.[1],
  }));
  if (missing.length)
    return missing.every((entry) =>
      revertedName(entry.name, reverted, roots, entry.kind, entry.importer),
    );
  const imported = [
    ...output.matchAll(/ImportError:[^\n]*?from ['"]?[^'"\n]+['"]? \(['"]?([^'"()\n]+)['"]?\)/g),
  ];
  if (imported.length)
    return imported.every((match) =>
      revertedName((match[1] ?? "").trim(), reverted, roots, "file"),
    );
  if (/SyntaxError|IndentationError|TabError/.test(output)) {
    // The last Python traceback file, or the JS syntax location immediately before
    // the error, identifies the source that could not parse (not its importers).
    const locations = [
      ...output.matchAll(
        /(?:File ['"]([^'"\n]+)['"], line|(?:^|\n)(?:file:\/\/)?([^\s\n]+\.[cm]?[jt]s):\d+)/g,
      ),
    ];
    const last = locations.at(-1);
    return !!last && revertedName(last[1] ?? last[2] ?? "", reverted, roots, "file");
  }
  return false;
}

/**
 * Output of a failed hook, fixture or suite. The fixture failed rather than the product, so the
 * result is unchecked whatever else the output says (node:test, vitest, jest, pytest, unittest).
 */
const HOOK_OR_SUITE_FAILURE = [
  // node:test runs hooks through TestHook.run, Test.runHook, Suite.runHook or Test.createHook.
  /\b(?:Test|Suite)\.runHook\b|\bTestHook\.run\b|\bTest\.createHook\b/,
  /\b(?:before|after)(?:All|Each)?\s+hook\s+(?:failed|threw|error)\b|\bhook (?:failed|threw)\b/i,
  // vitest: a beforeAll or beforeEach call is the failing line of its code frame.
  /^\s*\d+\s*\|.*\b(?:beforeAll|beforeEach|afterAll|afterEach)\s*\(/m,
  // jest (not exercised here): hook failures are headed by the hook name.
  /●[^\n]*›\s*(?:beforeAll|beforeEach|afterAll|afterEach)\b/,
  // pytest fixtures and unittest class or module fixtures.
  /ERROR at (?:setup|teardown) of\b|^ERROR: (?:setUp|tearDown)\w*\b/m,
];

/**
 * A file-level failure: a file failed before any test body ran, so no assertion in it is
 * evidence. Attribution runs first, so a missing module the revert removed stays structural.
 */
const FILE_LEVEL_FAILURE = [
  // node:test names a failing file, relative or absolute, with its duration.
  /^✖ (?:file:\/\/)?\S+\.[cm]?[jt]sx?\s+\(\d[\d.]*ms\)/m,
  // vitest: a failed beforeAll fails the suite; a file that cannot be loaded fails in brackets.
  /⎯+ Failed Suites\b/,
  /^\s*FAIL\s+(\S+)\s+\[\s*\1\s*\]/m,
];

/**
 * The line a reader needs: pytest's own "E   ...Error" line, then the first line matching each
 * pattern in turn, never a ====, ____ or vitest ⎯⎯⎯⎯ banner.
 */
function reasonLine(text: string, ...patterns: RegExp[]) {
  const lines = text.split(/\r?\n/).filter((line) => !/^\s*(?:={3,}|_{3,}|⎯{3,})/.test(line));
  return (
    lines.find((line) => /^\s*E\s+.*(?:Error|Exception)\b/.test(line)) ??
    patterns.reduce<string | undefined>(
      (found, pattern) => found ?? lines.find((line) => pattern.test(line)),
      undefined,
    ) ??
    lines[0] ??
    ""
  ).trim();
}

function environmentReason(output: string) {
  return (
    reasonLine(
      output,
      /\b\w*(?:Error|Exception):|Cannot find|No module|ENOENT/,
      /Error|Exception|not found|setup|collection/i,
    ) ||
    (output.trim().split(/\r?\n/)[0] ?? "")
  );
}

function flipEnvironmentFailure(
  output: string,
  reverted: string[],
  root: string,
): string | undefined {
  if (sandboxDenial(output, root)) return "reverted check could not run in the sandbox";
  const setup =
    HOOK_OR_SUITE_FAILURE.some((pattern) => pattern.test(output)) ||
    /\bin (?:setUp|setUpClass|asyncSetUp|tearDown|tearDownClass)\b|ERROR at setup|setup (?:failed|error)|error (?:in|at) setup|fixture.*not found/i.test(
      output,
    );
  const roots = treeRoots(root);
  // Attribution runs first: a missing module the revert removed is the change's own effect, even
  // when a file-level line also reports the failing file.
  if (!setup && structuralAttribution(output, reverted, roots)) return undefined;
  // An assertion that fails at a file's top level is evidence about the product, not a fixture.
  const assertion = /AssertionError|ERR_ASSERTION/.test(output);
  const fileLevel = !assertion && FILE_LEVEL_FAILURE.some((pattern) => pattern.test(output));
  const structural =
    /SyntaxError|IndentationError|TabError|ImportError|ModuleNotFoundError|FileNotFoundError|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|ENOENT|collection error|error (?:during|collecting) collection|ERROR collecting/i.test(
      output,
    );
  const environment =
    /ERR_PNPM_|npm ERR!|ENVIRONMENT ERROR:|command not found|No such file or directory.*(?:python|node)|Cannot find package|No module named|Cannot find module|Could not find/i.test(
      output,
    );
  if (setup || fileLevel || structural || environment)
    return `reverted check environment/setup failure: ${environmentReason(output)}`;
  return undefined;
}

function matchingAuthorization(
  auth: ProductAuthorization | undefined,
  task: string,
): auth is ProductAuthorization {
  return auth !== undefined && auth.task === task;
}

export function flipRunEnvironmentFailure(
  output: Result<CommandOutput>,
  check: ProductCheck,
  raw: string,
  reverted: string[],
  root: string,
): string | undefined {
  if (!output.ok) return output.error.message;
  if (output.value.timedOut) return "reverted check timed out";
  if (output.value.aborted) return "reverted check interrupted";
  if (output.value.exitCode === 0) return undefined;
  return (
    flipEnvironmentFailure(raw, reverted, root) ??
    configuredMissingTool(check, raw, output.value.exitCode)
  );
}

function flipApplies(mode: "auto" | "on" | "off", reverted: string[], auth: ProductAuthorization) {
  return (
    reverted.length > 0 &&
    (mode === "on" ||
      reverted.some(
        (path) => auth.baseline[path] !== undefined && auth.baseline[path] !== MISSING_SOURCE_ENTRY,
      ))
  );
}

function flipIdentity(
  check: ProductCheck,
  environment: string | undefined,
  auth: ProductAuthorization,
  snapshot: Record<string, string>,
  validation: string[],
  implementation: string[],
) {
  return hashValue({
    isolationVersion: 2,
    command: { argv: check.command, files: check.files, verifierFiles: check.verifierFiles },
    timeoutMs: check.timeoutMs,
    environment,
    baseline: hashValue({ files: auth.baseline, head: auth.headCommit }),
    validation: validation.map((path) => [path, snapshot[path]]),
    implementation: implementation.map((path) => [path, snapshot[path]]),
  });
}

/** An unchanged recorded partition avoids rebuilding and reparsing a large project on a hit. */
function cachedFlip(
  record: ProductRecord,
  check: ProductCheck,
  environment: string | undefined,
  auth: ProductAuthorization,
  snapshot: Record<string, string>,
  changes: string[],
): ProductFlip | undefined {
  for (const entry of [...record.state.executions].reverse()) {
    if (!entry.flip || !entry.flipCacheKey) continue;
    const validation = entry.flip.preservedValidationFiles;
    const preserved = new Set(validation);
    const implementation = changes.filter((path) => !preserved.has(path)).sort();
    const identity = flipIdentity(check, environment, auth, snapshot, validation, implementation);
    if (identity === entry.flipCacheKey)
      return { flip: entry.flip, flipCacheKey: identity, flipDurationMs: 0 };
  }
  return undefined;
}
