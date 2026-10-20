import { describe, expect, it } from "vitest";
import { patchPaths } from "../../../src/harness/scripts/patch-paths.script.mjs";

const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch", ""].join("\n");

describe("patchPaths", () => {
  it("names an added, an updated and a deleted file", () => {
    expect(
      patchPaths(
        patch(
          "*** Add File: src/new.ts",
          "+export const value = 1;",
          "*** Update File: src/old.ts",
          "@@ export function old",
          "-  return 1;",
          "+  return 2;",
          " }",
          "*** Delete File: src/gone.ts",
        ),
      ),
    ).toEqual(["src/new.ts", "src/old.ts", "src/gone.ts"]);
  });

  it("names both the old and the new path of a move", () => {
    expect(
      patchPaths(patch("*** Update File: src/a.ts", "*** Move to: lib/b.ts", "@@", "-a", "+b")),
    ).toEqual(["src/a.ts", "lib/b.ts"]);
  });

  it("keeps spaces inside a path and drops the line ending", () => {
    expect(
      patchPaths(
        ["*** Begin Patch", "*** Add File: notes/my file.txt", "+hello", "*** End Patch"].join(
          "\r\n",
        ),
      ),
    ).toEqual(["notes/my file.txt"]);
  });

  it("keeps absolute and relative paths as written", () => {
    expect(
      patchPaths(
        patch(
          "*** Add File: /work/project/src/a.ts",
          "+a",
          "*** Delete File: ../outside.ts",
          "*** Update File: ./src/b.ts",
          "@@",
          "-b",
          "+c",
        ),
      ),
    ).toEqual(["/work/project/src/a.ts", "../outside.ts", "./src/b.ts"]);
  });

  it("does not read added or context lines as headers", () => {
    expect(
      patchPaths(
        patch(
          "*** Add File: docs/patches.md",
          "+*** Update File: src/secret.ts",
          "*** Update File: docs/other.md",
          "@@",
          " *** Delete File: src/secret.ts",
          "-old",
          "+new",
          "*** End of File",
        ),
      ),
    ).toEqual(["docs/patches.md", "docs/other.md"]);
  });

  it("reads a patch passed through a heredoc", () => {
    expect(patchPaths(`apply_patch <<'EOF'\n${patch("*** Add File: a.txt", "+a")}EOF\n`)).toEqual([
      "a.txt",
    ]);
  });

  it("returns nothing for a patch it cannot read", () => {
    expect(patchPaths("")).toBeUndefined();
    expect(patchPaths("*** Add File: a.txt\n+a\n")).toBeUndefined();
    expect(patchPaths("*** Begin Patch\n*** Add File: a.txt\n+a\n")).toBeUndefined();
    expect(patchPaths(patch("*** Rename File: a.txt"))).toBeUndefined();
    expect(patchPaths(patch("*** Add File: a.txt", "plain text"))).toBeUndefined();
    expect(patchPaths(patch("*** Add File: "))).toBeUndefined();
    expect(patchPaths(patch("*** Update File: a.txt", "*** Move to: "))).toBeUndefined();
  });

  it("allows an empty patch", () => {
    expect(patchPaths(patch())).toEqual([]);
  });
});
