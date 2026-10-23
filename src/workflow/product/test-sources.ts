import { repositoryFiles } from "../../core/git.js";
import { isTestFile } from "../module-paths.js";
import type { WorkspaceState } from "../state.js";

/**
 * The tests the project's test files define, read with a text scan and no model: `def test_x`
 * at module level or in a test class, a test class (a `TestCase` subclass, or a `Test…` class,
 * with test methods), `it("x")` and `test("x")`, and `func TestX`. Helpers, fixtures and plain
 * classes in a test file are not tests. The account check uses it when a runner prints only dots
 * and a summary, to see that a test the worker names exists and that the run's count matches.
 */

export interface TestSource {
  readonly path: string;
  readonly text: string;
}

/** Whose collection rules apply: unittest's, pytest's, a JavaScript runner's, or any of them. */
export type TestRunnerKind = "unittest" | "pytest" | "js" | "any";

export interface TestSources {
  readonly paths: readonly string[];
  /**
   * The test files that define `name` as a test `runner` collects: `test_x`, `XTest`,
   * `module.Class.method`, or a word of an `it`/`test` title.
   */
  definedIn(name: string, runner?: TestRunnerKind): string[];
  /** How many tests `runner` collects from the files; undefined when a text scan cannot count them. */
  testCount(runner: TestRunnerKind): number | undefined;
  /** The same scan, narrowed to the files a run covered. */
  within(covers: (path: string) => boolean): TestSources;
}

const PY_CLASS = /^class[ \t]+(\w+)/;
const PY_DEF = /^(?:async[ \t]+)?def[ \t]+(\w+)/;
const PY_BASES = /^[ \t]*\(([^)]*)\)/;
/** Tests whose number the source does not show: parametrized, generated or loaded by a hook. */
const PY_UNCOUNTABLE =
  /\bparametrize\b|\bparameterized\b|@pytest\.fixture\([^)]*\bparams\s*=|^def[ \t]+(?:load_tests|pytest_generate_tests)\b/m;
const GO_FUNC = /^func[ \t]+(Test\w*)/gm;
const JS_TITLE = /\b(it|test|describe)((?:\.\w+)*)\(\s*(["'`])((?:\\.|(?!\3).)*)\3/g;
const JS_UNCOUNTABLE = /\b(?:it|test|describe)(?:\.\w+)*\.each\b/;

const TEST_PATH = /(?:^|\/)test_[^/]*\.py$|_test\.(?:py|go)$|(?:Test|Tests)\.(?:java|kt|cs|php)$/;
const SCANNED = /\.(?:py|js|mjs|cjs|ts|tsx|jsx|go|rb|java|kt|cs|php)$/;
const MAX_FILES = 400;

export function isTestSourcePath(path: string): boolean {
  return SCANNED.test(path) && (isTestFile(path) || TEST_PATH.test(path));
}

interface PyClass {
  readonly name: string;
  readonly bases: string[];
  /** The class's own methods named `test…`. */
  readonly methods: string[];
}

interface FileScan {
  readonly path: string;
  /** Module-level functions named `test…`. */
  readonly functions: string[];
  /** Module-level classes. */
  readonly classes: PyClass[];
  readonly goTests: string[];
  /** Titles of the `it(…)` and `test(…)` calls that run (not `.skip` or `.todo`). */
  readonly titles: string[];
  /** Every `it(…)` and `test(…)` call, as a JavaScript runner counts them. */
  readonly jsTests: number;
  readonly uncountable: { readonly py: boolean; readonly js: boolean };
}

const isTestName = (name: string) => name.startsWith("test");
const indentOf = (line: string) => /^[ \t]*/.exec(line)?.[0].length ?? 0;

/** Strings, comments and brackets: what decides whether the next line starts a statement. */
const PY_TOKEN = /"""|'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#.*|[([{)\]}]/g;
const BRACKETS: Readonly<Record<string, number>> = {
  "(": 1,
  "[": 1,
  "{": 1,
  ")": -1,
  "]": -1,
  "}": -1,
};

/** Where a line leaves Python's lexer: how many brackets are open, and an open `"""` string. */
interface Lexed {
  readonly depth: number;
  readonly triple?: string;
}

function lexLine(line: string, state: Lexed): Lexed {
  const token = new RegExp(PY_TOKEN.source, "g");
  if (state.triple) {
    const end = line.indexOf(state.triple);
    if (end < 0) return state;
    token.lastIndex = end + 3;
  }
  let depth = state.depth;
  for (let match = token.exec(line); match; match = token.exec(line)) {
    const text = match[0];
    if (text.startsWith("#")) break;
    if (text === '"""' || text === "'''") {
      const end = line.indexOf(text, token.lastIndex);
      if (end < 0) return { depth, triple: text };
      token.lastIndex = end + 3;
    }
    depth = Math.max(0, depth + (BRACKETS[text] ?? 0));
  }
  return { depth };
}

/** The indices of lines that start a Python statement: not inside brackets, a string or a `\` join. */
function statementStarts(lines: readonly string[]): number[] {
  const starts: number[] = [];
  let state: Lexed = { depth: 0 };
  let joined = false;
  lines.forEach((line, index) => {
    if (!state.depth && !state.triple && !joined) starts.push(index);
    state = lexLine(line, state);
    joined = !state.triple && line.trimEnd().endsWith("\\");
  });
  return starts;
}

/** The class a statement declares, with its bases, which may run over the next lines. */
function classAt(lines: readonly string[], index: number, body: string): PyClass | undefined {
  const declared = PY_CLASS.exec(body);
  if (!declared?.[1]) return undefined;
  const rest = [body.slice(declared[0].length), ...lines.slice(index + 1, index + 20)].join("\n");
  const bases = (PY_BASES.exec(rest)?.[1] ?? "")
    .split(",")
    .map((base) => base.trim())
    .filter((base) => base && !base.includes("="));
  return { name: declared[1], bases, methods: [] };
}

type PythonScan = Pick<FileScan, "functions" | "classes">;
/** An open `class` or `def` block: a module-level class collects its methods. */
type Block = { readonly indent: number; readonly owner?: PyClass };

/**
 * Records what one statement defines, inside `parent` (none at module level), and returns the
 * block it opens. Nothing inside a function, or in a class inside another block, is a test.
 */
function readStatement(
  scan: PythonScan,
  parent: Block | undefined,
  declared: PyClass | undefined,
  body: string,
): Omit<Block, "indent"> | undefined {
  if (declared) {
    if (parent) return {};
    scan.classes.push(declared);
    return { owner: declared };
  }
  const defined = PY_DEF.exec(body)?.[1];
  if (!defined) return undefined;
  if (isTestName(defined) && !parent) scan.functions.push(defined);
  if (isTestName(defined)) parent?.owner?.methods.push(defined);
  return {};
}

/** Python's module-level functions and classes, and each class's methods, read by indentation. */
function scanPython(text: string): PythonScan {
  const scan: PythonScan = { functions: [], classes: [] };
  const lines = text.split("\n");
  const open: Block[] = [];
  for (const index of statementStarts(lines)) {
    const line = lines[index] ?? "";
    const body = line.trim();
    if (!body || body.startsWith("#")) continue;
    const indent = indentOf(line);
    while ((open.at(-1)?.indent ?? -1) >= indent) open.pop();
    const block = readStatement(scan, open.at(-1), classAt(lines, index, body), body);
    if (block) open.push({ indent, ...block });
  }
  return scan;
}

const JS_FILE = /\.[cm]?[jt]sx?$/;

/** Each language's tests, read only from that language's files. */
function scanFile(path: string, text: string): FileScan {
  const python = path.endsWith(".py");
  const js = JS_FILE.test(path);
  const calls = js ? [...text.matchAll(JS_TITLE)].filter((match) => match[1] !== "describe") : [];
  return {
    path,
    ...(python ? scanPython(text) : { functions: [], classes: [] }),
    goTests: path.endsWith(".go")
      ? [...text.matchAll(GO_FUNC)].map((match) => match[1] ?? "").filter(Boolean)
      : [],
    titles: calls
      .filter((match) => !/\.(?:skip|todo)\b/.test(match[2] ?? ""))
      .map((match) => match[4] ?? "")
      .filter(Boolean),
    jsTests: calls.length,
    uncountable: {
      py: python && PY_UNCOUNTABLE.test(text),
      js: js && JS_UNCOUNTABLE.test(text),
    },
  };
}

/** Classes by name across all files: a base class can live in another test file. */
class PythonClasses {
  private readonly byName = new Map<string, PyClass[]>();

  constructor(classes: readonly PyClass[]) {
    for (const entry of classes)
      this.byName.set(entry.name, [...(this.byName.get(entry.name) ?? []), entry]);
  }

  private bases(entry: PyClass): PyClass[] {
    return entry.bases.flatMap((base) => this.byName.get(base.split(".").at(-1) ?? base) ?? []);
  }

  /** A `unittest.TestCase` subclass, directly or through a class the files define. */
  isTestCase(entry: PyClass, seen = new Set<PyClass>()): boolean {
    if (seen.has(entry)) return false;
    seen.add(entry);
    return (
      entry.bases.some((base) => /TestCase$/.test(base.split(".").at(-1) ?? "")) ||
      this.bases(entry).some((base) => this.isTestCase(base, seen))
    );
  }

  /** The class's test methods: its own and those it inherits from classes the files define. */
  testMethods(entry: PyClass, seen = new Set<PyClass>()): Set<string> {
    if (seen.has(entry)) return new Set();
    seen.add(entry);
    const methods = new Set(entry.methods);
    for (const base of this.bases(entry))
      for (const method of this.testMethods(base, seen)) methods.add(method);
    return methods;
  }
}

/**
 * One test as the runners that collect it see it. unittest runs the test methods of TestCase
 * subclasses; pytest also runs module-level `test…` functions and `Test…` classes.
 */
interface Definition {
  readonly path: string;
  readonly name: string;
  readonly className?: string;
  readonly runners: readonly TestRunnerKind[];
}

const UNITTEST: readonly TestRunnerKind[] = ["unittest", "pytest", "any"];
const PYTEST: readonly TestRunnerKind[] = ["pytest", "any"];
const ANY: readonly TestRunnerKind[] = ["any"];

function definitionsOf(file: FileScan, classes: PythonClasses): Definition[] {
  const definitions: Definition[] = [
    ...file.functions.map((name) => ({ path: file.path, name, runners: PYTEST })),
    ...file.goTests.map((name) => ({ path: file.path, name, runners: ANY })),
  ];
  for (const entry of file.classes) {
    const methods = classes.testMethods(entry);
    const runners = classes.isTestCase(entry)
      ? UNITTEST
      : entry.name.startsWith("Test")
        ? PYTEST
        : [];
    if (!methods.size || !runners.length) continue;
    definitions.push({ path: file.path, name: entry.name, runners });
    for (const name of methods)
      definitions.push({ path: file.path, name, className: entry.name, runners });
  }
  return definitions;
}

function moduleParts(path: string): string[] {
  return path.replace(/\.[^./]+$/, "").split("/");
}

/** The qualifiers are the class, then the tail of the module path: `tests.test_api.ApiTest.test_x`. */
function qualifies(definition: Definition, qualifiers: readonly string[]): boolean {
  const rest = [...qualifiers];
  if (definition.className && rest.at(-1) === definition.className) rest.pop();
  const module = moduleParts(definition.path);
  return rest.every((part, index) => module[module.length - rest.length + index] === part);
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sortedPaths = (entries: readonly { path: string }[]) =>
  [...new Set(entries.map((entry) => entry.path))].sort();

function sourcesOf(files: readonly FileScan[], classes: PythonClasses): TestSources {
  const definitions = files.flatMap((file) => definitionsOf(file, classes));
  const titles = files.flatMap((file) => file.titles.map((title) => ({ path: file.path, title })));
  const pythonCount = (runner: TestRunnerKind) =>
    definitions.filter((entry) => entry.runners.includes(runner) && entry.className).length +
    (runner === "pytest" ? files.reduce((sum, file) => sum + file.functions.length, 0) : 0);
  const jsCount = files.reduce((sum, file) => sum + file.jsTests, 0);
  const goCount = files.reduce((sum, file) => sum + file.goTests.length, 0);
  const countable = {
    py: !files.some((file) => file.uncountable.py),
    js: !files.some((file) => file.uncountable.js),
  };
  return {
    paths: files.map((file) => file.path),
    definedIn(name, runner = "any") {
      const parts = name
        .replace(/\.py::/g, "::")
        .split(/::|\./)
        .filter(Boolean);
      const leaf = parts.at(-1);
      if (!leaf) return [];
      const qualifiers = parts.slice(0, -1);
      const found = definitions.filter(
        (entry) =>
          entry.name === leaf && entry.runners.includes(runner) && qualifies(entry, qualifiers),
      );
      if (found.length) return sortedPaths(found);
      if (qualifiers.length || runner === "unittest" || runner === "pytest") return [];
      const word = new RegExp(`(?<!\\w)${escapeRegExp(leaf)}(?!\\w)`);
      return sortedPaths(titles.filter((entry) => word.test(entry.title)));
    },
    testCount(runner) {
      if (runner === "unittest" || runner === "pytest")
        return countable.py ? pythonCount(runner) : undefined;
      if (runner === "js") return countable.js ? jsCount : undefined;
      return countable.py && countable.js ? pythonCount("pytest") + jsCount + goCount : undefined;
    },
    within(covers) {
      return sourcesOf(
        files.filter((file) => covers(file.path)),
        classes,
      );
    },
  };
}

export function scanTestSources(files: readonly TestSource[]): TestSources {
  const scanned = files.map(({ path, text }) => scanFile(path, text));
  return sourcesOf(scanned, new PythonClasses(scanned.flatMap((file) => file.classes)));
}

/** The test files of the project, read once: tracked and new files, none outside the project. */
export async function loadTestSources(workspace: WorkspaceState): Promise<TestSources> {
  const listed = await repositoryFiles(workspace.paths.root);
  const paths = (listed.ok ? listed.value : []).filter(isTestSourcePath).slice(0, MAX_FILES);
  const files: TestSource[] = [];
  for (const path of paths) {
    const text = await workspace.files.readTextIfExists(path);
    if (text.ok && text.value !== undefined) files.push({ path, text: text.value });
  }
  return scanTestSources(files);
}
