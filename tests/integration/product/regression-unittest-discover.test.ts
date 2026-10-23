import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  declaredRunner,
  type TestRunnerFacts,
  testFileCommand,
} from "../../../src/workflow/product/regression/regression-runner.js";

const run = promisify(execFile);
const none: TestRunnerFacts = { binaries: new Set(), pytestConfig: false };
const PYTHON = process.platform === "win32" ? "python" : "python3";
const hasPython = spawnSync(PYTHON, ["--version"]).status === 0;

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const SOURCE = [
  "import unittest",
  "from app import double",
  "",
  "class DoubleTests(unittest.TestCase):",
  "    def test_double(self):",
  "        self.assertEqual(double(2), 4)",
  "",
  "class OtherTests(unittest.TestCase):",
  "    def test_other(self):",
  "        self.assertTrue(True)",
  "",
].join("\n");

/** A project whose declared check discovers `tests/`, with or without a package marker. */
async function project(options: { package: boolean }) {
  const root = await mkdtemp(join(tmpdir(), "visp-discover-"));
  roots.push(root);
  const files: Record<string, string> = {
    "app.py": "def double(value):\n    return value * 2\n",
    "tests/test_app.py": SOURCE,
    ...(options.package ? { "tests/__init__.py": "" } : {}),
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

async function ran(root: string, declared: string[], classes?: string[]) {
  const exists = (path: string) => existsSync(join(root, path));
  const runner = declaredRunner(declared, exists);
  const command = testFileCommand("tests/test_app.py", SOURCE, none, {
    runners: runner ? [runner] : [],
    ...(classes ? { classes } : {}),
  });
  if (!command) throw new Error("no command");
  const [file, ...args] = command;
  const result = await run(file, args, { cwd: root }).then(
    (done) => ({ code: 0, output: `${done.stdout}${done.stderr}` }),
    (failed: { code?: number; stdout?: string; stderr?: string }) => ({
      code: failed.code ?? 1,
      output: `${failed.stdout ?? ""}${failed.stderr ?? ""}`,
    }),
  );
  return { command, ...result };
}

const DECLARED = [
  [PYTHON, "-m", "unittest", "discover", "-s", "tests"],
  [PYTHON, "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py", "-v"],
  [PYTHON, "-m", "unittest", "discover"],
  [PYTHON, "-I", "-m", "unittest", "discover", "-s", "tests", "-t", ".", "-v"],
];

describe.skipIf(!hasPython)("the narrowed form of a declared unittest discover check", () => {
  for (const withPackage of [false, true]) {
    describe(withPackage ? "with tests/__init__.py" : "without tests/__init__.py", () => {
      it.each(DECLARED)("runs the test file's tests: %s", async (...declared) => {
        const root = await project({ package: withPackage });
        const result = await ran(root, declared);
        expect(result.output).toMatch(/Ran 2 tests/);
        expect(result.code).toBe(0);
      });

      it("runs only the named classes", async () => {
        const root = await project({ package: withPackage });
        const result = await ran(root, DECLARED[0] as string[], ["DoubleTests"]);
        expect(result.command.at(-1)).toBe("tests.test_app.DoubleTests");
        expect(result.output).toMatch(/Ran 1 test\b/);
        expect(result.code).toBe(0);
      });

      it("fails when a test fails", async () => {
        const root = await project({ package: withPackage });
        await writeFile(join(root, "app.py"), "def double(value):\n    return value + 3\n");
        const result = await ran(root, DECLARED[0] as string[]);
        expect(result.output).toMatch(/FAILED \(failures=1\)/);
        expect(result.code).not.toBe(0);
      });
    });
  }
});
