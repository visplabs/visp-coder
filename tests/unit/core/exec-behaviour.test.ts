/**
 * Characterization tests for src/core/exec.ts. They pin what run(), parseCommand() and
 * resolveCommand() do today, so a restructuring can be checked against them.
 */

import { getEventListeners } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunOptions } from "../../../src/core/exec.js";
import { parseCommand, resolveCommand, run } from "../../../src/core/exec.js";
import type { Result } from "../../../src/core/result.js";

const posix = process.platform !== "win32";
const realSetTimeout = globalThis.setTimeout;
const pause = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));

const METACHARACTERS = [..."|&;<>$`(){}[]!*?~"];
const HALF = 4 * 1024 * 1024;
const TRUNCATED = "\n[VISP: output truncated]\n";

let directory = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "visp-exec-behaviour-"));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

/** Runs a node script from the temp directory; `options` overrides the defaults. */
function runScript(script: string, options: Partial<RunOptions> = {}, extra: string[] = []) {
  return run(process.execPath, ["-e", script, ...extra], { cwd: directory, ...options });
}

async function runValue(script: string, options: Partial<RunOptions> = {}, extra: string[] = []) {
  const result = await runScript(script, options, extra);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function expectWords(result: Result<string[], unknown>, words: string[]) {
  expect(result).toEqual({ ok: true, value: words });
}

function shellSyntax(message: string) {
  return { ok: false, error: { kind: "shell-syntax", message } };
}

describe("parseCommand whitespace", () => {
  it.each([
    ["a space", "a b"],
    ["repeated spaces", "  a   b  "],
    ["a tab", "a\tb"],
    ["a newline", "a\nb"],
    ["a carriage return and newline", "a\r\nb"],
    ["a no-break space (U+00A0)", "a\u00a0b"],
  ])("splits on %s", (_name, input) => {
    expectWords(parseCommand(input), ["a", "b"]);
  });
});

describe("parseCommand quoting", () => {
  it.each([
    ['a "b c"', ["a", "b c"]],
    ["a 'b c'", ["a", "b c"]],
    ['a "it\'s"', ["a", "it's"]],
    ["a 'say \"hi\"'", ["a", 'say "hi"']],
    ['a pre"x y"post', ["a", "prex ypost"]],
    ["a \"\" ''", ["a", "", ""]],
    ["a\\ b", ["a\\", "b"]],
  ])("reads %j as %j", (input, words) => {
    expectWords(parseCommand(input), words);
  });

  it("keeps every shell metacharacter literal inside quotes", () => {
    const all = METACHARACTERS.join("");
    expect(METACHARACTERS).toHaveLength(17);
    expectWords(parseCommand(`a "${all}"`), ["a", all]);
    expectWords(parseCommand(`a '${all}'`), ["a", all]);
    for (const character of METACHARACTERS) {
      expectWords(parseCommand(`a "x ${character} y"`), ["a", `x ${character} y`]);
    }
  });
});

describe("parseCommand shell syntax", () => {
  const refusal = (character: string, input: string) =>
    shellSyntax(
      `Command contains shell syntax (${character}) and cannot run without a shell: ${input}`,
    );

  it.each(METACHARACTERS)("refuses an unquoted %s at the start, middle and end", (character) => {
    for (const input of [`${character}a b`, `a${character}b`, `a b${character}`]) {
      expect(parseCommand(input)).toEqual(refusal(character, input));
    }
  });

  it("names the first metacharacter when there are two", () => {
    expect(parseCommand("a ; b | c")).toEqual(refusal(";", "a ; b | c"));
    expect(parseCommand("a $ b ; c")).toEqual(refusal("$", "a $ b ; c"));
  });
});

describe("parseCommand unterminated quotes", () => {
  it.each([["a 'b"], ['a "b'], ["'"], ['"']])("refuses %j", (input) => {
    expect(parseCommand(input)).toEqual(shellSyntax("Command has an unterminated quote"));
  });

  it("reports shell syntax found before the unterminated quote", () => {
    const input = "a | 'b";
    expect(parseCommand(input)).toEqual(
      shellSyntax(`Command contains shell syntax (|) and cannot run without a shell: ${input}`),
    );
  });
});

describe("parseCommand and resolveCommand boundaries", () => {
  it.each([[""], ["   "], ["\t\n"]])("calls %j an empty command", (input) => {
    expect(parseCommand(input)).toEqual(shellSyntax("Command is empty"));
  });

  it.each([['"" x'], ["'' x"]])("refuses an empty quoted first word in %j", (input) => {
    expect(parseCommand(input)).toEqual(shellSyntax("Command is empty"));
  });

  it("accepts one plain or quoted word", () => {
    expectWords(parseCommand("a"), ["a"]);
    expectWords(parseCommand('"a"'), ["a"]);
  });

  it("refuses an empty argv and an empty executable", () => {
    expect(resolveCommand([])).toEqual(shellSyntax("Command is empty"));
    expect(resolveCommand(["", "x"])).toEqual(shellSyntax("Command is empty"));
  });

  it("returns a copy of an argv array", () => {
    const argv = ["a"];
    const result = resolveCommand(argv);
    expect(result).toEqual({ ok: true, value: ["a"] });
    if (result.ok) expect(result.value).not.toBe(argv);
  });
});

describe("parseCommand non-ASCII input", () => {
  it("keeps astral-plane characters whole", () => {
    expectWords(parseCommand("echo café \u{1D11E}"), ["echo", "café", "\u{1D11E}"]);
  });

  it("names a metacharacter after an astral-plane character and quotes the whole input", () => {
    const input = "echo \u{1D11E}|";
    expect(parseCommand(input)).toEqual(
      shellSyntax(`Command contains shell syntax (|) and cannot run without a shell: ${input}`),
    );
  });
});

describe("run refuses before starting", () => {
  const marker = () => join(directory, "marker");
  const writeMarker = () => `require('fs').writeFileSync(${JSON.stringify(marker())}, 'x')`;
  const markerExists = () =>
    readFile(marker()).then(
      () => true,
      () => false,
    );

  it.each([
    ["default reason", undefined, "This operation was aborted", "AbortError"],
    ["Error reason", new Error("stop it"), "stop it", "Error"],
    ["string reason", "stop it", "stop it", undefined],
  ])(
    "returns the abort reason for an already-aborted signal (%s)",
    async (_name, reason, message, name) => {
      const signal = AbortSignal.abort(reason);
      const result = await runScript(writeMarker(), { signal });
      expect(result).toMatchObject({ ok: false, error: { code: "COMMAND_FAILED", message } });
      if (!result.ok) expect(result.error.details?.name).toBe(name);
      await pause(150);
      expect(await markerExists()).toBe(false);
    },
  );

  it.each([-1, -0.001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "returns an invalid-timeout error for timeoutMs %s",
    async (timeoutMs) => {
      const result = await runScript(writeMarker(), { timeoutMs });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "COMMAND_FAILED", message: "Invalid command timeout" },
      });
      await pause(150);
      expect(await markerExists()).toBe(false);
    },
  );

  it("checks the abort before the timeout", async () => {
    const result = await runScript(writeMarker(), {
      signal: AbortSignal.abort(new Error("stop it")),
      timeoutMs: -1,
    });
    expect(result).toMatchObject({ ok: false, error: { message: "stop it" } });
  });
});

describe("run timeouts", () => {
  it.each([0, -0])("arms no timeout for timeoutMs %s", async (timeoutMs) => {
    const value = await runValue("setTimeout(() => {}, 300)", { timeoutMs });
    expect(value).toMatchObject({ exitCode: 0, timedOut: false });
  });

  it("times out a command for timeoutMs 1", async () => {
    const value = await runValue("setTimeout(() => {}, 2000)", { timeoutMs: 1 });
    expect(value.timedOut).toBe(true);
  });

  it("arms 600 000 ms when timeoutMs is omitted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    const pending = runScript("setInterval(() => {}, 1000)").then((result) => {
      settled = true;
      return result;
    });
    try {
      vi.advanceTimersByTime(599_999);
      await pause(150);
      expect(settled).toBe(false);
      vi.advanceTimersByTime(1);
      vi.advanceTimersByTime(200);
      const result = await pending;
      expect(result).toMatchObject({ ok: true, value: { timedOut: true, aborted: false } });
    } finally {
      vi.advanceTimersByTime(1_000_000);
      await pending;
    }
  });

  it("marks a long command timed out with exit code 1 and a bounded duration", async () => {
    const value = await runValue("setTimeout(() => {}, 5000)", { timeoutMs: 150 });
    expect(value).toMatchObject({ timedOut: true, aborted: false, exitCode: 1 });
    expect(value.durationMs).toBeGreaterThanOrEqual(150);
    expect(value.durationMs).toBeLessThan(2000);
  });

  it.skipIf(!posix)("kills a direct child that ignores SIGTERM", async () => {
    const script =
      "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000)";
    const value = await runValue(script, { timeoutMs: 500 });
    expect(value).toMatchObject({ timedOut: true, aborted: false, exitCode: 1 });
    expect(value.durationMs).toBeLessThan(2000);
    await expectGone(Number(value.stdout.trim()));
  });

  it.skipIf(!posix)("kills a grandchild that ignores SIGTERM after a timeout", async () => {
    const grandchild =
      "process.on('SIGTERM', () => {}); require('fs').writeFileSync('heartbeat', 'ready'); setInterval(() => require('fs').writeFileSync('heartbeat', String(Date.now())), 20); console.log('ready');";
    const parent = `const {spawn} = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {stdio: ['ignore', 'pipe', 'inherit']}); child.stdout.once('data', () => { console.log(child.pid); setInterval(() => {}, 1000); });`;
    const value = await runValue(parent, { timeoutMs: 3000 });
    const pid = Number(value.stdout.trim().replace(/^ready\s*/, ""));
    try {
      expect(value.timedOut).toBe(true);
      expect(await heartbeatStops(join(directory, "heartbeat"))).toBe(true);
    } finally {
      if (Number.isFinite(pid) && pid > 0) killQuietly(pid);
    }
  });
});

/** Waits until the pid no longer exists (a zombie still answers signal 0). */
async function expectGone(pid: number) {
  const deadline = Date.now() + 3000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    alive = isAlive(pid);
    if (alive) await pause(50);
  }
  expect(alive).toBe(false);
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killQuietly(pid: number) {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* Already gone. */
  }
}

/** True once the file is unchanged for two 200 ms polls in a row, within 3 s. */
async function heartbeatStops(file: string) {
  const deadline = Date.now() + 3000;
  let quiet = 0;
  let last = await readFile(file, "utf8");
  while (quiet < 2 && Date.now() < deadline) {
    await pause(200);
    const current = await readFile(file, "utf8");
    quiet = current === last ? quiet + 1 : 0;
    last = current;
  }
  return quiet >= 2;
}

describe("run results", () => {
  it.each([0, 3, 255])("reports exit code %i with each stream apart", async (code) => {
    const script = `process.stdout.write('out'); process.stderr.write('err'); process.exit(${code})`;
    const value = await runValue(script);
    expect(value).toMatchObject({
      exitCode: code,
      stdout: "out",
      stderr: "err",
      timedOut: false,
      aborted: false,
      command: [process.execPath, "-e", script].join(" "),
    });
    expect(value.durationMs).toBeGreaterThanOrEqual(0);
  });

  it.skipIf(!posix)("reports exit code 1 for a child that ends itself with SIGKILL", async () => {
    const value = await runValue("process.kill(process.pid, 'SIGKILL')");
    expect(value).toMatchObject({ exitCode: 1, timedOut: false, aborted: false });
  });
});

describe("run environment", () => {
  const printEnv =
    "console.log(JSON.stringify({parent: process.env.VISP_PARENT, x: process.env.VISP_X, keys: Object.keys(process.env)}))";
  const seen = async (options: Partial<RunOptions>) => {
    vi.stubEnv("VISP_PARENT", "p");
    const env = JSON.parse((await runValue(printEnv, options)).stdout);
    // Node adds NODE_V8_COVERAGE to a child's environment under coverage; exec.ts does not.
    return { ...env, keys: env.keys.filter((key: string) => key !== "NODE_V8_COVERAGE") };
  };

  it("passes the caller's environment when env is omitted", async () => {
    expect(await seen({})).toMatchObject({ parent: "p" });
  });

  it("adds env to the caller's environment", async () => {
    expect(await seen({ env: { VISP_X: "1" } })).toMatchObject({ parent: "p", x: "1" });
  });

  it("lets env override a caller variable", async () => {
    expect(await seen({ env: { VISP_PARENT: "over" } })).toMatchObject({ parent: "over" });
  });

  it("uses exactly env with replaceEnv", async () => {
    const env = await seen({ env: { VISP_X: "1" }, replaceEnv: true });
    expect(env.parent).toBeUndefined();
    expect(env.x).toBe("1");
    expect(env.keys).toEqual(["VISP_X"]);
  });

  it.skipIf(!posix)("uses an empty environment with replaceEnv and no env", async () => {
    const env = await seen({ replaceEnv: true });
    expect(env.keys).toEqual([]);
  });
});

describe("run stdin", () => {
  const readAll =
    "let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { s += d; }); process.stdin.on('end', () => process.stdout.write('[' + s + ']'));";

  it("gives a child end of input at once when input is omitted", async () => {
    expect(await runValue(readAll)).toMatchObject({ exitCode: 0, stdout: "[]" });
  });

  it.skipIf(!posix)("ignores stdin when input is omitted and pipes it when given", async () => {
    const kind =
      "process.stdout.write(require('fs').fstatSync(0).isCharacterDevice() ? 'null' : 'pipe'); process.stdin.resume(); process.stdin.on('end', () => {});";
    expect((await runValue(kind)).stdout).toBe("null");
    expect((await runValue(kind, { input: "" })).stdout).toBe("pipe");
  });

  it("closes stdin after an empty input", async () => {
    expect(await runValue(readAll, { input: "" })).toMatchObject({ exitCode: 0, stdout: "[]" });
  });

  it("echoes text input back", async () => {
    const value = await runValue(readAll, { input: "hello\nwörld" });
    expect(value).toMatchObject({ exitCode: 0, stdout: "[hello\nwörld]" });
  });

  it("ends ok when a child exits without reading 1 MiB of input", async () => {
    const value = await runValue("process.exit(0)", { input: "x".repeat(1024 * 1024) });
    expect(value).toMatchObject({ exitCode: 0, timedOut: false });
  });
});

describe("run output bounds", () => {
  const writer = (stream: "stdout" | "stderr") =>
    `const n = Number(process.argv[1]); const h = ${HALF}; const b = Buffer.alloc(n, 'z'); b.fill('a', 0, h); if (n > 2 * h) b.fill('m', h, n - h); process.${stream}.write(b);`;
  const expectedAt = (size: number) =>
    size <= 2 * HALF ? "a".repeat(Math.min(size, HALF)) + "z".repeat(Math.max(0, size - HALF)) : "";

  it.each(["stdout", "stderr"] as const)("returns %s whole at exactly 8 MiB", async (stream) => {
    const value = await runValue(writer(stream), {}, [String(2 * HALF)]);
    const text = value[stream];
    expect(text.length).toBe(2 * HALF);
    expect(text === expectedAt(2 * HALF)).toBe(true);
  });

  it.each(["stdout", "stderr"] as const)("truncates %s one byte above 8 MiB", async (stream) => {
    const value = await runValue(writer(stream), {}, [String(2 * HALF + 1)]);
    const expected = "a".repeat(HALF) + TRUNCATED + "z".repeat(HALF);
    expect(value[stream].length).toBe(expected.length);
    expect(value[stream] === expected).toBe(true);
  });
});

describe("run abort", () => {
  it("stops a running command and reports aborted with exit code 1", async () => {
    const controller = new AbortController();
    realSetTimeout(() => controller.abort(), 100);
    const value = await runValue("setInterval(() => {}, 1000)", {
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    expect(value).toMatchObject({ aborted: true, timedOut: false, exitCode: 1 });
    expect(value.durationMs).toBeLessThan(5000);
  });
});

describe("run abort listeners", () => {
  async function settle(how: "exit" | "timeout" | "abort" | "missing") {
    const controller = new AbortController();
    const { signal } = controller;
    if (how === "missing") {
      await run("visp-no-such-binary", [], { cwd: directory, signal });
    } else if (how === "abort") {
      realSetTimeout(() => controller.abort(), 50);
      await runScript("setInterval(() => {}, 1000)", { signal });
    } else {
      const script = how === "exit" ? "0" : "setInterval(() => {}, 1000)";
      await runScript(script, { signal, timeoutMs: how === "exit" ? undefined : 100 });
    }
    return controller;
  }

  it.each(["exit", "timeout", "abort", "missing"] as const)(
    "leaves no abort listener after %s",
    async (how) => {
      const controller = await settle(how);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      expect(() => controller.abort()).not.toThrow();
    },
  );
});

describe("run start failures", () => {
  it("reports a missing cwd as COMMAND_FAILED with ENOENT", async () => {
    const result = await run(process.execPath, ["-e", "0"], { cwd: join(directory, "missing") });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "COMMAND_FAILED", details: { errno: "ENOENT" } },
    });
  });

  it.skipIf(!posix)("reports a file without execute permission as EACCES", async () => {
    const file = join(directory, "tool");
    await writeFile(file, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    const result = await run(file, [], { cwd: directory });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "COMMAND_FAILED", details: { errno: "EACCES" } },
    });
  });

  it("refuses a NUL byte in the file or in an argument", async () => {
    for (const [file, args] of [
      ["node\0x", []],
      ["node", ["a\0b"]],
    ] as const) {
      const result = await run(file, args, { cwd: directory });
      expect(result).toMatchObject({ ok: false, error: { code: "COMMAND_FAILED" } });
    }
  });
});
