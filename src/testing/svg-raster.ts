import { captureScreenshot, type PageSend, pageConnection } from "./browser-session.js";
import { type ChromeTransport, launchChrome } from "./chrome-transport.js";

const VIEWPORT = { width: 1024, height: 768 };

/** One SVG's PNG; or "picture" when it does not render, "browser" when no usable browser ran. */
export type SvgRender = { readonly png: Buffer } | { readonly failed: "picture" | "browser" };

export interface SvgRasterizer {
  render(svg: Uint8Array): Promise<SvgRender>;
  close(): Promise<void>;
}

/**
 * Render SVGs to PNGs in one headless browser, as a viewer would see each opened in one.
 * Reviewers can open PNG files but not SVG ones, so a vector picture otherwise reaches them
 * only as markup. Each SVG is shown through an `<img>` on a data-URL page: in that context it
 * runs no script and loads nothing external. The browser starts on the first render and is
 * shared. Once it fails to start, or a render fails in a way that may be the browser's (an
 * error or timeout rather than a picture that does not load), later renders report "browser"
 * without trying again, so a missing browser costs one attempt per run rather than one per file.
 * The browser renders in software: a still picture needs no GPU, and on a host without one (CI
 * runners, most VMs) Chrome's SwiftShader fallback made the screenshot pass the then 10 s
 * timeout under load, so the reviewer lost the picture. Each step now gets 30 s: on CI a render
 * step took up to 8-10 s, and a slow worker machine is no broken browser.
 */
export function svgRasterizer(
  options: { binary?: string; timeoutMs?: number } = {},
): SvgRasterizer {
  const timeoutMs = options.timeoutMs ?? 30_000;
  let transport: Promise<ChromeTransport | undefined> | undefined;
  let broken = false;
  const browser = () => {
    transport ??= launchChrome({
      binary: options.binary,
      startupTimeoutMs: timeoutMs,
      operationTimeoutMs: timeoutMs,
      gpu: false,
    }).catch(() => undefined);
    return transport;
  };
  return {
    async render(svg) {
      const chrome = broken ? undefined : await browser();
      if (!chrome) {
        broken = true;
        return { failed: "browser" };
      }
      try {
        const png = await renderPicture(chrome, svg);
        return png ? { png } : { failed: "picture" };
      } catch {
        broken = true;
        return { failed: "browser" };
      }
    },
    async close() {
      const chrome = await transport;
      await chrome?.close().catch(() => undefined);
    },
  };
}

async function renderPicture(
  transport: ChromeTransport,
  svg: Uint8Array,
): Promise<Buffer | undefined> {
  const send = await pageConnection(transport);
  try {
    return await screenshotPicture(send, svg);
  } finally {
    await transport.send("Target.closeTarget", { targetId: send.targetId }).catch(() => undefined);
  }
}

async function screenshotPicture(send: PageSend, svg: Uint8Array): Promise<Buffer | undefined> {
  await send("Emulation.setDeviceMetricsOverride", {
    ...VIEWPORT,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const source = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const page = `<!doctype html><html><body style="margin:0;background:#fff"><img id="picture" alt="" style="display:block;margin:12px;width:${VIEWPORT.width - 24}px;height:${VIEWPORT.height - 24}px;object-fit:contain" src="${source}"></body></html>`;
  await send("Page.navigate", {
    url: `data:text/html;base64,${Buffer.from(page).toString("base64")}`,
  });
  const loaded = await send("Runtime.evaluate", {
    expression:
      "new Promise(resolve => { const settle = () => { const image = document.getElementById('picture'); if (!image) return resolve(false); if (image.complete) return resolve(image.naturalWidth > 0); image.onload = () => resolve(true); image.onerror = () => resolve(false); }; if (document.readyState === 'complete') settle(); else addEventListener('load', settle, { once: true }); })",
    awaitPromise: true,
    returnByValue: true,
  });
  const result = loaded.result as { value?: unknown } | undefined;
  return result?.value === true ? await captureScreenshot(send) : undefined;
}
