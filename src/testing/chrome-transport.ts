import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killCommandGroup } from "../core/exec.js";
import { productExecutionEnvironment } from "../core/execution-environment.js";
import { bounded } from "./deadline.js";

export const BROWSER_STARTUP_TIMEOUT_MS = 10_000;
export class BrowserUnavailableError extends Error {
  constructor(
    message: string,
    options?: ErrorOptions & { kind?: "missing-browser" | "permissions" | "startup" },
  ) {
    super(message, options);
    this.kind = options?.kind;
  }
  readonly kind?: "missing-browser" | "permissions" | "startup";
}
/** An established browser failed to execute an operation; partial history remains diagnostic. */
export class BrowserRuntimeError extends Error {
  constructor(
    message: string,
    readonly status: "failed" | "timed-out" = "failed",
  ) {
    super(message);
  }
}

export interface ChromeTransport {
  onEvent(
    listener: (event: {
      method: string;
      params: Record<string, unknown>;
      sessionId?: string;
    }) => void,
  ): () => void;
  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/**
 * New process and profile only. No browser download, user session, or sandbox-disabling flag.
 * `gpu: false` renders in software: without a GPU, Chrome otherwise composites through
 * SwiftShader, whose first screenshot took 8-10 s on a loaded 2-core host. Pages that need
 * WebGL (a game a journey captures) keep the default.
 */
export async function launchChrome(
  options: {
    binary?: string;
    startupTimeoutMs?: number;
    operationTimeoutMs?: number;
    gpu?: boolean;
  } = {},
): Promise<ChromeTransport> {
  const profile = await mkdtemp(join(tmpdir(), "visp-browser-"));
  const binary = options.binary ?? process.env.CHROME_BIN ?? "google-chrome";
  const child = spawn(
    binary,
    [
      "--headless=new",
      "--no-first-run",
      "--disable-extensions",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profile}`,
      ...(options.gpu === false ? ["--disable-gpu"] : []),
      "about:blank",
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: productExecutionEnvironment(),
      // Its own process group, so stopping it also ends the helpers it started.
      detached: process.platform !== "win32",
    },
  );
  trackBrowser(child);
  let stderr = "";
  let diagnosticTruncated = false;
  const captureDiagnostic = (chunk: Buffer) => {
    const combined = stderr + String(chunk);
    diagnosticTruncated ||= combined.length > 8_192;
    stderr = combined.slice(-8_192);
  };
  child.stderr?.on("data", captureDiagnostic);
  let connection: ChromeTransport | undefined;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    try {
      await connection?.close();
      await stopChild(child);
    } finally {
      await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
    }
  }
  try {
    const endpoint = await debuggingEndpoint(
      child,
      options.startupTimeoutMs ?? BROWSER_STARTUP_TIMEOUT_MS,
    );
    connection = await connect(
      endpoint,
      options.startupTimeoutMs ?? BROWSER_STARTUP_TIMEOUT_MS,
      options.operationTimeoutMs ?? 5_000,
    );
    return { send: connection.send, onEvent: connection.onEvent, close };
  } catch (cause) {
    await close();
    throw startupError(binary, cause, stderr, diagnosticTruncated);
  } finally {
    child.stderr?.removeListener("data", captureDiagnostic);
  }
}

function startupError(
  binary: string,
  cause: unknown,
  stderr: string,
  diagnosticTruncated: boolean,
): BrowserUnavailableError {
  const missing = cause instanceof Error && "code" in cause && cause.code === "ENOENT";
  const diagnostic = `${cause instanceof Error ? cause.message : String(cause)}\n${stderr}`;
  const kind = missing
    ? "missing-browser"
    : /\b(?:EPERM|EACCES)\b|Operation not permitted|Permission denied|No usable sandbox/i.test(
          diagnostic,
        )
      ? "permissions"
      : "startup";
  const recovery =
    kind === "missing-browser"
      ? "Select an installed Chrome/Chromium executable with --binary or CHROME_BIN."
      : kind === "permissions"
        ? "Use the host's supported permission recovery; keep browser sandboxing enabled."
        : "Inspect the startup diagnostic, browser installation and required shared libraries before retrying.";
  return new BrowserUnavailableError(
    `Browser unavailable (${binary}): ${cause instanceof Error ? cause.message : String(cause)}. ${recovery}${stderr.trim() ? `\nBrowser stderr${diagnosticTruncated ? " (truncated)" : ""}:\n${stderr.trim()}` : ""}`,
    { cause, kind },
  );
}

/**
 * A detached browser no longer receives the signal a host sends to visp's process group, so
 * every browser still running when visp exits is killed with its group here.
 */
const liveBrowsers = new Set<ChildProcess>();
function trackBrowser(child: ChildProcess): void {
  if (process.platform === "win32") return;
  if (liveBrowsers.size === 0) process.once("exit", killLiveBrowsers);
  liveBrowsers.add(child);
  child.once("exit", () => {
    liveBrowsers.delete(child);
    if (liveBrowsers.size === 0) process.removeListener("exit", killLiveBrowsers);
  });
}

function killLiveBrowsers(): void {
  for (const child of liveBrowsers) killCommandGroup(child, "SIGKILL");
}

/**
 * Chrome's launcher script pipes stderr through a `cat`, and its helpers outlive the leader
 * when only the leader is signalled; they keep the other end of stderr's socket open, so a
 * failed browser kept `visp` running after its result was printed. The whole group is ended
 * and the streams are released.
 */
async function stopChild(child: ChildProcess): Promise<void> {
  try {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      killCommandGroup(child, "SIGTERM");
      const timeout = setTimeout(() => killCommandGroup(child, "SIGKILL"), 500);
      try {
        await bounded("Browser cleanup", 2_000, async () => stopped);
      } finally {
        clearTimeout(timeout);
      }
    }
  } finally {
    // Helpers that outlived the leader, or ignored SIGTERM.
    killCommandGroup(child, "SIGKILL");
    child.stderr?.destroy();
    child.stdout?.destroy();
    child.unref?.();
  }
}

function debuggingEndpoint(child: ChildProcess, timeoutMs: number): Promise<string> {
  return bounded(
    "Browser startup",
    timeoutMs,
    async (signal) =>
      new Promise<string>((resolve, reject) => {
        let output = "";
        const cleanup = () => {
          child.removeListener("error", fail);
          child.removeListener("close", exited);
          child.stderr?.removeListener("data", data);
          signal.removeEventListener("abort", aborted);
        };
        const fail = (error: Error) => {
          cleanup();
          reject(error);
        };
        const exited = (code: number | null, signal: NodeJS.Signals | null) =>
          fail(
            new Error(
              `browser exited before becoming ready (${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`})`,
            ),
          );
        const aborted = () => fail(new Error("browser startup timed out"));
        const data = (chunk: Buffer) => {
          output = (output + String(chunk)).slice(-8192);
          const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
          if (!match?.[1]) return;
          const url = new URL(match[1]);
          if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
            fail(new Error("browser endpoint is not loopback"));
            return;
          }
          cleanup();
          resolve(url.href);
        };
        child.once("error", fail);
        // close follows the final stderr bytes; exit can precede their delivery.
        child.once("close", exited);
        child.stderr?.on("data", data);
        signal.addEventListener("abort", aborted, { once: true });
      }),
  );
}

async function connect(
  endpoint: string,
  startupTimeoutMs: number,
  timeoutMs: number,
): Promise<ChromeTransport> {
  const socket = new WebSocket(endpoint);
  try {
    await bounded(
      "Browser connection",
      startupTimeoutMs,
      async () =>
        new Promise<void>((resolve, reject) => {
          socket.addEventListener("open", () => resolve(), { once: true });
          socket.addEventListener("error", () => reject(new Error("browser connection failed")), {
            once: true,
          });
        }),
    );
  } catch (cause) {
    socket.close();
    throw cause;
  }
  let sequence = 0;
  const pending = new Map<
    number,
    { resolve(value: Record<string, unknown>): void; reject(cause: Error): void }
  >();
  const listeners = new Set<Parameters<ChromeTransport["onEvent"]>[0]>();
  const dispatchEvent = (
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ) => {
    for (const listener of listeners) listener({ method, params, sessionId });
  };
  socket.addEventListener("message", (event) => {
    let response: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
      result?: Record<string, unknown>;
      error?: { message: string };
    };
    try {
      response = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (response.method) {
      dispatchEvent(response.method, response.params, response.sessionId);
      return;
    }
    const request = response.id === undefined ? undefined : pending.get(response.id);
    if (!request || response.id === undefined) return;
    pending.delete(response.id);
    if (response.error) request.reject(new BrowserRuntimeError(response.error.message));
    else request.resolve(response.result ?? {});
  });
  // Once the socket is gone (Chrome killed, crashed, or closed by us) a send would wait its
  // whole timeout for a reply that cannot come, and report a timeout rather than a lost browser.
  let closed = false;
  const rejectPending = () => {
    for (const request of pending.values())
      request.reject(new BrowserRuntimeError("browser disconnected"));
    pending.clear();
  };
  socket.addEventListener("close", () => {
    closed = true;
    rejectPending();
  });
  return {
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send(method, params = {}, sessionId) {
      if (closed || socket.readyState !== WebSocket.OPEN)
        return Promise.reject(new BrowserRuntimeError("browser disconnected"));
      const id = ++sequence;
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new BrowserRuntimeError(`${method} timed out`, "timed-out"));
        }, timeoutMs);
        pending.set(id, {
          resolve(value) {
            clearTimeout(timer);
            resolve(value);
          },
          reject(cause) {
            clearTimeout(timer);
            reject(cause);
          },
        });
        try {
          socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        } catch (cause) {
          pending.delete(id);
          clearTimeout(timer);
          reject(new BrowserRuntimeError(cause instanceof Error ? cause.message : String(cause)));
        }
      });
    },
    async close() {
      closed = true;
      listeners.clear();
      rejectPending();
      socket.close();
    },
  };
}
