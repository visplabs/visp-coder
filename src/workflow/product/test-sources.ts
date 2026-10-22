import { repositoryFiles } from "../../core/git.js";
import { isTestFile } from "../module-paths.js";
import type { WorkspaceState } from "../state.js";

/**
 * What the project's test files define, read with a text scan and no model: `def test_x`,
 * `class XTest`, `it("x")`, `test("x")`, `func TestX`. The account check uses it when a runner
 * prints only dots and a summary, to see that a test the worker names exists.
 */

export interface TestSource {
  readonly path: string;
  readonly text: string;
}

export interface TestSources {
  /** The test files that define `name` (`test_x`, `XTest`, `module.Class.method`, or a word of a title). */
  definedIn(name: string): string[];
  /** How many tests the files define (`def test…`, `it(…)`, `test(…)`, `func Test…`). */
  readonly definitionCount: number;
}

const PY_DEF = /^[ \t]*(?:async[ \t]+)?def[ \t]+(\w+)/gm;
const PY_CLASS = /^[ \t]*class[ \t]+(\w+)/gm;
const GO_FUNC = /^func[ \t]+(Test\w*)/gm;
const JS_NAME = /\b(?:function|class|const|let|var)[ \t]+(\w+)/g;
const JS_TITLE = /\b(it|test|describe)(?:\.\w+)*\(\s*(["'`])((?:\\.|(?!\2).)*)\2/g;

const TEST_PATH = /(?:^|\/)test_[^/]*\.py$|_test\.(?:py|go)$|(?:Test|Tests)\.(?:java|kt|cs|php)$/;
const SCANNED = /\.(?:py|js|mjs|cjs|ts|tsx|jsx|go|rb|java|kt|cs|php)$/;
const MAX_FILES = 400;

export function isTestSourcePath(path: string): boolean {
  return SCANNED.test(path) && (isTestFile(path) || TEST_PATH.test(path));
}

function matches(text: string, pattern: RegExp): RegExpExecArray[] {
  return [...text.matchAll(pattern)];
}

function moduleOf(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.[^.]+$/, "");
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface FileScan {
  readonly names: string[];
  readonly titles: string[];
  /** Tests the file defines: `def test…`, `func Test…`, and `it(…)` / `test(…)` calls. */
  readonly tests: number;
}

function scanFile(text: string): FileScan {
  const defs = matches(text, PY_DEF).map((match) => match[1] ?? "");
  const goTests = matches(text, GO_FUNC).map((match) => match[1] ?? "");
  const calls = matches(text, JS_TITLE);
  return {
    names: [
      ...defs,
      ...goTests,
      ...matches(text, PY_CLASS).map((match) => match[1] ?? ""),
      ...matches(text, JS_NAME).map((match) => match[1] ?? ""),
    ].filter(Boolean),
    titles: calls.map((match) => match[3] ?? "").filter(Boolean),
    tests:
      defs.filter((name) => name.startsWith("test")).length +
      goTests.length +
      calls.filter((match) => match[1] !== "describe").length,
  };
}

export function scanTestSources(files: readonly TestSource[]): TestSources {
  const identifiers = new Map<string, Set<string>>();
  const modules = new Set<string>();
  const titles: { path: string; title: string }[] = [];
  let definitionCount = 0;
  for (const { path, text } of files) {
    modules.add(moduleOf(path));
    const scanned = scanFile(text);
    definitionCount += scanned.tests;
    for (const name of scanned.names)
      identifiers.set(name, (identifiers.get(name) ?? new Set<string>()).add(path));
    for (const title of scanned.titles) titles.push({ path, title });
  }
  const inTitle = (name: string): string[] => {
    const word = new RegExp(`(?<!\\w)${escapeRegExp(name)}(?!\\w)`);
    return titles.filter((entry) => word.test(entry.title)).map((entry) => entry.path);
  };
  return {
    definitionCount,
    definedIn(name) {
      const parts = name.split(/::|\./).filter(Boolean);
      const leaf = parts.at(-1);
      if (!leaf) return [];
      // A qualifier names a test file or an enclosing class: it must exist too.
      const qualified = parts
        .slice(0, -1)
        .every((part) => modules.has(part) || identifiers.has(part));
      if (!qualified) return [];
      const found = identifiers.get(leaf);
      return [...new Set(found ?? inTitle(leaf))].sort();
    },
  };
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
