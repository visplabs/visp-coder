import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RecoveringProjectFileSystem } from "../../../../src/core/file-transaction.js";
import {
  isTestSourcePath,
  loadTestSources,
  scanTestSources,
} from "../../../../src/workflow/product/test-sources.js";

const scan = (files: Record<string, string>) =>
  scanTestSources(Object.entries(files).map(([path, text]) => ({ path, text })));

describe("scanTestSources", () => {
  it("finds python methods, classes and module-qualified names, and counts tests", () => {
    const sources = scan({
      "tests/test_sheet.py":
        "class SheetTest(TestCase):\n    def test_a(self): pass\n    def helper(self): pass\n    async def test_b(self): pass\n",
    });
    expect(sources.testCount("unittest")).toBe(2);
    expect(sources.definedIn("test_a")).toEqual(["tests/test_sheet.py"]);
    expect(sources.definedIn("SheetTest")).toEqual(["tests/test_sheet.py"]);
    expect(sources.definedIn("test_sheet.SheetTest.test_a")).toEqual(["tests/test_sheet.py"]);
    expect(sources.definedIn("tests.test_sheet.SheetTest.test_a")).toEqual(["tests/test_sheet.py"]);
    expect(sources.definedIn("nowhere.SheetTest")).toEqual([]);
    expect(sources.definedIn("test_missing")).toEqual([]);
  });

  it("finds javascript titles and go functions, and counts it and test calls", () => {
    const sources = scan({
      "tests/game.test.js":
        "describe('game', () => {\n  it('gameTest exposes the hooks', () => {});\n  test.skip(\"other\", () => {});\n});",
      "pkg/a_test.go":
        "func TestOne(t *testing.T) {}\nfunc helper() {}\nfunc TestTwo(t *testing.T) {}",
    });
    expect(sources.testCount("js")).toBe(2);
    expect(sources.definedIn("gameTest")).toEqual(["tests/game.test.js"]);
    expect(sources.definedIn("TestOne")).toEqual(["pkg/a_test.go"]);
    expect(sources.definedIn("helper")).toEqual([]);
    expect(sources.definedIn("gameTesting")).toEqual([]);
  });

  it("does not take helpers, fixtures or plain classes in a test file for tests", () => {
    const sources = scan({
      "tests/test_api.py": [
        "import unittest",
        "def post_json(path, body):",
        "    return None",
        "class Helpers:",
        "    def make_item(self): pass",
        "class ApiTest(unittest.TestCase):",
        "    def setUp(self): pass",
        "    def test_post(self):",
        "        def test_inner(): pass",
        "        post_json('/x', {})",
      ].join("\n"),
      "tests/api.test.js": [
        "const postJson = () => {};",
        "function makeServer() {}",
        "class FakeClock {}",
        "test('posts an item', () => {});",
      ].join("\n"),
    });
    for (const name of ["post_json", "Helpers", "make_item", "setUp", "test_inner"])
      expect(sources.definedIn(name), name).toEqual([]);
    for (const name of ["postJson", "makeServer", "FakeClock"])
      expect(sources.definedIn(name), name).toEqual([]);
    expect(sources.definedIn("test_post")).toEqual(["tests/test_api.py"]);
    expect(sources.definedIn("ApiTest")).toEqual(["tests/test_api.py"]);
    expect(sources.testCount("unittest")).toBe(1);
    expect(sources.testCount("js")).toBe(1);
  });

  it("counts tests the way each runner collects them, inherited methods included", () => {
    const sources = scan({
      "tests/test_store.py": [
        "class Base(unittest.TestCase):",
        "    def test_a(self): pass",
        "    def test_b(self): pass",
        "class Mem(Base): pass",
        "class Sql(",
        "    Base,",
        "):",
        "    def test_c(self): pass",
      ].join("\n"),
      "tests/test_plain.py": [
        "def test_function(): pass",
        "class TestGroup:",
        "    def test_one(self): pass",
        "class NotCollected:",
        "    def test_two(self): pass",
      ].join("\n"),
    });
    // unittest runs Base (2), Mem (2) and Sql (3), and no module-level function.
    expect(sources.testCount("unittest")).toBe(7);
    // pytest adds the function and the Test* class, and still skips NotCollected.
    expect(sources.testCount("pytest")).toBe(9);
    expect(sources.definedIn("Mem.test_a")).toEqual(["tests/test_store.py"]);
    expect(sources.definedIn("test_two")).toEqual([]);
    expect(sources.definedIn("Base.test_c")).toEqual([]);
  });

  it("cannot count parametrized or generated tests", () => {
    expect(
      scan({
        "tests/test_a.py":
          "@pytest.mark.parametrize('x', range(10))\ndef test_param(x):\n    assert x >= 0\n",
      }).testCount("pytest"),
    ).toBeUndefined();
    expect(
      scan({ "tests/a.test.js": "test.each([1, 2])('adds %i', (n) => {});" }).testCount("js"),
    ).toBeUndefined();
    expect(scan({ "tests/test_a.py": "def test_x(): pass\n" }).testCount("pytest")).toBe(1);
  });

  it("narrows to the files a run covered", () => {
    const sources = scan({
      "tests/test_a.py": "def test_one(): pass\ndef test_two(): pass\n",
      "tests/test_b.py": "def test_named(): pass\n",
    });
    const covered = sources.within((path) => path === "tests/test_a.py");
    expect(covered.testCount("pytest")).toBe(2);
    expect(covered.definedIn("test_named")).toEqual([]);
    expect(covered.definedIn("test_one")).toEqual(["tests/test_a.py"]);
    expect(sources.definedIn("test_named")).toEqual(["tests/test_b.py"]);
  });

  it("knows which paths are test sources", () => {
    expect(isTestSourcePath("tests/test_api.py")).toBe(true);
    expect(isTestSourcePath("src/api_test.go")).toBe(true);
    expect(isTestSourcePath("web/app.test.ts")).toBe(true);
    expect(isTestSourcePath("src/app.py")).toBe(false);
    expect(isTestSourcePath("tests/data.json")).toBe(false);
  });
});

describe("loadTestSources", () => {
  let root: string;
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads the test files of a repository, tracked or new, and nothing else", async () => {
    root = await mkdtemp(join(tmpdir(), "visp-test-sources-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    const files: Record<string, string> = {
      "tests/test_api.py": "def test_listed(): pass\n",
      "src/app.py": "def test_not_a_test_file(): pass\n",
      "node_modules/pkg/index.test.js": "it('ignored', () => {});\n",
    };
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    await writeFile(join(root, ".gitignore"), "node_modules/\n");
    const workspace = {
      paths: { root },
      files: new RecoveringProjectFileSystem(root),
    } as unknown as Parameters<typeof loadTestSources>[0];
    const sources = await loadTestSources(workspace);
    expect(sources.definedIn("test_listed")).toEqual(["tests/test_api.py"]);
    expect(sources.definedIn("test_not_a_test_file")).toEqual([]);
    expect(sources.testCount("pytest")).toBe(1);
  });
});
