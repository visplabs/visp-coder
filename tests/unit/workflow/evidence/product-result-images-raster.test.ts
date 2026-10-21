import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runProductReview,
  runProductVerify,
  updateProductBrief,
} from "../../../../src/workflow/product/index.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

/** A stand-in browser: records each render, whether the state lock was held, and answers as told. */
const raster = vi.hoisted(() => ({
  root: "",
  rasterizers: 0,
  closed: 0,
  renders: [] as string[],
  locks: [] as string[],
  answer: "png" as "png" | "picture" | "browser",
}));

vi.mock("../../../../src/testing/svg-raster.js", async () => {
  const { inspectStateLock } = await import("../../../../src/core/state-lock.js");
  const { deflateSync } = await import("node:zlib");
  const render = async (svg: Uint8Array) => {
    raster.renders.push(Buffer.from(svg).toString("utf8"));
    const lock = await inspectStateLock(raster.root);
    raster.locks.push(lock.ok ? lock.value.state : "unknown");
    if (raster.answer !== "png") return { failed: raster.answer };
    return { png: onePixelPng(deflateSync) };
  };
  return {
    svgRasterizer: () => {
      raster.rasterizers += 1;
      return {
        render,
        close: async () => {
          raster.closed += 1;
        },
      };
    },
    // The single-use form this replaced, so the test reports the same facts against it.
    rasterizeSvg: async (svg: Uint8Array) => {
      raster.rasterizers += 1;
      const result = await render(svg);
      return "png" in result ? result.png : undefined;
    },
  };
});

function onePixelPng(deflate: (bytes: Buffer) => Buffer): Buffer {
  const crc32 = (bytes: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflate(Buffer.from([0, 9, 9, 9]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const workspaces: TestWorkspace[] = [];
beforeEach(() => {
  Object.assign(raster, { rasterizers: 0, closed: 0, renders: [], locks: [], answer: "png" });
});
afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await workspace.destroy();
});

async function working() {
  const { workspace, brief } = await productWorkspace();
  workspaces.push(workspace);
  raster.root = workspace.root;
  const widened = await updateProductBrief(await workspace.state(), {
    brief: {
      ...brief,
      slices: brief.slices.map((slice) => ({
        ...slice,
        scope: { ...slice.scope, allowed: [...slice.scope.allowed, "art/**"] },
      })),
    },
    reason: "The slice also writes pictures",
  });
  if (!widened.ok) throw new Error(widened.error.message);
  await workspace.write("src/value.mjs", "export const value = 2;\n");
  const work = await runProductWork(await workspace.state());
  if (!work.ok) throw new Error(work.error.message);
  return workspace;
}

const svg = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4" fill="${fill}"/></svg>`;

async function routes(workspace: TestWorkspace): Promise<string[]> {
  const record = await readProductRecord(await workspace.state());
  if (!record.ok) throw new Error(record.error.message);
  return record.value.state.captures.map((capture) => (capture as { route: string }).route);
}

describe("SVG pictures the product makes", () => {
  it("are rendered in one browser before VISP takes the state lock", async () => {
    const workspace = await working();
    await workspace.write("art/a.svg", svg("red"));
    await workspace.write("art/b.svg", svg("blue"));
    const verified = await runProductVerify(await workspace.state());
    expect(verified).toMatchObject({ ok: true, value: { passed: true } });
    expect(raster.renders).toHaveLength(2);
    expect(raster.locks).toEqual(["unlocked", "unlocked"]);
    expect(raster.rasterizers).toBe(1);
    expect(raster.closed).toBe(1);
    expect((await routes(workspace)).sort()).toEqual([
      "result image: art/a.svg",
      "result image: art/b.svg",
    ]);
  });

  // A browser that hangs at startup cost every done, verify and accept its startup timeout.
  it("stop after the browser fails, and skip SVGs for an hour on this browser", async () => {
    const workspace = await working();
    await workspace.write("art/a.svg", svg("red"));
    await workspace.write("art/b.svg", svg("blue"));
    raster.answer = "browser";
    expect((await runProductVerify(await workspace.state())).ok).toBe(true);
    expect(raster.renders).toHaveLength(1);
    expect(await routes(workspace)).toEqual([]);
    raster.answer = "png";
    expect((await runProductVerify(await workspace.state())).ok).toBe(true);
    expect(raster.renders).toHaveLength(1);
    // An hour later the browser is tried again.
    const memory = join(workspace.root, ".visp/session/unrendered-svg.json");
    const remembered = JSON.parse(await readFile(memory, "utf8"));
    remembered.browserFailure.at = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await writeFile(memory, JSON.stringify(remembered));
    expect((await runProductVerify(await workspace.state())).ok).toBe(true);
    expect(raster.renders).toHaveLength(3);
    expect(JSON.parse(await readFile(memory, "utf8")).browserFailure).toBeUndefined();
  });

  it("remember a picture that does not render until its content changes", async () => {
    const workspace = await working();
    await workspace.write("art/a.svg", svg("red"));
    raster.answer = "picture";
    expect((await runProductVerify(await workspace.state())).ok).toBe(true);
    expect((await runProductVerify(await workspace.state())).ok).toBe(true);
    expect(raster.renders).toHaveLength(1);
    raster.answer = "png";
    await workspace.write("art/a.svg", svg("green"));
    expect((await runProductVerify(await workspace.state())).ok).toBe(true);
    expect(raster.renders).toHaveLength(2);
    expect(await routes(workspace)).toEqual(["result image: art/a.svg"]);
  });

  // A CI render that timed out sent the reviewer a packet with images: [] and no word of a picture.
  it.each(["browser", "picture"] as const)(
    "are named in the review packet when the %s fails, so a missing image is not read as none",
    async (answer) => {
      const workspace = await working();
      await workspace.write("art/a.svg", svg("red"));
      raster.answer = answer;
      expect((await runProductVerify(await workspace.state())).ok).toBe(true);
      const bundle = await runProductReview(await workspace.state(), {});
      if (!bundle.ok) throw new Error(bundle.error.message);
      expect(bundle.value.images).toEqual([]);
      expect(bundle.value.limitations).toEqual([
        expect.stringContaining("No image of the product's picture art/a.svg"),
      ]);
    },
  );

  it("add no note when every picture reaches the reviewer", async () => {
    const workspace = await working();
    await workspace.write("art/a.svg", svg("red"));
    expect((await runProductVerify(await workspace.state())).ok).toBe(true);
    const bundle = await runProductReview(await workspace.state(), {});
    if (!bundle.ok) throw new Error(bundle.error.message);
    expect(bundle.value.images).toHaveLength(1);
    expect(bundle.value.limitations).toBeUndefined();
  });
});
