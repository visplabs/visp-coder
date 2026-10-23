import { access, readFile } from "node:fs/promises";
import { basename, dirname, join, posix } from "node:path";

/** What decides how a project's test file runs: installed runners and pytest configuration. */
export interface TestRunnerFacts {
  /** Runner executables present in node_modules/.bin. */
  readonly binaries: ReadonlySet<string>;
  readonly pytestConfig: boolean;
  /** Django's own runner (`tests/runtests.py`), which its tests need for their settings. */
  readonly djangoRunner?: string;
}

/** A runner a declared check uses: its argv before the test targets, and how it names a test. */
export interface DeclaredRunner {
  readonly style: "django" | "pytest" | "unittest" | "node" | "vitest" | "jest" | "mocha";
  readonly prefix: readonly string[];
  /** Django labels are dotted paths below the runner's directory. */
  readonly labelRoot?: string;
  /** `unittest discover`: a test runs by dotted module name, as discovery names it. */
  readonly discover?: boolean;
}

export type TestLanguage = "python" | "javascript";

const JS_RUNNERS = ["vitest", "jest", "mocha"] as const;
const PYTHON_STYLES: ReadonlySet<DeclaredRunner["style"]> = new Set([
  "django",
  "pytest",
  "unittest",
]);
const PYTHON = process.platform === "win32" ? "python" : "python3";
const DJANGO_RUNNER = "tests/runtests.py";
/** Options of the runners above that take a separate value, which is never a test target. */
const VALUED = new Set([
  "--parallel",
  "--settings",
  "--verbosity",
  "-v",
  "--tag",
  "--exclude-tag",
  "-k",
  "-m",
  "-p",
  "-c",
  "--rootdir",
  "--start-at",
  "--start-after",
  "--test-reporter",
  "--test-name-pattern",
  "-t",
  "--config",
]);

export async function testRunnerFacts(root: string): Promise<TestRunnerFacts> {
  const binaries = new Set<string>();
  for (const runner of JS_RUNNERS)
    if (await exists(join(root, "node_modules", ".bin", runner))) binaries.add(runner);
  return {
    binaries,
    pytestConfig: await pytestConfigured(root),
    ...((await exists(join(root, DJANGO_RUNNER))) ? { djangoRunner: DJANGO_RUNNER } : {}),
  };
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function pytestConfigured(root: string): Promise<boolean> {
  if ((await exists(join(root, "pytest.ini"))) || (await exists(join(root, "conftest.py"))))
    return true;
  const sections: Array<[string, RegExp]> = [
    ["pyproject.toml", /^\[tool\.pytest/m],
    ["setup.cfg", /^\[tool:pytest\]/m],
    ["tox.ini", /^\[pytest\]/m],
  ];
  for (const [file, section] of sections) {
    const text = await readFile(join(root, file), "utf8").catch(() => "");
    if (section.test(text)) return true;
  }
  return false;
}

export function testLanguage(path: string): TestLanguage | undefined {
  if (path.endsWith(".py")) return "python";
  return /\.(?:[cm]?[jt]sx?)$/.test(path) ? "javascript" : undefined;
}

/**
 * A file a test runner collects: named as a test (`test_*.py`, `*_test.py`, `tests.py`,
 * `*.test.*`, `*.spec.*`, `__tests__/`) and defining at least one test. Package markers,
 * templates, fixtures and helpers under a tests directory are not tests.
 */
export function isRunnableTestFile(path: string, source: string): boolean {
  const name = basename(path);
  const language = testLanguage(path);
  if (language === "python")
    return (
      /^(?:test_.+|.+_test|tests)\.py$/.test(name) &&
      /^\s*(?:async\s+)?def test|^\s*class \w*Test\w*\b|TestCase\)/m.test(source)
    );
  if (language === "javascript")
    return (
      (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name) || /(?:^|\/)__tests__\//.test(path)) &&
      /\b(?:test|it|describe)\s*\(/.test(source)
    );
  return false;
}

/** The runner a declared check uses, or undefined when it runs no known test framework. */
export function declaredRunner(
  argv: readonly string[],
  exists: (path: string) => boolean,
): DeclaredRunner | undefined {
  const found = runnerToken(argv);
  if (!found) return undefined;
  const { style, end } = found;
  const labelRoot =
    style === "django" ? posix.normalize(dirname(argv[end - 1] ?? "")).replace(/^\.\//, "") : "";
  const rest = argv.slice(end);
  if (style === "unittest" && rest.includes("discover"))
    return { style, prefix: discoverPrefix(argv.slice(0, end), rest), discover: true };
  const kept: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index] ?? "";
    if (VALUED.has(arg)) {
      kept.push(arg, ...(rest[index + 1] === undefined ? [] : [rest[index + 1] as string]));
      index++;
    } else if (!isTarget(arg, style, labelRoot, exists)) kept.push(arg);
  }
  return {
    style,
    prefix: [...argv.slice(0, end), ...kept],
    ...(style === "django" ? { labelRoot } : {}),
  };
}

/**
 * unittest's own options that take a separate value. `-v`, `-q`, `-f`, `-c`, `-b`, `--locals`
 * and their long forms are flags; `VALUED` lists `-v` and `-c` for Django and pytest, where they
 * take one. `--durations` is Python 3.12 and later.
 */
const UNITTEST_VALUED = new Set(["-k", "--durations"]);
/** Options of `unittest discover` that choose where to look, which a named module replaces. */
const DISCOVER_VALUED = new Set([
  "-s",
  "--start-directory",
  "-t",
  "--top-level-directory",
  "-p",
  "--pattern",
]);

/**
 * What stays of a `unittest discover` check once the start directory, top-level directory and
 * pattern are gone: the interpreter and its flags, then the options such as `-v`. A name
 * resolves from the working directory, which isolated mode (`-I`) leaves off the import path,
 * so `-I` becomes its other two parts.
 */
function discoverPrefix(runner: readonly string[], rest: readonly string[]): string[] {
  const kept: string[] = [];
  let found = false;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index] ?? "";
    if (DISCOVER_VALUED.has(arg)) index++;
    else if (!found && arg === "discover") found = true;
    else if (arg.startsWith("-")) {
      kept.push(arg);
      if (UNITTEST_VALUED.has(arg) && rest[index + 1] !== undefined)
        kept.push(rest[++index] as string);
    }
  }
  return [...runner.flatMap((arg) => (arg === "-I" ? ["-E", "-s"] : [arg])), ...kept];
}

function runnerToken(
  argv: readonly string[],
): { style: DeclaredRunner["style"]; end: number } | undefined {
  for (const index of argv.keys()) {
    const found = tokenStyle(argv, index);
    if (found) return { style: found.style, end: index + found.width };
  }
  return undefined;
}

/** The runner argv[index] starts, and how many arguments name it (`-m pytest` is two). */
function tokenStyle(
  argv: readonly string[],
  index: number,
): { style: DeclaredRunner["style"]; width: number } | undefined {
  const arg = argv[index] ?? "";
  const name = basename(arg);
  const module = argv[index + 1];
  if (name === "runtests.py") return { style: "django", width: 1 };
  if (name === "pytest" || name === "py.test") return { style: "pytest", width: 1 };
  if (arg === "-m" && (module === "pytest" || module === "unittest"))
    return { style: module, width: 2 };
  if (arg === "--test" && /^node(?:\.exe)?$/.test(basename(argv[index - 1] ?? "")))
    return { style: "node", width: 1 };
  const runner = JS_RUNNERS.find((candidate) => candidate === name);
  return runner ? { style: runner, width: 1 } : undefined;
}

/** A test file, node id or dotted label the declared check runs, as opposed to an option. */
function isTarget(
  arg: string,
  style: DeclaredRunner["style"],
  labelRoot: string,
  exists: (path: string) => boolean,
) {
  if (arg.startsWith("-")) return false;
  const path = arg.split("::")[0] ?? "";
  if (path.includes("/") || /\.(?:py|[cm]?[jt]sx?)$/.test(path)) return true;
  if ((style === "django" || style === "unittest") && /^[A-Za-z_][\w.]*$/.test(arg)) {
    const first = arg.split(".")[0] ?? "";
    return exists(labelRoot ? `${labelRoot}/${first}` : first);
  }
  return false;
}

/**
 * The classes of a Python test file whose bodies mention a needle, so only they run; undefined
 * when every class or none does, and the whole module runs.
 */
export function pythonTestClasses(
  source: string,
  needles: readonly string[],
): string[] | undefined {
  const classes: { name: string; body: string[] }[] = [];
  for (const line of source.split(/\r?\n/)) {
    const opened = /^class (\w+)\b/.exec(line);
    if (opened) classes.push({ name: opened[1] ?? "", body: [line] });
    else if (/^[^\s@#]/.test(line)) classes.push({ name: "", body: [] });
    else classes.at(-1)?.body.push(line);
  }
  const tests = classes.filter((entry) => entry.name);
  const words = needles.map((needle) => new RegExp(`\\b${escapeRegExp(needle)}\\b`));
  const matching = tests
    .filter((entry) => words.some((word) => word.test(entry.body.join("\n"))))
    .map((entry) => entry.name);
  return matching.length && matching.length < tests.length ? matching : undefined;
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The command that runs one existing test file the way its project runs it, or undefined when
 * VISP cannot tell: a declared check's runner of the file's language first, then Django's own
 * runner, then the runner the file or project names. A wrong guess cannot invent a
 * regression: it fails on the old code too.
 */
export function testFileCommand(
  path: string,
  source: string,
  facts: TestRunnerFacts,
  options: { runners?: readonly DeclaredRunner[]; classes?: readonly string[] } = {},
): [string, ...string[]] | undefined {
  const language = testLanguage(path);
  if (!language) return undefined;
  const classes = language === "python" ? (options.classes ?? []) : [];
  const declared = options.runners?.find(
    (runner) =>
      PYTHON_STYLES.has(runner.style) === (language === "python") &&
      (runner.style !== "django" || isBelow(path, runner.labelRoot ?? "")),
  );
  if (declared) return withTargets(declared.prefix, targets(declared, path, classes));
  if (language === "python") return pythonCommand(path, source, facts, classes);
  return javascriptCommand(path, source, facts);
}

function withTargets(prefix: readonly string[], targets: readonly string[]): [string, ...string[]] {
  return [...prefix, ...targets] as [string, ...string[]];
}

function isBelow(path: string, root: string) {
  return root === "" || path.startsWith(`${root}/`);
}

function targets(runner: DeclaredRunner, path: string, classes: readonly string[]): string[] {
  if (runner.style === "django") {
    const label = dotted(path.slice((runner.labelRoot ?? "").length).replace(/^\//, ""));
    return classes.length ? classes.map((name) => `${label}.${name}`) : [label];
  }
  if (runner.style === "pytest")
    return classes.length ? classes.map((name) => `${path}::${name}`) : [path];
  if (runner.style === "unittest" && runner.discover)
    return classes.length ? classes.map((name) => `${dotted(path)}.${name}`) : [dotted(path)];
  if (runner.style === "unittest")
    return classes.length ? classes.map((name) => `${dotted(path)}.${name}`) : [path];
  return [path];
}

function dotted(path: string) {
  return path.replace(/\.py$/, "").replaceAll("/", ".");
}

function pythonCommand(
  path: string,
  source: string,
  facts: TestRunnerFacts,
  classes: readonly string[],
): [string, ...string[]] {
  if (facts.djangoRunner && isBelow(path, dirname(facts.djangoRunner))) {
    const django = {
      style: "django" as const,
      prefix: [PYTHON, facts.djangoRunner],
      labelRoot: dirname(facts.djangoRunner),
    };
    return withTargets(django.prefix, targets(django, path, classes));
  }
  const pytest = { style: "pytest" as const, prefix: [PYTHON, "-m", "pytest", "-q", "-rfE"] };
  const unittest = { style: "unittest" as const, prefix: [PYTHON, "-m", "unittest"] };
  if (facts.pytestConfig || /^\s*(?:import|from) pytest\b/m.test(source))
    return withTargets(pytest.prefix, targets(pytest, path, classes));
  if (/\bunittest\b/.test(source))
    return withTargets(unittest.prefix, targets(unittest, path, classes));
  return /^def test_/m.test(source)
    ? withTargets(pytest.prefix, targets(pytest, path, classes))
    : [PYTHON, path];
}

function javascriptCommand(
  path: string,
  source: string,
  facts: TestRunnerFacts,
): [string, ...string[]] | undefined {
  const runner = JS_RUNNERS.find((name) => facts.binaries.has(name));
  if (runner === "vitest") return ["node_modules/.bin/vitest", "run", path];
  if (runner === "jest") return ["node_modules/.bin/jest", "--ci", path];
  if (runner === "mocha") return ["node_modules/.bin/mocha", path];
  // Without a runner, node runs plain JavaScript only: no TypeScript, no JSX.
  if (/\.(?:[cm]?ts|[jt]sx)$/.test(path)) return undefined;
  // TAP, not the spec reporter whose default differs by Node version and terminal.
  return /["']node:test["']/.test(source)
    ? ["node", "--test", "--test-reporter=tap", path]
    : ["node", path];
}
