import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

/**
 * A local stand-in for Sentry's ingest endpoint. Tests point VISP_SENTRY_DSN at it so no
 * run can reach a real project, and count what arrived.
 */
export interface SentryCapture {
  readonly dsn: string;
  /** Request bodies received so far. */
  readonly requests: readonly string[];
  close(): Promise<void>;
}

export async function startSentryCapture(): Promise<SentryCapture> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await listen(server);
  const { port } = server.address() as AddressInfo;
  return {
    dsn: `http://visp5key@127.0.0.1:${port}/1`,
    requests,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((done) => server.listen(0, "127.0.0.1", done));
}

export interface AsyncRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Runs a process without blocking this one, so the capture server keeps answering while the
 * child flushes. Failure is returned, never thrown.
 */
export function runAsync(
  file: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<AsyncRun> {
  return new Promise((done) => {
    execFile(
      file,
      [...args],
      { ...options, encoding: "utf8", timeout: 120_000 },
      (error, stdout, stderr) => {
        const status = (error as { code?: unknown } | null)?.code;
        done({ stdout, stderr, exitCode: error ? (typeof status === "number" ? status : 1) : 0 });
      },
    );
  });
}

/** Sends one event with the SDK itself, to show the capture server would see a real report. */
export function sendControlEvent(dsn: string, env: NodeJS.ProcessEnv): Promise<AsyncRun> {
  const script = `
    import * as Sentry from "@sentry/node";
    Sentry.init({ dsn: process.env.CONTROL_DSN });
    Sentry.captureException(new Error("control event"));
    await Sentry.flush(5000);
  `;
  return runAsync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: resolve(process.cwd()),
    env: { ...env, CONTROL_DSN: dsn },
  });
}
