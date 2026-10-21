import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { browserExecutableIdentity } from "../../core/browser-executable.js";
import { type FileMutation, filePrecondition } from "../../core/file-transaction.js";
import { sha256 } from "../../core/hash.js";
import { type SvgRasterizer, svgRasterizer } from "../../testing/svg-raster.js";
import type { ProductReviewCapture } from "../evidence/product-review.js";
import type { WorkspaceState } from "../state.js";
import { declaredCheckImages } from "./check/check-image-paths.js";
import { imageCapture } from "./check/check-images.js";
import { captureSchema, readImageBytes } from "./images.js";
import type { ProductExecution } from "./model.js";
import type { ProductRecord } from "./store.js";

const PICTURE = /\.(?:png|jpe?g|webp|gif|svg)$/i;
const MAX_RESULT_IMAGES = 4;
const MAX_SVG_BYTES = 1024 * 1024;
const ROUTE = "result image: ";
/**
 * SVG contents a working browser could not render, and a browser that failed to run;
 * machine-local, like check output logs.
 */
const UNRENDERED_FILE = "unrendered-svg.json";
const MAX_UNRENDERED = 200;

interface ResultPicture {
  readonly capture: ProductReviewCapture;
  readonly mutation: FileMutation;
}

/** Pictures read and rendered before VISP takes the state lock. */
export interface PreparedResultImages {
  /** The product version the pictures were read from; publication requires it unchanged. */
  readonly subjectDigest?: string;
  readonly pictures: readonly ResultPicture[];
  /** SHA-256 of SVG contents that did not render in a working browser. */
  readonly unrendered: readonly string[];
  /** Whether the browser ran this time, and which browser executable it was. */
  readonly browser?: { readonly identity: string; readonly worked: boolean };
}

const NONE: PreparedResultImages = { pictures: [], unrendered: [] };
/** How long a browser that failed is not started again for result pictures. */
const BROWSER_RETRY_MS = 60 * 60 * 1000;

/**
 * A picture the product makes (a rendered scene, a chart, a vector drawing) is judged by
 * looking at it. Workers declared such an output on a check in 1 of 6 visual runs, so the
 * reviewer saw source and a "core file unavailable" note instead of the picture. After the
 * checks pass, the newest product images written since the feature started become review
 * captures of this version: at most four, each once per version. An SVG is rendered in a
 * browser, since reviewers can view PNG files but not SVG ones. Declared check images are
 * captured by their check; nothing here can fail a check.
 *
 * Starting a browser takes seconds and other VISP processes give up on the state lock after
 * 5 s, so the pictures are read and rendered here, before the lock, in one shared browser;
 * an SVG that does not render is remembered by content and not tried again.
 * publishResultImages keeps them only if the product is still the version they were read from.
 */
export async function prepareResultImages(
  workspace: WorkspaceState,
  record: ProductRecord,
  executions: readonly ProductExecution[],
  source: { readonly digest: string; readonly snapshot: Record<string, string> },
): Promise<PreparedResultImages> {
  if (!executions.length || executions.some((execution) => execution.status !== "passed"))
    return NONE;
  const candidates = await resultImagePaths(workspace, record, source.snapshot, source.digest);
  if (!candidates.length) return NONE;
  const memory = await renderMemory(workspace);
  const identity = JSON.stringify(await browserExecutableIdentity());
  const failedAt = Date.parse(memory.browserFailure?.at ?? "");
  const browserDown =
    memory.browserFailure?.identity === identity && Date.now() - failedAt < BROWSER_RETRY_MS;
  const svgs = new SvgRendering(new Set(memory.sha256), browserDown);
  const pictures: ResultPicture[] = [];
  try {
    for (const path of candidates) {
      const bytes = await resultImageBytes(workspace, path, svgs);
      const picture = bytes
        ? imageCapture(workspace, record.brief.feature, bytes, source.digest, {
            route: `${ROUTE}${path}`,
            steps: [
              path.toLowerCase().endsWith(".svg")
                ? `VISP rendered the product's ${path} in a browser`
                : `VISP read the product's ${path}`,
            ],
          })
        : undefined;
      if (picture) pictures.push(picture);
    }
  } finally {
    await svgs.close();
  }
  return {
    subjectDigest: source.digest,
    pictures,
    unrendered: svgs.unrendered,
    ...(svgs.browser === undefined ? {} : { browser: { identity, worked: svgs.browser } }),
  };
}

/**
 * Under the state lock: the prepared pictures, if the product is still the version they were
 * read from and no other run captured them meanwhile, and the remembered unrendered SVGs.
 */
export async function publishResultImages(
  workspace: WorkspaceState,
  record: ProductRecord,
  prepared: PreparedResultImages,
  subjectDigest: string,
): Promise<{ captures: ProductReviewCapture[]; mutations: FileMutation[] }> {
  const captured = capturedRoutes(record, subjectDigest);
  const pictures =
    prepared.subjectDigest === subjectDigest
      ? prepared.pictures.filter((picture) => !captured.has(picture.capture.route))
      : [];
  return {
    captures: pictures.map((picture) => picture.capture),
    mutations: [
      ...pictures.map((picture) => picture.mutation),
      ...(await renderMemoryMutation(workspace, prepared)),
    ],
  };
}

function capturedRoutes(record: ProductRecord, subjectDigest: string): Set<string> {
  return new Set(
    record.state.captures.flatMap((entry) => {
      const capture = captureSchema.safeParse(entry);
      return capture.success && capture.data.subjectDigest === subjectDigest
        ? [capture.data.route]
        : [];
    }),
  );
}

/** The newest uncaptured product images written since the feature started. */
async function resultImagePaths(
  workspace: WorkspaceState,
  record: ProductRecord,
  snapshot: Record<string, string>,
  subjectDigest: string,
): Promise<string[]> {
  const started = Date.parse(record.state.createdAt);
  if (!Number.isFinite(started)) return [];
  const declared = declaredCheckImages(record.brief.checks);
  const captured = capturedRoutes(record, subjectDigest);
  const candidates: { path: string; modified: number }[] = [];
  for (const path of Object.keys(snapshot)) {
    if (!PICTURE.test(path) || declared.has(path) || captured.has(`${ROUTE}${path}`)) continue;
    const stats = await lstat(join(workspace.paths.root, path)).catch(() => undefined);
    if (stats?.isFile() && stats.mtimeMs >= started)
      candidates.push({ path, modified: stats.mtimeMs });
  }
  return candidates
    .sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path))
    .slice(0, MAX_RESULT_IMAGES)
    .map((entry) => entry.path);
}

async function resultImageBytes(workspace: WorkspaceState, path: string, svgs: SvgRendering) {
  const bytes = await readImageBytes(workspace, path);
  if (!bytes) return undefined;
  if (!path.toLowerCase().endsWith(".svg")) return Buffer.from(bytes);
  return bytes.length > MAX_SVG_BYTES ? undefined : svgs.render(bytes);
}

/**
 * One browser for a run's SVGs, started on the first one not already known not to render;
 * after the browser fails, the run's other SVGs are skipped, and so are the next hour's runs
 * on the same browser executable: a browser that hangs at startup cost every done, verify
 * and accept its startup timeout (then 10 s, now 30 s).
 */
class SvgRendering {
  readonly unrendered: string[] = [];
  /** True once the browser rendered or judged a picture, false once it failed. */
  browser: boolean | undefined;
  private rasterizer: SvgRasterizer | undefined;

  constructor(
    private readonly known: ReadonlySet<string>,
    private readonly browserDown: boolean,
  ) {}

  async render(svg: Uint8Array): Promise<Buffer | undefined> {
    const digest = sha256(svg);
    if (this.browserDown || this.browser === false || this.known.has(digest)) return undefined;
    this.rasterizer ??= svgRasterizer();
    const rendered = await this.rasterizer.render(svg);
    this.browser = !("failed" in rendered && rendered.failed === "browser");
    if ("png" in rendered) return rendered.png;
    if (rendered.failed === "picture") this.unrendered.push(digest);
    return undefined;
  }

  async close(): Promise<void> {
    await this.rasterizer?.close();
  }
}

function unrenderedPath(workspace: WorkspaceState): string {
  return join(workspace.paths.sessionDir, UNRENDERED_FILE);
}

interface RenderMemory {
  readonly sha256: string[];
  readonly browserFailure?: { readonly identity: string; readonly at: string };
}

function parseRenderMemory(text: string | undefined): RenderMemory {
  try {
    const parsed =
      text === undefined
        ? undefined
        : (JSON.parse(text) as { sha256?: unknown; browserFailure?: unknown });
    const failure = parsed?.browserFailure as { identity?: unknown; at?: unknown } | undefined;
    return {
      sha256: Array.isArray(parsed?.sha256)
        ? parsed.sha256.filter((entry): entry is string => typeof entry === "string")
        : [],
      ...(typeof failure?.identity === "string" && typeof failure.at === "string"
        ? { browserFailure: { identity: failure.identity, at: failure.at } }
        : {}),
    };
  } catch {
    return { sha256: [] };
  }
}

async function renderMemory(workspace: WorkspaceState): Promise<RenderMemory> {
  const text = await workspace.files.readTextIfExists(unrenderedPath(workspace));
  return parseRenderMemory(text.ok ? text.value : undefined);
}

/** Under the lock: SVGs that did not render, and a browser that failed or works again. */
async function renderMemoryMutation(
  workspace: WorkspaceState,
  prepared: PreparedResultImages,
): Promise<FileMutation[]> {
  if (!prepared.unrendered.length && !prepared.browser) return [];
  const path = unrenderedPath(workspace);
  const existing = await workspace.files.readTextIfExists(path);
  if (!existing.ok) return [];
  const before = parseRenderMemory(existing.value);
  const failure = prepared.browser
    ? prepared.browser.worked
      ? undefined
      : { identity: prepared.browser.identity, at: new Date().toISOString() }
    : before.browserFailure;
  const digests = [...new Set([...before.sha256, ...prepared.unrendered])].slice(-MAX_UNRENDERED);
  const content = `${JSON.stringify({ version: 1, sha256: digests, ...(failure ? { browserFailure: failure } : {}) })}\n`;
  return content === existing.value
    ? []
    : [
        {
          kind: "write",
          path,
          content,
          mode: 0o600,
          expectedBefore: filePrecondition(existing.value),
        },
      ];
}
