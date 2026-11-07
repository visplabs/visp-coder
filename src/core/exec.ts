import { type ChildProcess, spawn } from "node:child_process";
import { LIMITS } from "./constants.js";
import { fromUnknown } from "./errors.js";
import { err, ok, type Result } from "./result.js";
import { prepareCommand } from "./windows-command.js";

export interface CommandOutput {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted?: boolean;
  readonly durationMs: number;
}

export interface RunOptions {
  readonly cwd: string;
  readonly input?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly env?: Record<string, string>;
  /** Use exactly the supplied environment instead of extending the caller's. */
  readonly replaceEnv?: boolean;
}

/** Runs argv without a shell; owns the process group and bounds retained output. */
export function run(
  file: string,
  args: readonly string[],
  options: RunOptions,
): Promise<Result<CommandOutput>> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? LIMITS.commandTimeoutMs;
  return new Promise((resolve) => {
    const child = startChild(file, args, options, timeoutMs);
    if (!child.ok) {
      resolve(child);
      return;
    }
    new RunningCommand(child.value, { file, args, options, timeoutMs, started }, resolve).watch();
  });
}

/** Checks the abort signal and the timeout, then spawns; a refusal never starts a process. */
function startChild(
  file: string,
  args: readonly string[],
  options: RunOptions,
  timeoutMs: number,
): Result<ChildProcess> {
  try {
    options.signal?.throwIfAborted();
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("Invalid command timeout");
    const env = options.replaceEnv ? (options.env ?? {}) : { ...process.env, ...options.env };
    const prepared = prepareCommand(file, args, env);
    return ok(
      spawn(prepared.file, prepared.args, {
        cwd: options.cwd,
        detached: process.platform !== "win32",
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        env,
        windowsVerbatimArguments: prepared.windowsVerbatimArguments,
      }),
    );
  } catch (cause) {
    return err(fromUnknown(cause, "COMMAND_FAILED"));
  }
}

interface CommandRequest {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: RunOptions;
  readonly timeoutMs: number;
  readonly started: number;
}

type SpawnFailure = Error & { code?: string };

/** Watches one spawned command until it exits, times out, is aborted or fails, then resolves. */
class RunningCommand {
  private readonly child: ChildProcess;
  private readonly request: CommandRequest;
  private readonly resolve: (result: Result<CommandOutput>) => void;
  private readonly stdout = new BoundedOutput();
  private readonly stderr = new BoundedOutput();
  private timedOut = false;
  private aborted = false;
  private finished = false;
  private exitCode = 1;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private grace: ReturnType<typeof setTimeout> | undefined;

  constructor(
    child: ChildProcess,
    request: CommandRequest,
    resolve: (result: Result<CommandOutput>) => void,
  ) {
    this.child = child;
    this.request = request;
    this.resolve = resolve;
  }

  watch() {
    const { child, request } = this;
    if (request.timeoutMs > 0) {
      this.timer = setTimeout(() => {
        this.timedOut = true;
        this.stop();
      }, request.timeoutMs);
    }
    child.stdout?.on("data", (chunk: Buffer) => this.stdout.add(chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.stderr.add(chunk));
    child.once("error", (failure: SpawnFailure) => this.finish(failure));
    child.once("exit", (code) => {
      this.exitCode = code ?? 1;
      clearTimeout(this.timer);
      // A descendant may retain stdout after its parent exits. Drain briefly, then reap it.
      this.stop();
    });
    child.once("close", () => this.finish());
    this.sendInput();
    const { signal } = request.options;
    signal?.addEventListener("abort", this.cancel, { once: true });
    if (signal?.aborted) this.cancel();
  }

  private sendInput() {
    const { input } = this.request.options;
    if (input === undefined) return;
    this.child.stdin?.on("error", () => undefined);
    this.child.stdin?.end(input);
  }

  private readonly cancel = () => {
    this.aborted = true;
    this.stop();
  };

  private stop() {
    killCommandGroup(this.child, "SIGTERM");
    this.grace ??= setTimeout(() => this.finish(), 200);
  }

  private finish(failure?: SpawnFailure) {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timer);
    clearTimeout(this.grace);
    this.request.options.signal?.removeEventListener("abort", this.cancel);
    killCommandGroup(this.child, "SIGKILL");
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
    this.resolve(failure ? this.failure(failure) : ok(this.output()));
  }

  private failure(failure: SpawnFailure): Result<CommandOutput> {
    const error = fromUnknown(failure, "COMMAND_FAILED");
    return err({ ...error, details: { ...error.details, errno: failure.code } });
  }

  private output(): CommandOutput {
    const { file, args, started } = this.request;
    return {
      command: [file, ...args].join(" "),
      exitCode: this.timedOut || this.aborted ? 1 : this.exitCode,
      stdout: this.stdout.text(),
      stderr: this.stderr.text(),
      timedOut: this.timedOut,
      aborted: this.aborted,
      durationMs: Date.now() - started,
    };
  }
}

/** Signals a spawned command's whole process group (its tree on Windows). */
export function killCommandGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") killWindowsTree(child, signal);
    else process.kill(-child.pid, signal);
  } catch {
    /* The process group has already exited. */
  }
}

/**
 * Windows has no process groups: `child.kill()` ends only the shim (cmd.exe, npm.cmd) and
 * leaves the real command running. taskkill /T walks the tree while its root is alive; after
 * the root exited its pid may belong to someone else, so nothing is killed then.
 */
function killWindowsTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // taskkill failing to start, or exiting non-zero while the root still runs, leaves the shim
  // killable at least.
  const fallback = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  try {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", fallback);
    killer.once("exit", (code) => {
      if (code !== 0) fallback();
    });
  } catch {
    fallback();
  }
}

class BoundedOutput {
  private readonly head: Buffer[] = [];
  private readonly tail: Buffer[] = [];
  private headBytes = 0;
  private tailBytes = 0;
  private total = 0;
  private readonly half = 4 * 1024 * 1024;

  add(chunk: Buffer) {
    this.total += chunk.length;
    const keep = Math.min(this.half - this.headBytes, chunk.length);
    if (keep > 0) {
      this.head.push(chunk.subarray(0, keep));
      this.headBytes += keep;
    }
    if (keep === chunk.length) return;
    this.tail.push(chunk.subarray(keep));
    this.tailBytes += chunk.length - keep;
    while (this.tailBytes > this.half) {
      const first = this.tail[0];
      if (!first) break;
      const excess = this.tailBytes - this.half;
      if (first.length <= excess) {
        this.tail.shift();
        this.tailBytes -= first.length;
      } else {
        this.tail[0] = first.subarray(excess);
        this.tailBytes -= excess;
      }
    }
  }

  text() {
    return Buffer.concat([
      ...this.head,
      ...(this.total > this.half * 2 ? [Buffer.from("\n[VISP: output truncated]\n")] : []),
      ...this.tail,
    ]).toString("utf8");
  }
}

/**
 * Splits a shell-style command string into an argv vector for {@link run}.
 * Only plain words and quoted segments are supported; anything containing shell
 * metacharacters is rejected rather than passed to a shell.
 */
export function parseCommand(input: string): Result<string[], ShellSyntaxError> {
  return splitCommandWords(input);
}

const SHELL_METACHARACTERS = /[|&;<>$`(){}[\]!*?~]/;

interface WordScan {
  readonly argv: string[];
  word: string;
  quote: string | undefined;
  /** True once the current word has a character or a quote, so `""` is an empty word. */
  started: boolean;
}

function splitCommandWords(input: string): Result<string[], ShellSyntaxError> {
  const scan: WordScan = { argv: [], word: "", quote: undefined, started: false };
  for (const character of input) {
    if (!scanCharacter(scan, character)) {
      return shellSyntaxFailure(
        `Command contains shell syntax (${character}) and cannot run without a shell: ${input}`,
      );
    }
  }
  if (scan.quote) return shellSyntaxFailure("Command has an unterminated quote");
  endWord(scan);
  return resolveCommand(scan.argv);
}

function shellSyntaxFailure(message: string): Result<never, ShellSyntaxError> {
  return { ok: false, error: { kind: "shell-syntax", message } };
}

/** Feeds one character to the scan; false when it is an unquoted shell metacharacter. */
function scanCharacter(scan: WordScan, character: string): boolean {
  if (scan.quote) {
    if (character === scan.quote) scan.quote = undefined;
    else scan.word += character;
  } else if (character === '"' || character === "'") {
    scan.quote = character;
    scan.started = true;
  } else if (/\s/.test(character)) {
    endWord(scan);
  } else if (SHELL_METACHARACTERS.test(character)) {
    return false;
  } else {
    scan.word += character;
    scan.started = true;
  }
  return true;
}

function endWord(scan: WordScan) {
  if (scan.started) scan.argv.push(scan.word);
  scan.word = "";
  scan.started = false;
}

/**
 * A command as written: a string to split, or an argv vector given directly.
 *
 * The array form exists because there is no shell. `pnpm test && pnpm lint` has
 * no argv, and neither does `CI=1 pytest` — the answer to those is two entries,
 * not a shell. What the array does solve is the argument that only *looks* like
 * shell syntax, such as `["pnpm", "test", "--", "--reporter=dot"]`.
 */
export type CommandSpec = string | readonly string[];

/** The argv to run, or why this spec cannot produce one. */
export function resolveCommand(spec: CommandSpec): Result<string[], ShellSyntaxError> {
  if (typeof spec === "string") return parseCommand(spec);

  if (spec.length === 0 || spec[0] === "") {
    return { ok: false, error: { kind: "shell-syntax", message: "Command is empty" } };
  }
  return ok([...spec]);
}

/** How a spec is shown to a human, and recorded in evidence. */
export function describeCommand(spec: CommandSpec): string {
  return typeof spec === "string"
    ? spec
    : spec
        .map((argument) =>
          argument === "" || /[\s"']/.test(argument) ? JSON.stringify(argument) : argument,
        )
        .join(" ");
}

export interface ShellSyntaxError {
  readonly kind: "shell-syntax";
  readonly message: string;
}
