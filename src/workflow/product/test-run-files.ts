import type { TestRunnerKind } from "./test-sources.js";

/**
 * Which of the project's test files a check's run covered, where its output or command tells:
 * pytest's progress lines (`tests/test_a.py ....`), the start directory and pattern of
 * `python -m unittest discover`, the modules or files given to `python -m unittest` or `pytest`,
 * and the test files or directories a JavaScript runner's command names. A custom runner, a
 * script or `npm test` does not tell: then the result is undefined and every test file counts.
 */

type Covers = (path: string) => boolean;

const SHELL_OPERATORS = new Set(["&&", "||", ";", "|"]);
const PYTEST_PROGRESS = /^(\S+\.py) [.sxXfFE]+(?:\s+\[\s*\d+%\])?\s*$/gm;
/** unittest options that take a value, so the next word is not a module or a path. */
const UNITTEST_VALUES = new Set(["-k", "--durations"]);
const DISCOVER_OPTIONS: Record<string, "start" | "pattern" | "top"> = {
  "-s": "start",
  "--start-directory": "start",
  "-p": "pattern",
  "--pattern": "pattern",
  "-t": "top",
  "--top-level-directory": "top",
};

const unquote = (word: string) => word.replace(/^(["'])(.*)\1$/, "$2");
const clean = (path: string) => path.replace(/^\.\//, "").replace(/\/+$/, "");
const under = (path: string, directory: string) =>
  directory === "" || directory === "." || path.startsWith(`${directory}/`);
const baseName = (path: string) => path.split("/").at(-1) ?? path;

/** fnmatch's glob, as unittest matches a discovery pattern against a file name. */
function globMatcher(pattern: string): (name: string) => boolean {
  const source = pattern.replace(/\[!?[^\]]*\]|[*?]|[^*?[]+/g, (part) =>
    part === "*"
      ? ".*"
      : part === "?"
        ? "."
        : part.startsWith("[")
          ? part.replace(/^\[!/, "[^")
          : part.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"),
  );
  try {
    const matcher = new RegExp(`^${source}$`);
    return (name) => matcher.test(name);
  } catch {
    // A pattern VISP cannot read covers nothing it can name, so no test counts as run.
    return () => false;
  }
}

/** The words of the command that runs the tests, and the directory a leading `cd` moved to. */
function runnerWords(command: string, starts: (words: string[], index: number) => boolean) {
  const words = (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(unquote);
  let directory = "";
  let segment: string[] = [];
  for (const word of [...words, ";"]) {
    if (!SHELL_OPERATORS.has(word)) {
      segment.push(word);
      continue;
    }
    if (segment[0] === "cd" && segment[1]) directory = clean(segment[1]);
    const index = segment.findIndex((_, at) => starts(segment, at));
    if (index >= 0)
      return { runner: segment[index] ?? "", args: segment.slice(index + 1), directory };
    segment = [];
  }
  return undefined;
}

const inDirectory = (directory: string, path: string) =>
  directory ? clean(`${directory}/${path}`) : clean(path);

function discoverCovers(args: readonly string[], directory: string): Covers {
  const settings = { start: ".", pattern: "test*.py", top: "" };
  const positional: (keyof typeof settings)[] = ["start", "pattern", "top"];
  for (let index = 0; index < args.length; index++) {
    const word = args[index] ?? "";
    const [flag, inline] = word.split(/=(.*)/s);
    const option = DISCOVER_OPTIONS[flag ?? ""];
    if (option) settings[option] = inline ?? args[++index] ?? settings[option];
    else if (UNITTEST_VALUES.has(word)) index++;
    else if (!word.startsWith("-")) {
      const next = positional.shift();
      if (next) settings[next] = word;
    }
  }
  const start = inDirectory(directory, settings.start);
  const pattern = globMatcher(settings.pattern);
  return (path) => under(path, start) && pattern(baseName(path));
}

/** `python -m unittest a.b.C`, `tests/test_x.py`, or nothing, which discovers from `.`. */
function unittestCovers(args: readonly string[], directory: string): Covers {
  if (args[0] === "discover") return discoverCovers(args.slice(1), directory);
  const names: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const word = args[index] ?? "";
    if (UNITTEST_VALUES.has(word)) index++;
    else if (!word.startsWith("-")) names.push(word);
  }
  if (!names.length) return discoverCovers([], directory);
  return (path) =>
    names.some((name) => {
      if (name.includes("/") || name.endsWith(".py")) return path === inDirectory(directory, name);
      const module = path.replace(/\.py$/, "").split("/").join(".");
      const named = inDirectory(directory, name.split(".").join("/")).split("/").join(".");
      return module === named || named.startsWith(`${module}.`) || module.startsWith(`${named}.`);
    });
}

/** The words that name test files or directories the project has: `tests/`, `tests/test_a.py::test_x`. */
function namedPaths(args: readonly string[], directory: string, paths: readonly string[]) {
  return args
    .filter((word) => !word.startsWith("-"))
    .map((word) => inDirectory(directory, word.replace(/::.*$/, "")))
    .filter(
      (word) => word && word !== "." && paths.some((path) => path === word || under(path, word)),
    );
}

const pathCovers =
  (named: readonly string[]): Covers =>
  (path) =>
    named.some((entry) => path === entry || under(path, entry));

/** pytest's default `python_files`: `test_*.py` and `*_test.py`. */
const PYTEST_FILE = /^test_.*\.py$|_test\.py$/;

function pytestCovers(command: string, output: string, paths: readonly string[]) {
  const progress = new Set(
    [...output.matchAll(PYTEST_PROGRESS)].map((match) => clean(match[1] ?? "")),
  );
  if (progress.size) return (path: string) => progress.has(path);
  const words = runnerWords(
    command,
    (segment, at) =>
      /(?:^|\/)(?:pytest|py\.test)$/.test(segment[at] ?? "") ||
      (segment[at] === "pytest" && segment[at - 1] === "-m"),
  );
  if (!words) return undefined;
  const named = namedPaths(words.args, words.directory, paths);
  if (named.length) return pathCovers(named);
  return (path: string) => under(path, words.directory) && PYTEST_FILE.test(baseName(path));
}

export function testFilesRun(
  command: string,
  output: string,
  paths: readonly string[],
  runner: TestRunnerKind,
): Covers | undefined {
  if (runner === "pytest") return pytestCovers(command, output, paths);
  if (runner === "unittest") {
    const words = runnerWords(
      command,
      (segment, at) => segment[at] === "unittest" && segment[at - 1] === "-m",
    );
    return words ? unittestCovers(words.args, words.directory) : undefined;
  }
  if (runner !== "js") return undefined;
  const words = runnerWords(command, (segment, at) =>
    /(?:^|\/)(?:node|jest|mocha|vitest)$/.test(segment[at] ?? ""),
  );
  // `node script.mjs` runs whatever the script imports; only `node --test` runs the files named.
  if (!words || (/(?:^|\/)node$/.test(words.runner) && !words.args.includes("--test")))
    return undefined;
  const named = namedPaths(words.args, words.directory, paths);
  return named.length ? pathCovers(named) : undefined;
}
