import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolveCommand } from "../../../core/exec.js";
import { isExternalRef } from "../../../graph/constants.js";
import { isApplicationSource } from "../../../graph/coverage-notes.js";
import {
  fileEntityId,
  openProjectStore,
  pathOfEntityId,
  refreshRepository,
} from "../../../graph/index.js";
import { getQueryIndex } from "../../../graph/query/index.js";
import type { SnapshotIndex } from "../../../graph/query/snapshot-index.js";
import type { WorkspaceState } from "../../state.js";
import { isBrowserCheckCommand } from "../check/check-command.js";
import type { ProductCheck } from "../model.js";
import { namesExistingTest } from "../regression-command-matching.js";
import type { ProductAuthorization } from "../scopes.js";
import { MISSING_SOURCE_ENTRY } from "../source-entry.js";
import { productSourceChanges } from "../subject.js";
import {
  type DeclaredRunner,
  declaredRunner,
  isRunnableTestFile,
  pythonTestClasses,
  type TestLanguage,
  testFileCommand,
  testLanguage,
  testRunnerFacts,
} from "./regression-runner.js";
import type { RegressionCandidate } from "./regression-selection.js";

/** Import hops from a changed file to a test: the tests of the file, of its importers, one more. */
const GRAPH_DEPTH = 3;
/** Files the import walk visits at most per gate. */
const MAX_VISITED = 5_000;
/** Test source the convention search reads at most. */
const MAX_TEST_BYTES = 64 * 1024 * 1024;
/**
 * Tests that import no application code (subprocess or HTTP suites) can exercise any change, but
 * running all of a large project's is filler: only a project with this few of them gets them.
 */
const MAX_UNLINKED = 4;
/** Distances that order the routes: graph hops 1..3, a convention match, an unlinked test. */
const NAMED = 1;
const LAYOUT = 2;
const UNLINKED = GRAPH_DEPTH + 1;
/** Module and directory names too common to tie a test to a change. */
const GENERIC = new Set([
  "__init__",
  "index",
  "main",
  "utils",
  "util",
  "base",
  "core",
  "common",
  "helpers",
  "helper",
  "models",
  "model",
  "views",
  "view",
  "admin",
  "apps",
  "app",
  "conf",
  "config",
  "settings",
  "constants",
  "types",
  "api",
  "urls",
  "forms",
  "fields",
  "test",
  "tests",
  "src",
  "lib",
  "contrib",
]);
const TEST_NAME = /^(?:test_.+|.+_test|tests)\.py$|\.(?:test|spec)\.[cm]?[jt]sx?$/;

interface Covering {
  readonly origin: RegressionCandidate["origin"];
  readonly distance: number;
}

interface ChangedModule {
  readonly path: string;
  readonly language?: TestLanguage;
  /** The module's import name, `pkg.contrib.auth.commands.create`; Python only. */
  readonly dotted?: string;
  /** Its file name, when specific enough to tie a test to it. */
  readonly stem?: string;
  /** Specific package directory names on its path, for `tests/<app>_tests/test_<package>.py`. */
  readonly packages: readonly string[];
}

/**
 * Existing tests the change can reach, in the language of the changed code: by import edges in
 * the refreshed index, then by convention (a test that names the changed module, is named after
 * it, or sits in its app's test directory), then, for a project with few of them, tests that
 * import no application code. Notes say what was not considered and why.
 */
export async function changeCandidates(
  workspace: WorkspaceState,
  auth: ProductAuthorization | undefined,
  snapshot: Record<string, string>,
  ranCommands: readonly string[],
  runners: readonly DeclaredRunner[],
): Promise<{ candidates: RegressionCandidate[]; notes: string[]; blind: boolean }> {
  const blind = (note: string) => ({ candidates: [], notes: [note], blind: true });
  if (!auth) return blind("no baseline of the code before this work, so its changes are unknown");
  const changes = await productSourceChanges(workspace, auth.baseline, snapshot);
  if (!changes.ok) return blind(`changed files unknown: ${changes.error.message}`);
  const changed = changes.value.filter(isApplicationSource).map(changedModule);
  if (!changed.length) return { candidates: [], notes: [], blind: false };
  const index = await currentIndex(workspace);
  if (typeof index === "string") return blind(`graph unavailable: ${index}`);
  const languages = new Set(
    changed.flatMap((module) => (module.language ? [module.language] : [])),
  );
  const existed = (path: string) =>
    auth.baseline[path] !== undefined && auth.baseline[path] !== MISSING_SOURCE_ENTRY;
  const candidates = index.snapshot.files
    .map((file) => file.path)
    .filter((path) => {
      const language = testLanguage(path);
      return (
        language !== undefined &&
        languages.has(language) &&
        TEST_NAME.test(basename(path)) &&
        existed(path)
      );
    })
    .sort();
  const sources = await testSources(workspace, candidates);
  const runnable = candidates.filter((path) => isRunnableTestFile(path, sources.get(path) ?? ""));
  const ran = (path: string) =>
    ranCommands.some((command) => namesExistingTest(command, path, workspace.paths.root));
  const covering = coveringTests(index, changed, runnable, sources, ran);
  const built = await commands(workspace, covering.selected, changed, sources, runners);
  return {
    candidates: built.candidates,
    notes: [
      ...covering.notes,
      ...(built.unrunnable.length
        ? [`no known way to run ${built.unrunnable.length} test files: ${listed(built.unrunnable)}`]
        : []),
      ...(sources.size < candidates.length
        ? [`${candidates.length - sources.size} test files not read: over the 64 MiB bound`]
        : []),
    ],
    blind: false,
  };
}

function changedModule(path: string): ChangedModule {
  const language = testLanguage(path);
  const name = basename(path).replace(/\.[^.]+$/, "");
  const directories = dirname(path)
    .split("/")
    .filter((part) => part && part !== ".");
  const specific = (part: string) => part.length >= 3 && !GENERIC.has(part);
  return {
    path,
    ...(language ? { language } : {}),
    ...(language === "python"
      ? {
          dotted: path
            .replace(/^src\//, "")
            .replace(/(?:\/__init__)?\.py$/, "")
            .replaceAll("/", "."),
        }
      : {}),
    ...(specific(name) && name.length >= 4 ? { stem: name } : {}),
    packages: directories.slice(1).filter(specific),
  };
}

async function currentIndex(workspace: WorkspaceState): Promise<SnapshotIndex | string> {
  const indexed = await refreshRepository(
    workspace.paths.root,
    workspace.config.graph,
    workspace.paths.graphStore,
  );
  if (!indexed.ok) return indexed.error.message;
  const store = await openProjectStore(workspace.files, workspace.paths.graphStore, {
    writable: false,
  });
  if (!store.ok) return store.error.message;
  try {
    const index = getQueryIndex(store.value);
    return index.ok ? index.value : index.error.message;
  } finally {
    store.value.close();
  }
}

async function testSources(workspace: WorkspaceState, paths: readonly string[]) {
  const sources = new Map<string, string>();
  let bytes = 0;
  for (const path of paths) {
    const text = await workspace.files.readTextIfExists(path);
    if (!text.ok || text.value === undefined) continue;
    bytes += text.value.length;
    if (bytes > MAX_TEST_BYTES) break;
    sources.set(path, text.value);
  }
  return sources;
}

/**
 * The tests to run, and notes on the rest. A test this call's checks already ran counts as
 * reaching the change but is not run again.
 */
function coveringTests(
  index: SnapshotIndex,
  changed: readonly ChangedModule[],
  runnable: readonly string[],
  sources: ReadonlyMap<string, string>,
  ran: (path: string) => boolean,
): { selected: Map<string, Covering>; notes: string[] } {
  const { selected, reached } = linkedTests(index, changed, runnable, sources);
  const rest = runnable.filter((path) => !selected.has(path) && !ran(path));
  const unlinked = rest.filter((path) => !importsApplicationCode(index, path));
  // A suite of mostly subprocess or HTTP tests (a CLI, a server) has nothing else to run.
  if (unlinked.length <= MAX_UNLINKED && unlinked.length * 2 >= runnable.length)
    for (const path of unlinked) selected.set(path, { origin: "unlinked", distance: UNLINKED });
  const skipped = rest.filter((path) => !selected.has(path));
  const uncovered = changed.filter((module) => !reached.has(module.path));
  const already = [...selected.keys()].filter(ran);
  for (const path of already) selected.delete(path);
  return {
    selected,
    notes: [
      ...(already.length ? [`already run by this call's checks: ${listed(already)}`] : []),
      ...(skipped.length
        ? [
            `${skipped.length} test files reach no changed code and were not run: ${listed(skipped)}`,
          ]
        : []),
      ...(uncovered.length
        ? [
            `no existing test reaches ${uncovered.length === 1 ? uncovered[0]?.path : `${uncovered.length} changed files`}`,
          ]
        : []),
    ],
  };
}

/** Tests the index links to a changed file, then tests convention ties to one. */
function linkedTests(
  index: SnapshotIndex,
  changed: readonly ChangedModule[],
  runnable: readonly string[],
  sources: ReadonlyMap<string, string>,
) {
  const selected = new Map<string, Covering>();
  const reached = new Set<string>();
  for (const [path, distance] of importReach(index, changed, new Set(runnable))) {
    selected.set(path, { origin: "graph", distance: distance.distance });
    reached.add(distance.from);
  }
  for (const path of runnable) {
    const match = selected.has(path)
      ? undefined
      : conventionMatch(path, sources.get(path) ?? "", changed);
    if (!match) continue;
    selected.set(path, { origin: "convention", distance: match.distance });
    reached.add(match.from);
  }
  return { selected, reached };
}

function listed(paths: readonly string[]) {
  const shown = paths.slice(0, 3);
  return paths.length > shown.length ? `${shown.join(", ")}, …` : shown.join(", ");
}

/**
 * Tests reached from each changed file through files that import it, up to GRAPH_DEPTH hops.
 * Helpers that are not tests (a tests/support.py) are walked through, not stopped at.
 */
function importReach(
  index: SnapshotIndex,
  changed: readonly ChangedModule[],
  tests: ReadonlySet<string>,
): Map<string, { distance: number; from: string }> {
  const found = new Map<string, { distance: number; from: string }>();
  for (const module of changed) {
    const visited = new Set([module.path]);
    let frontier = [module.path];
    for (let distance = 1; distance <= GRAPH_DEPTH && frontier.length; distance++) {
      const importers = newImporters(index, frontier, visited);
      for (const importer of importers.filter((path) => tests.has(path))) {
        const known = found.get(importer);
        if (!known || known.distance > distance)
          found.set(importer, { distance, from: module.path });
      }
      frontier = importers.filter((path) => !tests.has(path));
    }
  }
  return found;
}

/** Files that import any of `paths` and were not visited yet, bounded by MAX_VISITED. */
function newImporters(index: SnapshotIndex, paths: readonly string[], visited: Set<string>) {
  const found: string[] = [];
  for (const path of paths)
    for (const relation of index.in(fileEntityId(path))) {
      if (relation.kind !== "imports" || visited.has(relation.path)) continue;
      if (visited.size > MAX_VISITED) return found;
      visited.add(relation.path);
      found.push(relation.path);
    }
  return found;
}

/**
 * A test the index cannot link but convention ties to a changed module: it names the module
 * (its import path, or its file name as a word, as `call_command("createsuperuser")` does), is
 * named after it (`test_create.py`), or sits in its app's test directory and is named after one
 * of its packages (`tests/auth_tests/test_management.py`).
 */
function conventionMatch(
  path: string,
  source: string,
  changed: readonly ChangedModule[],
): { distance: number; from: string } | undefined {
  const name = basename(path)
    .replace(/\.(?:test|spec)?\.?[^.]+$/, "")
    .replace(/^test_|_test$/g, "");
  const directory = basename(dirname(path)).replace(/_?tests?$/, "");
  let layout: { distance: number; from: string } | undefined;
  for (const module of changed) {
    if (module.language !== testLanguage(path)) continue;
    const named =
      (module.dotted !== undefined && source.includes(module.dotted)) ||
      (module.stem !== undefined &&
        (name === module.stem || new RegExp(`\\b${escapeRegExp(module.stem)}\\b`).test(source)));
    if (named) return { distance: NAMED, from: module.path };
    if (module.packages.includes(directory) && module.packages.includes(name))
      layout ??= { distance: LAYOUT, from: module.path };
  }
  return layout;
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function importsApplicationCode(index: SnapshotIndex, path: string) {
  return index
    .out(fileEntityId(path))
    .some(
      (relation) =>
        relation.kind === "imports" &&
        !isExternalRef(relation.target) &&
        isApplicationSource(pathOfEntityId(relation.target)),
    );
}

/** A command for each test, through the project's runner, narrowed to the classes that use the change. */
async function commands(
  workspace: WorkspaceState,
  selected: ReadonlyMap<string, Covering>,
  changed: readonly ChangedModule[],
  sources: ReadonlyMap<string, string>,
  runners: readonly DeclaredRunner[],
): Promise<{ candidates: RegressionCandidate[]; unrunnable: string[] }> {
  const facts = await testRunnerFacts(workspace.paths.root);
  const needles = changed.flatMap((module) => (module.stem ? [module.stem] : []));
  const candidates: RegressionCandidate[] = [];
  const unrunnable: string[] = [];
  for (const [path, { origin, distance }] of selected) {
    const source = sources.get(path) ?? "";
    const classes = origin === "unlinked" ? undefined : pythonTestClasses(source, needles);
    const command = testFileCommand(path, source, facts, {
      runners,
      ...(classes ? { classes } : {}),
    });
    if (!command) {
      unrunnable.push(path);
      continue;
    }
    candidates.push({
      label: path,
      origin,
      distance,
      check: { id: "REGRESSION", command, outcomes: [], files: [path], environment: "other" },
    });
  }
  return { candidates, unrunnable };
}

/** Runners the project's declared checks use, in their order. */
export function projectRunners(root: string, checks: readonly ProductCheck[]): DeclaredRunner[] {
  const exists = (path: string) => existsSync(join(root, path));
  return checks.flatMap((check) => {
    if (isBrowserCheckCommand(check.command)) return [];
    const argv = resolveCommand(check.command);
    const runner = argv.ok ? declaredRunner(argv.value, exists) : undefined;
    return runner ? [runner] : [];
  });
}
