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
    expect(sources.definitionCount).toBe(2);
    expect(sources.definedIn("test_a")).toEqual(["tests/test_sheet.py"]);
    expect(sources.definedIn("SheetTest")).toEqual(["tests/test_sheet.py"]);
    expect(sources.definedIn("test_sheet.SheetTest.test_a")).toEqual(["tests/test_sheet.py"]);
    expect(sources.definedIn("nowhere.SheetTest")).toEqual([]);
    expect(sources.definedIn("test_missing")).toEqual([]);
  });

  it("finds javascript titles and go functions, and counts it, test and func Test", () => {
    const sources = scan({
      "tests/game.test.js":
        "describe('game', () => {\n  it('gameTest exposes the hooks', () => {});\n  test.skip(\"other\", () => {});\n});",
      "pkg/a_test.go":
        "func TestOne(t *testing.T) {}\nfunc helper() {}\nfunc TestTwo(t *testing.T) {}",
    });
    expect(sources.definitionCount).toBe(4);
    expect(sources.definedIn("gameTest")).toEqual(["tests/game.test.js"]);
    expect(sources.definedIn("TestOne")).toEqual(["pkg/a_test.go"]);
    expect(sources.definedIn("gameTesting")).toEqual([]);
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
    expect(sources.definitionCount).toBe(1);
  });
});
