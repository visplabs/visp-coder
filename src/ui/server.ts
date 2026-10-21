import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fromUnknown, type VispError } from "../core/errors.js";
import { parseFeatureId } from "../core/input.js";
import type { Result } from "../core/result.js";
import { BUILD_ID } from "../core/version.js";
import { loadWorkspace, type WorkspaceState } from "../workflow/state.js";
import { readCapture } from "./captures.js";
import { changeMapView } from "./change-map/index.js";
import type { UiChange } from "./contract.js";
import { requestsView } from "./requests.js";
import {
  cookieName,
  createToken,
  hostAllowed,
  originAllowed,
  readCookie,
  SECURITY_HEADERS,
  sessionCookie,
  tokensMatch,
} from "./security.js";
import { executionView, featureView, healthView, metaView, overviewView } from "./views.js";
import { watchState } from "./watcher.js";

export interface UiServerOptions {
  readonly root: string;
  readonly port?: number;
  readonly token?: string;
  readonly assetsDir?: string;
}

export interface UiServer {
  readonly port: number;
  readonly token: string;
  readonly url: string;
  close(): Promise<void>;
}

const ASSET_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".map": "application/json",
};
const HEARTBEAT_MS = 15_000;
const MAX_BODY_BYTES = 4_096;

/** Where the built page lives: next to the bundled CLI, or in `dist/` when run from source. */
export function defaultAssetsDir(): string {
  const candidates = [
    fileURLToPath(new URL("./ui/", import.meta.url)),
    fileURLToPath(new URL("../../dist/ui/", import.meta.url)),
  ];
  return candidates.find((dir) => existsSync(join(dir, "index.html"))) ?? (candidates[0] as string);
}

export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const token = options.token ?? createToken();
  const assets = await loadAssets(options.assetsDir ?? defaultAssetsDir());
  const startedAt = new Date().toISOString();
  const streams = new Set<ServerResponse>();
  let revision = 0;
  let port = 0;

  const context: HandlerContext = {
    root: options.root,
    token,
    assets,
    startedAt,
    streams,
    port: () => port,
    revision: () => revision,
  };
  const server = createServer((request, response) => {
    handle(context, request, response).catch((cause) =>
      sendError(response, fromUnknown(cause, "INTERNAL"), 500),
    );
  });
  await listen(server, options.port ?? 0);
  port = (server.address() as AddressInfo).port;

  const initial = await loadWorkspace(options.root);
  const watcher = initial.ok
    ? watchState(initial.value.paths.state, (features) => {
        revision += 1;
        broadcast(streams, { revision, features });
      })
    : undefined;
  const heartbeat = setInterval(() => {
    for (const stream of streams) stream.write(": heartbeat\n\n");
  }, HEARTBEAT_MS).unref();

  return {
    port,
    token,
    url: `http://127.0.0.1:${port}/#t=${token}`,
    async close() {
      watcher?.close();
      clearInterval(heartbeat);
      for (const stream of streams) stream.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // Loopback only, by construction: there is no option to bind anything else.
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

interface Asset {
  readonly body: Buffer;
  readonly type: string;
}

async function loadAssets(dir: string): Promise<ReadonlyMap<string, Asset>> {
  const assets = new Map<string, Asset>();
  const visit = async (relative: string) => {
    const entries = await readdir(join(dir, relative), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      const type = ASSET_TYPES[extname(entry.name)];
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && type)
        assets.set(path, { body: await readFile(join(dir, path)), type });
    }
  };
  await visit("");
  return assets;
}

interface HandlerContext {
  readonly root: string;
  readonly token: string;
  readonly assets: ReadonlyMap<string, Asset>;
  readonly startedAt: string;
  readonly streams: Set<ServerResponse>;
  port(): number;
  revision(): number;
}

async function handle(
  context: HandlerContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
  if (!hostAllowed(request, context.port())) return sendPlain(response, 421, "Misdirected request");
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;

  if (path === "/api/v1/session") return startSession(context, request, response);
  if (path === "/api/v1/ping" && request.method === "GET")
    return sendJson(response, 200, { command: "ui", ok: true, data: { buildId: BUILD_ID } });
  if (request.method !== "GET" && request.method !== "HEAD")
    return sendPlain(response, 405, "Method not allowed");
  if (path.startsWith("/api/") || path.startsWith("/captures/")) {
    if (!authorized(context, request))
      return sendError(
        response,
        { code: "UNSUPPORTED", message: "Not signed in to this dashboard" },
        401,
      );
    return path.startsWith("/captures/")
      ? serveCapture(context, path, response)
      : routeApi(context, url, request, response);
  }
  return serveAsset(context, path, response);
}

function authorized(context: HandlerContext, request: IncomingMessage): boolean {
  return tokensMatch(context.token, readCookie(request, cookieName(context.port())));
}

async function startSession(
  context: HandlerContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== "POST") return sendPlain(response, 405, "Method not allowed");
  if (!originAllowed(request, context.port())) return sendPlain(response, 403, "Forbidden");
  const body = await readBody(request);
  let supplied: string | undefined;
  try {
    const parsed = JSON.parse(body ?? "") as { token?: unknown };
    supplied = typeof parsed.token === "string" ? parsed.token : undefined;
  } catch {
    supplied = undefined;
  }
  if (!tokensMatch(context.token, supplied)) return sendPlain(response, 403, "Forbidden");
  response.setHeader("Set-Cookie", sessionCookie(context.port(), context.token));
  response.writeHead(204).end();
}

function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        resolve(undefined);
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(undefined));
  });
}

type Route = (
  state: WorkspaceState,
  match: RegExpExecArray,
  query: URLSearchParams,
) => Promise<Result<unknown>>;

const ROUTES: readonly (readonly [RegExp, string, Route])[] = [
  [/^\/api\/v1\/overview$/, "overview", (state) => overviewView(state)],
  [/^\/api\/v1\/requests$/, "requests", (state) => requestsView(state)],
  [
    /^\/api\/v1\/health$/,
    "health",
    async (state) => ({ ok: true, value: await healthView(state) }),
  ],
  [
    /^\/api\/v1\/features\/([^/]+)$/,
    "feature",
    (state, match) => withFeature(match[1], (feature) => featureView(state, feature)),
  ],
  [
    /^\/api\/v1\/features\/([^/]+)\/map$/,
    "map",
    (state, match, query) =>
      withFeature(match[1], (feature) =>
        changeMapView(state, feature, query.get("base") ?? undefined),
      ),
  ],
  [
    /^\/api\/v1\/features\/([^/]+)\/executions\/([^/]+)$/,
    "execution",
    (state, match) =>
      withFeature(match[1], (feature) =>
        executionView(state, feature, decodeURIComponent(match[2] ?? "")),
      ),
  ],
];

async function withFeature<T>(
  raw: string | undefined,
  run: (feature: string) => Promise<Result<T>>,
): Promise<Result<T>> {
  const feature = parseFeatureId(decodeURIComponent(raw ?? ""));
  return feature.ok ? run(feature.value) : feature;
}

async function routeApi(
  context: HandlerContext,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const path = url.pathname;
  if (path === "/api/v1/events") return openStream(context, request, response);
  const state = await loadWorkspace(context.root);
  if (!state.ok) return sendError(response, state.error, statusFor(state.error));
  if (path === "/api/v1/meta")
    return sendJson(response, 200, {
      command: "meta",
      ok: true,
      data: metaView(state.value, context.startedAt),
    });
  for (const [pattern, command, route] of ROUTES) {
    const match = pattern.exec(path);
    if (!match) continue;
    const result = await route(state.value, match, url.searchParams);
    return result.ok
      ? sendJson(response, 200, { command, ok: true, data: result.value })
      : sendError(response, result.error, statusFor(result.error), command);
  }
  return sendError(response, { code: "UNSUPPORTED", message: `No resource at ${path}` }, 404);
}

function statusFor(error: VispError): number {
  if (error.code === "STATE_BUSY") return 503;
  if (
    error.code === "ARTIFACT_MISSING" ||
    error.code === "TASK_NOT_FOUND" ||
    error.code === "NO_ACTIVE_FEATURE"
  )
    return 404;
  if (error.code === "ARTIFACT_INVALID" || error.code === "MIGRATION_REQUIRED") return 409;
  return 500;
}

function openStream(
  context: HandlerContext,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  response.write(
    `retry: 2000\nevent: hello\ndata: ${JSON.stringify({ revision: context.revision() })}\n\n`,
  );
  context.streams.add(response);
  request.on("close", () => context.streams.delete(response));
}

function broadcast(streams: ReadonlySet<ServerResponse>, change: UiChange): void {
  const message = `event: change\ndata: ${JSON.stringify(change)}\n\n`;
  for (const stream of streams) stream.write(message);
}

async function serveCapture(
  context: HandlerContext,
  path: string,
  response: ServerResponse,
): Promise<void> {
  const [, , rawFeature, ...rest] = path.split("/");
  const feature = parseFeatureId(decodeURIComponent(rawFeature ?? ""));
  if (!feature.ok) return sendPlain(response, 400, "Bad request");
  const state = await loadWorkspace(context.root);
  if (!state.ok) return sendError(response, state.error, statusFor(state.error));
  const read = await readCapture(
    state.value.paths.featureDir(feature.value),
    rest.map((segment) => decodeURIComponent(segment)).join("/"),
  );
  if (!read.ok) return sendPlain(response, read.status, "Not available");
  response.writeHead(200, { "Content-Type": read.contentType, "Cache-Control": "no-store" });
  response.end(read.body);
}

function serveAsset(context: HandlerContext, path: string, response: ServerResponse): void {
  const name = path === "/" ? "index.html" : path.slice(1);
  const asset =
    context.assets.get(name) ?? (name.includes(".") ? undefined : context.assets.get("index.html"));
  if (!asset) {
    const built = context.assets.size > 0;
    sendPlain(
      response,
      built ? 404 : 500,
      built ? "Not found" : "The dashboard was not built. Run pnpm build.",
    );
    return;
  }
  response.writeHead(200, {
    "Content-Type": asset.type,
    "Cache-Control": asset.type.startsWith("text/html") ? "no-store" : "no-cache",
  });
  response.end(asset.body);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function sendError(
  response: ServerResponse,
  error: Pick<VispError, "code" | "message" | "recovery">,
  status: number,
  command = "ui",
): void {
  if (response.headersSent) return void response.end();
  sendJson(response, status, {
    command,
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.recovery ? { recovery: error.recovery } : {}),
    },
  });
}

function sendPlain(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(text);
}
