import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { run } from "../../../../src/core/exec.js";
import {
  captureFlipEnvironment,
  disposeFlipEnvironment,
  provideFlipEnvironment,
  sweepStaleFlipTemporary,
  unsnapshottedFlipState,
} from "../../../../src/workflow/product/flip/flip-environment.js";
import { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace | undefined;
const scratch: string[] = [];
afterEach(async () => {
  await workspace?.destroy();
  for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true });
});
async function tree() {
  const path = await mkdtemp(join(tmpdir(), "visp-environment-test-"));
  scratch.push(path);
  return path;
}
it("copies environment bytes, preserves relative links and rebinds absolute project links", async () => {
  workspace = await TestWorkspace.create({
    "src/pkg/value": "current",
    "node_modules/cache/value": "original",
  });
  await symlink("../src/pkg", join(workspace.root, "node_modules/relative"));
  await symlink(join(workspace.root, "src/pkg"), join(workspace.root, "node_modules/absolute"));
  const environment = await captureFlipEnvironment(workspace.root);
  try {
    await workspace.write("node_modules/cache/value", "after original");
    const comparison = await tree();
    await mkdir(join(comparison, "src/pkg"), { recursive: true });
    const fs = await import("node:fs/promises");
    await fs.writeFile(join(comparison, "src/pkg/value"), "baseline");
    await provideFlipEnvironment(workspace.root, comparison, environment);
    expect(await readFile(join(comparison, "node_modules/cache/value"), "utf8")).toBe("original");
    for (const name of ["relative", "absolute"])
      expect(await readFile(join(comparison, `node_modules/${name}/value`), "utf8")).toBe(
        "baseline",
      );
    await fs.writeFile(join(comparison, "node_modules/cache/value"), "comparison");
    expect(await readFile(join(workspace.root, "node_modules/cache/value"), "utf8")).toBe(
      "after original",
    );
  } finally {
    await disposeFlipEnvironment(environment);
  }
});
it("declines environments exceeding the byte bound before executing a comparison", async () => {
  workspace = await TestWorkspace.create({ "node_modules/cache/placeholder": "" });
  const file = await open(join(workspace.root, "node_modules/cache/large"), "w");
  await file.truncate(513 * 1024 * 1024);
  await file.close();
  const environment = await captureFlipEnvironment(workspace.root);
  expect(environment.directory).toBeUndefined();
  expect(environment.reason).toContain("512 MiB");
  await expect(provideFlipEnvironment(workspace.root, await tree(), environment)).rejects.toThrow(
    "512 MiB",
  );
});
it("isolates a Python virtualenv and rewrites editable-install paths to reverted source", async () => {
  workspace = await TestWorkspace.create({ "src/value.py": "value=2\n" });
  const created = await run("python3", ["-m", "venv", "--without-pip", ".venv"], {
    cwd: workspace.root,
    timeoutMs: 10000,
  });
  expect(created).toMatchObject({ ok: true, value: { exitCode: 0 } });
  const version = await run(
    ".venv/bin/python",
    ["-c", "import sys;print(f'python{sys.version_info.major}.{sys.version_info.minor}')"],
    { cwd: workspace.root, timeoutMs: 10000 },
  );
  if (!version.ok) throw new Error(version.error.message);
  await workspace.write(
    `.venv/lib/${version.value.stdout.trim()}/site-packages/editable.pth`,
    `${join(workspace.root, "src")}\n`,
  );
  const environment = await captureFlipEnvironment(workspace.root);
  try {
    const comparison = await tree();
    await mkdir(join(comparison, "src"));
    const fs = await import("node:fs/promises");
    await fs.writeFile(join(comparison, "src/value.py"), "value=1\n");
    await provideFlipEnvironment(workspace.root, comparison, environment);
    const output = await run(
      ".venv/bin/python",
      ["-c", "import value;assert value.value == 1;open('.venv/marker','w').write('comparison')"],
      { cwd: comparison, timeoutMs: 10000 },
    );
    expect(output).toMatchObject({ ok: true, value: { exitCode: 0 } });
    await expect(readFile(join(workspace.root, ".venv/marker"))).rejects.toThrow();
    expect(await readFile(join(workspace.root, "src/value.py"), "utf8")).toBe("value=2\n");
  } finally {
    await disposeFlipEnvironment(environment);
  }
});

it("materializes a linked environment directory and rebinds its workspace links", async () => {
  workspace = await TestWorkspace.create({
    "tools/deps/cache": "original",
    "src/pkg/value": "current",
  });
  await symlink("tools/deps", join(workspace.root, "node_modules"));
  await symlink("../../src/pkg", join(workspace.root, "tools/deps/pkg"));
  const environment = await captureFlipEnvironment(workspace.root);
  try {
    const comparison = await tree();
    await mkdir(join(comparison, "src/pkg"), { recursive: true });
    const fs = await import("node:fs/promises");
    await fs.writeFile(join(comparison, "src/pkg/value"), "baseline");
    await provideFlipEnvironment(workspace.root, comparison, environment);
    expect((await fs.stat(join(comparison, "node_modules"))).isDirectory()).toBe(true);
    expect(await readFile(join(comparison, "node_modules/pkg/value"), "utf8")).toBe("baseline");
    await fs.writeFile(join(comparison, "node_modules/cache"), "comparison");
    expect(await readFile(join(workspace.root, "tools/deps/cache"), "utf8")).toBe("original");
  } finally {
    await disposeFlipEnvironment(environment);
  }
});

it("rebases oversized editable-install metadata that names the project, at any size", async () => {
  workspace = await TestWorkspace.create({
    ".venv/editable.pth": "placeholder\n",
  });
  const root = workspace.root;
  await workspace.write(".venv/editable.pth", `${root}/src\n`.repeat(100000));
  const environment = await captureFlipEnvironment(workspace.root);
  expect(environment.reason).toBeUndefined();
  const comparison = await tree();
  try {
    await provideFlipEnvironment(workspace.root, comparison, environment);
    const text = await readFile(join(comparison, ".venv/editable.pth"), "utf8");
    expect(text).toBe(`${comparison}/src\n`.repeat(100000));
  } finally {
    await disposeFlipEnvironment(environment);
  }
});
it("returns a reason instead of rejecting when the temporary directory is unusable", async () => {
  workspace = await TestWorkspace.create({ "src/value.mjs": "export const value = 1;\n" });
  vi.stubEnv("TMPDIR", "/nonexistent-visp-capture");
  try {
    await expect(captureFlipEnvironment(workspace.root)).resolves.toMatchObject({
      reason: expect.stringContaining("mkdtemp"),
    });
  } finally {
    vi.unstubAllEnvs();
  }
});
it("refuses a comparison when git-ignored local state it cannot reproduce is present", async () => {
  workspace = await TestWorkspace.create({
    ".gitignore": "local/\n",
    "src/value.mjs": "export const value = 1;\n",
    "local/flag": "1",
  });
  const environment = await captureFlipEnvironment(workspace.root);
  expect(environment.directory).toBeUndefined();
  expect(environment.reason).toBe(
    "the project has git-ignored local state the comparison cannot reproduce: local",
  );
  await expect(provideFlipEnvironment(workspace.root, await tree(), environment)).rejects.toThrow(
    "git-ignored local state the comparison cannot reproduce: local",
  );
  expect(await readFile(join(workspace.root, "local/flag"), "utf8")).toBe("1");
  await expect(unsnapshottedFlipState(workspace.root)).resolves.toBe(environment.reason);
});
it("names the first three unreproducible paths and ignores regenerable caches", async () => {
  workspace = await TestWorkspace.create({
    ".gitignore": ".env\nlocal/\nsecrets.txt\n__pycache__/\ndist/\n*.pyc\n",
    "src/value.mjs": "export const value = 1;\n",
    ".env": "A=1\n",
    "local/flag": "1",
    "secrets.txt": "x",
    "__pycache__/value.cpython-310.pyc": "b",
    "dist/app.js": "d",
  });
  const environment = await captureFlipEnvironment(workspace.root);
  expect(environment.reason).toBe(
    "the project has git-ignored local state the comparison cannot reproduce: .env, local, secrets.txt",
  );
});
it("copies regenerable git-ignored caches and build output into the comparison", async () => {
  workspace = await TestWorkspace.create({
    ".gitignore": "__pycache__/\n.pytest_cache/\n*.egg-info/\ndist/\n",
    "src/value.mjs": "export const value = 1;\n",
    "__pycache__/value.cpython-310.pyc": "b",
    ".pytest_cache/v": "c",
    "src/pkg.egg-info/PKG-INFO": "p",
    "dist/cli.mjs": "console.log('2');\n",
  });
  const environment = await captureFlipEnvironment(workspace.root);
  expect(environment.reason).toBeUndefined();
  const comparison = await tree();
  try {
    await provideFlipEnvironment(workspace.root, comparison, environment);
    expect(await readFile(join(comparison, "dist/cli.mjs"), "utf8")).toBe("console.log('2');\n");
    expect(await readFile(join(comparison, ".pytest_cache/v"), "utf8")).toBe("c");
  } finally {
    await disposeFlipEnvironment(environment);
  }
});
// Python writes the source's absolute path into each .pyc, and the bytecode cannot be rebased,
// so copying a cache refused every comparison in a project whose tests had run (Django, Sphinx).
it("leaves Python bytecode caches out: the comparison's interpreter rebuilds them", async () => {
  workspace = await TestWorkspace.create({
    ".gitignore": "__pycache__\n*.py[co]\n",
    "pkg/value.py": "VALUE = 1\n",
  });
  const compiled = Buffer.concat([
    Buffer.from([0x6f, 0x0d, 0x0d, 0x0a, 0, 0]),
    Buffer.from(join(workspace.root, "pkg/value.py")),
  ]);
  await workspace.write("pkg/__pycache__/value.cpython-310.pyc", compiled);
  await workspace.write("pkg/stale.pyc", compiled);
  expect((await unsnapshottedFlipState(workspace.root)) ?? "").not.toMatch(/pycache|\.pyc/);
  const environment = await captureFlipEnvironment(workspace.root);
  expect(environment.reason).toBeUndefined();
  const comparison = await tree();
  try {
    await provideFlipEnvironment(workspace.root, comparison, environment);
    await expect(
      readFile(join(comparison, "pkg/__pycache__/value.cpython-310.pyc")),
    ).rejects.toThrow();
    await expect(readFile(join(comparison, "pkg/stale.pyc"))).rejects.toThrow();
  } finally {
    await disposeFlipEnvironment(environment);
  }
});
it("blocks a comparison when the original run created ignored state the snapshot never held", async () => {
  workspace = await TestWorkspace.create({
    ".gitignore": "*.log\ndist/\n",
    "src/value.mjs": "export const value = 1;\n",
    "dist/cli.mjs": "x",
  });
  const environment = await captureFlipEnvironment(workspace.root);
  expect(environment.reason).toBeUndefined();
  try {
    await workspace.write("run.log", "created by the original run");
    await expect(provideFlipEnvironment(workspace.root, await tree(), environment)).rejects.toThrow(
      "git-ignored local state the comparison cannot reproduce: run.log",
    );
  } finally {
    await disposeFlipEnvironment(environment);
  }
});
it("blocks the reuse path on any git-ignored entry, regenerable or not", async () => {
  workspace = await TestWorkspace.create({
    ".gitignore": "dist/\n",
    "src/value.mjs": "export const value = 1;\n",
    "dist/cli.mjs": "x",
  });
  await expect(unsnapshottedFlipState(workspace.root)).resolves.toBe(
    "the project has git-ignored local state the comparison cannot reproduce: dist",
  );
});
it("refuses an individually listed git-ignored file in a directory the tree tracks", async () => {
  workspace = await TestWorkspace.create({
    ".gitignore": "*.log\n",
    "src/value.mjs": "export const value = 1;\n",
    "src/debug.log": "trace\n",
  });
  const environment = await captureFlipEnvironment(workspace.root);
  expect(environment.reason).toBe(
    "the project has git-ignored local state the comparison cannot reproduce: src/debug.log",
  );
});
it("removes a read-only directory from the snapshot of an environment root", async () => {
  workspace = await TestWorkspace.create({
    ".gitignore": "node_modules/\n",
    "node_modules/locked/file.txt": "support",
    "src/value.mjs": "export const value = 1;\n",
  });
  await chmod(join(workspace.root, "node_modules/locked"), 0o555);
  try {
    const environment = await captureFlipEnvironment(workspace.root);
    expect(environment.reason).toBeUndefined();
    const snapshot = environment.directory as string;
    expect(existsSync(join(snapshot, "node_modules/locked/file.txt"))).toBe(true);
    await disposeFlipEnvironment(environment);
    expect(existsSync(snapshot)).toBe(false);
  } finally {
    await chmod(join(workspace.root, "node_modules/locked"), 0o755);
  }
});
it("sweeps flip temporary trees that an earlier run left behind, but keeps recent ones", async () => {
  const directory = await mkdtemp(join(tmpdir(), "visp-sweep-test-"));
  vi.stubEnv("TMPDIR", directory);
  try {
    const stale = join(directory, "visp-product-flip-AAAAAA");
    const recent = join(directory, "visp-flip-environment-BBBBBB");
    await mkdir(stale);
    await mkdir(recent);
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    await utimes(stale, old, old);
    await sweepStaleFlipTemporary();
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
it("rewrites every spelling of the project root in copied text, across a step boundary", async () => {
  const step = 1024 * 1024;
  workspace = await TestWorkspace.create({
    ".gitignore": "node_modules/\n",
    "src/value.mjs": "export const value = 1;\n",
  });
  const root = workspace.root;
  const straddling = `${"a".repeat(step - 8)} ${root}/counter.txt tail`;
  await mkdir(join(workspace.root, "node_modules"), { recursive: true });
  await workspace.write("node_modules/big.txt", straddling);
  await workspace.write("node_modules/names.txt", `${root}-other ${root}/file\n`);
  const environment = await captureFlipEnvironment(workspace.root);
  expect(environment.reason).toBeUndefined();
  const comparison = await tree();
  try {
    await provideFlipEnvironment(workspace.root, comparison, environment);
    const big = await readFile(join(comparison, "node_modules/big.txt"), "utf8");
    expect(big).toBe(`${"a".repeat(step - 8)} ${comparison}/counter.txt tail`);
    expect(await readFile(join(comparison, "node_modules/names.txt"), "utf8")).toBe(
      `${root}-other ${comparison}/file\n`,
    );
  } finally {
    await disposeFlipEnvironment(environment);
  }
});
it("refuses a binary file that names the project and copies other binary bytes unchanged", async () => {
  workspace = await TestWorkspace.create({
    ".gitignore": "node_modules/\n",
    "src/value.mjs": "export const value = 1;\n",
  });
  await mkdir(join(workspace.root, "node_modules"), { recursive: true });
  await writeFile(
    join(workspace.root, "node_modules/blob.bin"),
    Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(workspace.root)]),
  );
  await writeFile(join(workspace.root, "node_modules/raw.bin"), Buffer.from([0, 2, 3, 255]));
  const environment = await captureFlipEnvironment(workspace.root);
  expect(environment.reason).toBeUndefined();
  const comparison = await tree();
  try {
    await expect(provideFlipEnvironment(workspace.root, comparison, environment)).rejects.toThrow(
      "node_modules/blob.bin refers to the project by absolute path",
    );
  } finally {
    await disposeFlipEnvironment(environment);
  }
  await rm(join(workspace.root, "node_modules/blob.bin"));
  const other = await captureFlipEnvironment(workspace.root);
  const copy = await tree();
  try {
    await provideFlipEnvironment(workspace.root, copy, other);
    expect(await readFile(join(copy, "node_modules/raw.bin"))).toEqual(Buffer.from([0, 2, 3, 255]));
  } finally {
    await disposeFlipEnvironment(other);
  }
});
it("rebases a project root only where a path boundary stands on both sides", async () => {
  workspace = await TestWorkspace.create({
    ".gitignore": "node_modules/\n",
    "src/value.mjs": "export const value = 1;\n",
  });
  const root = workspace.root;
  await workspace.write("node_modules/paths.txt", `x${root}/a ${root}/b\n`);
  const environment = await captureFlipEnvironment(workspace.root);
  expect(environment.reason).toBeUndefined();
  const comparison = await tree();
  try {
    await provideFlipEnvironment(workspace.root, comparison, environment);
    expect(await readFile(join(comparison, "node_modules/paths.txt"), "utf8")).toBe(
      `x${root}/a ${comparison}/b\n`,
    );
  } finally {
    await disposeFlipEnvironment(environment);
  }
});
it.each([
  ["little-endian", (text: string) => Buffer.from(text, "utf16le")],
  ["big-endian", (text: string) => Buffer.from(text, "utf16le").swap16()],
])("refuses a %s UTF-16 file that names the project", async (_name, encode) => {
  workspace = await TestWorkspace.create({
    ".gitignore": "node_modules/\n",
    "src/value.mjs": "export const value = 1;\n",
  });
  await mkdir(join(workspace.root, "node_modules"), { recursive: true });
  await writeFile(join(workspace.root, "node_modules/wide.bin"), encode(`${workspace.root}/a`));
  const environment = await captureFlipEnvironment(workspace.root);
  expect(environment.reason).toBeUndefined();
  try {
    await expect(provideFlipEnvironment(workspace.root, await tree(), environment)).rejects.toThrow(
      "node_modules/wide.bin refers to the project by absolute path",
    );
  } finally {
    await disposeFlipEnvironment(environment);
  }
});
