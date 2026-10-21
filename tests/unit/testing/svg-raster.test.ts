import { beforeEach, describe, expect, it, vi } from "vitest";

/** A stand-in Chrome: counts launches, pages and closes; renders whatever the page loads. */
const chrome = vi.hoisted(() => ({
  launches: 0,
  pages: 0,
  closedPages: 0,
  closed: 0,
  launch: "ok" as "ok" | "fail",
  loads: true,
  hang: false,
  options: [] as unknown[],
}));

vi.mock("../../../src/testing/chrome-transport.js", () => ({
  launchChrome: async (options: unknown) => {
    chrome.launches += 1;
    chrome.options.push(options);
    if (chrome.launch === "fail") throw new Error("no browser here");
    return {
      onEvent: () => () => undefined,
      send: async (method: string) => {
        if (method === "Target.closeTarget") chrome.closedPages += 1;
        return {};
      },
      close: async () => {
        chrome.closed += 1;
      },
    };
  },
}));

vi.mock("../../../src/testing/browser-session.js", () => ({
  pageConnection: async () => {
    chrome.pages += 1;
    return Object.assign(
      async (method: string) => {
        if (chrome.hang && method === "Page.navigate") throw new Error("timed out");
        if (method === "Runtime.evaluate") return { result: { value: chrome.loads } };
        return {};
      },
      { sessionId: "session", targetId: `page-${chrome.pages}` },
    );
  },
  captureScreenshot: async () => Buffer.from("png"),
}));

const { svgRasterizer } = await import("../../../src/testing/svg-raster.js");
const picture = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');

beforeEach(() => {
  Object.assign(chrome, {
    launches: 0,
    pages: 0,
    closedPages: 0,
    closed: 0,
    launch: "ok",
    loads: true,
    hang: false,
    options: [],
  });
});

describe("rendering SVG pictures", () => {
  it("shares one browser across pictures and closes each page", async () => {
    const rasterizer = svgRasterizer();
    expect(await rasterizer.render(picture)).toEqual({ png: Buffer.from("png") });
    expect(await rasterizer.render(picture)).toEqual({ png: Buffer.from("png") });
    await rasterizer.close();
    expect(chrome).toMatchObject({ launches: 1, pages: 2, closedPages: 2, closed: 1 });
  });

  it("renders without the GPU, whose software fallback timed out on CI screenshots", async () => {
    const rasterizer = svgRasterizer();
    await rasterizer.render(picture);
    await rasterizer.close();
    expect(chrome.options).toEqual([expect.objectContaining({ gpu: false })]);
  });

  // On CI the render path ran at up to 8-10 s per step under load; 10 s left no margin.
  it("gives a slow host 30 s per step before it calls the browser broken", async () => {
    const rasterizer = svgRasterizer();
    await rasterizer.render(picture);
    await rasterizer.close();
    expect(chrome.options).toEqual([
      expect.objectContaining({ startupTimeoutMs: 30_000, operationTimeoutMs: 30_000 }),
    ]);
  });

  it("starts no browser when nothing is rendered", async () => {
    await svgRasterizer().close();
    expect(chrome.launches).toBe(0);
  });

  it("stops after the browser fails to start", async () => {
    chrome.launch = "fail";
    const rasterizer = svgRasterizer();
    expect(await rasterizer.render(picture)).toEqual({ failed: "browser" });
    expect(await rasterizer.render(picture)).toEqual({ failed: "browser" });
    await rasterizer.close();
    expect(chrome.launches).toBe(1);
  });

  it("stops after a render fails in a way that may be the browser's", async () => {
    chrome.hang = true;
    const rasterizer = svgRasterizer();
    expect(await rasterizer.render(picture)).toEqual({ failed: "browser" });
    expect(await rasterizer.render(picture)).toEqual({ failed: "browser" });
    await rasterizer.close();
    expect(chrome).toMatchObject({ launches: 1, pages: 1, closed: 1 });
  });

  it("tells a picture that does not render from a browser that does not work", async () => {
    chrome.loads = false;
    const rasterizer = svgRasterizer();
    expect(await rasterizer.render(picture)).toEqual({ failed: "picture" });
    chrome.loads = true;
    expect(await rasterizer.render(picture)).toEqual({ png: Buffer.from("png") });
    await rasterizer.close();
    expect(chrome.launches).toBe(1);
  });
});
