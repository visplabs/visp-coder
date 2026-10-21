import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

/** What decides how a project's test file runs: installed runners and pytest configuration. */
export interface TestRunnerFacts {
  /** Runner executables present in node_modules/.bin. */
  readonly binaries: ReadonlySet<string>;
  readonly pytestConfig: boolean;
}

const JS_RUNNERS = ["vitest", "jest", "mocha"] as const;
const PYTHON = process.platform === "win32" ? "python" : "python3";

export async function testRunnerFacts(root: string): Promise<TestRunnerFacts> {
  const binaries = new Set<string>();
  for (const runner of JS_RUNNERS)
    if (await exists(join(root, "node_modules", ".bin", runner))) binaries.add(runner);
  return { binaries, pytestConfig: await pytestConfigured(root) };
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

/**
 * The command that runs one existing test file the way its project runs it, or undefined when
 * VISP cannot tell. A wrong guess cannot invent a regression: it fails on the old code too.
 */
export function testFileCommand(
  path: string,
  source: string,
  facts: TestRunnerFacts,
): [string, ...string[]] | undefined {
  if (path.endsWith(".py")) return pythonCommand(path, source, facts);
  if (!/\.(?:[cm]?[jt]sx?)$/.test(path)) return undefined;
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

function pythonCommand(
  path: string,
  source: string,
  facts: TestRunnerFacts,
): [string, ...string[]] {
  const pytest: [string, ...string[]] = [PYTHON, "-m", "pytest", "-q", "-rfE", path];
  if (facts.pytestConfig || /^\s*(?:import|from) pytest\b/m.test(source)) return pytest;
  if (/\bunittest\b/.test(source)) return [PYTHON, "-m", "unittest", path];
  return /^def test_/m.test(source) ? pytest : [PYTHON, path];
}
