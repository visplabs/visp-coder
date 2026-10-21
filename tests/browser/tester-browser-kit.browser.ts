import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TESTER_BROWSER_KIT } from "../../src/workflow/product/tester/tester-browser-kit.js";

interface Page {
  evaluate(code: unknown, ...args: unknown[]): Promise<unknown>;
  point(selector: string, fx?: number, fy?: number): Promise<{ x: number; y: number }>;
  drag(
    from: { x: number; y: number },
    to: { x: number; y: number },
    options?: { held?: () => Promise<void> },
  ): Promise<void>;
  click(point: { x: number; y: number }): Promise<void>;
  waitFor(
    fn: string | ((...args: never[]) => unknown),
    options?: unknown,
    ...args: unknown[]
  ): Promise<unknown>;
  screenshot(path?: string): Promise<Buffer>;
  close(): Promise<void>;
}
interface Kit {
  BrowserUnavailable: new (message: string) => Error;
  serveDir(dir: string): Promise<{ url: string; close(): void }>;
  openPage(
    url: string,
    options?: { width?: number; height?: number; touch?: boolean },
  ): Promise<Page>;
}

const run = promisify(execFile);
const html = `<!doctype html><meta name="viewport" content="width=device-width"><style>body{margin:0}#pad{width:300px;height:200px;background:orange;touch-action:none}</style>
<div id="pad">Ready</div><script src="app.js"></script>`;
// Records only trusted events, so synthetic dispatch could not satisfy it.
const script = `const pad=document.querySelector('#pad');window.drags=[];let cur;
pad.addEventListener('pointerdown',e=>{if(!e.isTrusted)return;cur={type:e.pointerType,x0:e.clientX,y0:e.clientY};pad.setPointerCapture(e.pointerId);pad.textContent='Held'});
pad.addEventListener('pointermove',e=>{if(cur&&e.isTrusted){cur.x1=e.clientX;cur.y1=e.clientY}});
pad.addEventListener('pointerup',e=>{if(cur&&e.isTrusted){cur.released=true;window.drags.push(cur);cur=undefined;pad.textContent='Released'}});
pad.addEventListener('click',e=>{if(e.isTrusted)pad.dataset.clicked='yes'});`;

const chromeProcesses = async () =>
  (await run("ps", ["-eo", "pid=,args="])).stdout
    .split("\n")
    .filter((line) => line.includes("acceptance-chrome-"))
    .map((line) => Number(line.trim().split(/\s+/)[0]));
const profiles = () =>
  readdirSync(tmpdir()).filter((name) => name.startsWith("acceptance-chrome-"));

let dir: string;
let kit: Kit;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "visp-kit-browser-"));
  await writeFile(join(dir, "kit.mjs"), TESTER_BROWSER_KIT);
  await writeFile(join(dir, "index.html"), html);
  await writeFile(join(dir, "app.js"), script);
  kit = (await import(pathToFileURL(join(dir, "kit.mjs")).href)) as Kit;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("tester browser kit in real Chrome", () => {
  it.each([
    ["mouse", false],
    ["touch", true],
  ] as const)("native %s drags reach the page in several directions", async (kind, touch) => {
    const ends = [
      { x: 0.8, y: 0.2 },
      { x: 0.1, y: 0.9 },
      { x: 0.9, y: 0.1 },
    ];
    const server = await kit.serveDir(dir);
    const before = await chromeProcesses();
    const page = await kit.openPage(server.url, {
      width: touch ? 390 : 1280,
      height: 800,
      touch,
    });
    try {
      const start = await page.point("#pad", 0.5, 0.5);
      let heldLabel = "";
      for (const [index, end] of ends.entries()) {
        const target = await page.point("#pad", end.x, end.y);
        await page.drag(start, target, {
          held: async () => {
            heldLabel = String(
              await page.evaluate(() => document.querySelector("#pad")?.textContent),
            );
          },
        });
        expect(heldLabel, `held state of drag ${index}`).toBe("Held");
        await page.waitFor(`window.drags.length === ${index + 1}`);
      }
      const drags = (await page.evaluate(
        () => (window as unknown as { drags: unknown[] }).drags,
      )) as {
        type: string;
        x0: number;
        y0: number;
        x1: number;
        y1: number;
        released: boolean;
      }[];
      expect(drags).toHaveLength(3);
      expect(new Set(drags.map((drag) => drag.type))).toEqual(new Set([kind]));
      expect(drags.every((drag) => drag.released)).toBe(true);
      // Directions: right and up, left and down, right and up (signs of the pull vector).
      const signs = drags.map((drag) => [
        Math.sign(drag.x1 - drag.x0),
        Math.sign(drag.y1 - drag.y0),
      ]);
      expect(signs).toEqual([
        [1, -1],
        [-1, 1],
        [1, -1],
      ]);
      if (!touch) {
        await page.click(start);
        await page.waitFor(
          () => document.querySelector<HTMLElement>("#pad")?.dataset.clicked === "yes",
        );
      }
      const png = await page.screenshot(join(dir, "shot.png"));
      expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      expect((await readFile(join(dir, "shot.png"))).equals(png)).toBe(true);
      expect(await chromeProcesses()).not.toEqual(before);
    } finally {
      await page.close();
      server.close();
    }
  });

  // Pinned suites of five slingshot runs failed on these forms, not on the product.
  it("calls a function written as a string, with its arguments", async () => {
    const server = await kit.serveDir(dir);
    const page = await kit.openPage(server.url);
    try {
      expect(await page.evaluate("() => document.querySelector('#pad').textContent")).toBe("Ready");
      expect(await page.evaluate("(a, b) => a + b", 2, 3)).toBe(5);
      expect(await page.evaluate("async (s) => document.querySelector(s).id", "#pad")).toBe("pad");
      const add = (a: number, b: number) => a * b;
      expect(await page.evaluate(add.toString(), 4, 5)).toBe(20);
      // Expressions and statements still return their value.
      expect(await page.evaluate("document.querySelector('#pad').id")).toBe("pad");
      expect(await page.evaluate("(() => 7)()")).toBe(7);
      expect(await page.evaluate("window.kitTest = 2; window.kitTest + 1")).toBe(3);
      await expect(page.evaluate("document.title", 1)).rejects.toThrow(/arguments.*not a function/);
    } finally {
      await page.close();
      server.close();
    }
  });

  it("passes waitFor arguments to the page function and names the last error on timeout", async () => {
    const server = await kit.serveDir(dir);
    const page = await kit.openPage(server.url);
    try {
      await page.evaluate("window.level = 2");
      const level = (wanted: number) => (window as unknown as { level: number }).level === wanted;
      expect(await page.waitFor(level, { timeoutMs: 1000 }, 2)).toBe(true);
      expect(await page.waitFor("(l) => window.level === l", { timeoutMs: 1000 }, 2)).toBe(true);
      expect(await page.waitFor(level, undefined, 2)).toBe(true);
      await expect(page.waitFor(level, 2)).rejects.toThrow(/options object/);
      const outside = 3;
      await expect(
        page.waitFor(() => (window as unknown as { level: number }).level === outside, {
          timeoutMs: 200,
        }),
      ).rejects.toThrow(/timed out after 200ms.*outside is not defined.*pass them as args/);
    } finally {
      await page.close();
      server.close();
    }
  });

  it("close is safe twice and leaves no browser process or profile", async () => {
    const server = await kit.serveDir(dir);
    const before = await chromeProcesses();
    const knownProfiles = profiles();
    const page = await kit.openPage(server.url);
    const started = (await chromeProcesses()).filter((pid) => !before.includes(pid));
    expect(started.length).toBeGreaterThan(0);
    await expect(page.close()).resolves.toBeUndefined();
    await expect(page.close()).resolves.toBeUndefined();
    server.close();
    await expect(page.evaluate("1")).rejects.toThrow();
    const remaining = await chromeProcesses();
    expect(remaining.filter((pid) => started.includes(pid))).toEqual([]);
    expect(profiles().filter((name) => !knownProfiles.includes(name))).toEqual([]);
  });

  it("reports a page that does not load as a plain error, not an unavailable browser", async () => {
    const before = profiles();
    const failure = await kit.openPage("http://127.0.0.1:1/").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(kit.BrowserUnavailable);
    expect(profiles().filter((name) => !before.includes(name))).toEqual([]);
  });

  it("throws BrowserUnavailable when CHROME_BIN does not exist", async () => {
    const before = profiles();
    const saved = process.env.CHROME_BIN;
    process.env.CHROME_BIN = join(dir, "no-such-chrome");
    try {
      const failure = await kit.openPage("http://127.0.0.1:1/").catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(kit.BrowserUnavailable);
      expect((failure as Error).message).toContain("no-such-chrome");
      expect((failure as Error).message).not.toContain("\n");
    } finally {
      if (saved === undefined) delete process.env.CHROME_BIN;
      else process.env.CHROME_BIN = saved;
    }
    expect(profiles().filter((name) => !before.includes(name))).toEqual([]);
    expect(existsSync(join(dir, "no-such-chrome"))).toBe(false);
  });
});

describe("tester browser kit server and signals", () => {
  it("serves files inside the directory only, never through symlinks or dot segments", async () => {
    const outside = await mkdtemp(join(tmpdir(), "visp-kit-outside-"));
    try {
      const site = join(dir, "site");
      await mkdir(join(site, "sub"), { recursive: true });
      await mkdir(join(site, ".git"));
      await writeFile(join(outside, "secret.txt"), "outside secret");
      await writeFile(join(site, "index.html"), "root page");
      await writeFile(join(site, "sub", "index.html"), "sub page");
      await writeFile(join(site, "app.js"), "let a=1");
      await writeFile(join(site, ".env"), "TOKEN=1");
      await writeFile(join(site, ".git", "config"), "[core]");
      await symlink(join(outside, "secret.txt"), join(site, "link.txt"));
      await symlink(outside, join(site, "dirlink"));
      await symlink(join(site, "app.js"), join(site, "alias.js"));
      const server = await kit.serveDir(site);
      try {
        const get = async (path: string) => {
          const response = await fetch(server.url + path);
          return { status: response.status, body: await response.text() };
        };
        expect(await get("/")).toEqual({ status: 200, body: "root page" });
        expect(await get("/sub/")).toEqual({ status: 200, body: "sub page" });
        expect(await get("/sub")).toEqual({ status: 200, body: "sub page" });
        expect(await get("/app.js")).toMatchObject({ status: 200, body: "let a=1" });
        expect(await get("/alias.js")).toMatchObject({ status: 200, body: "let a=1" });
        for (const blocked of [
          "/link.txt",
          "/dirlink/secret.txt",
          "/.env",
          "/.git/config",
          "/%2e%2e/x",
          "/..%2f/etc/passwd",
          "/sub/%2e%2e/.env",
          "/missing.txt",
        ]) {
          const result = await get(blocked);
          expect(result.status, blocked).toBe(404);
          expect(result.body).not.toContain("secret");
          expect(result.body).not.toContain("TOKEN");
        }
      } finally {
        server.close();
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("ends Chrome and removes its profile when the suite is stopped by SIGTERM", async () => {
    const suite = `import { openPage, serveDir } from "./kit.mjs";
const server = await serveDir(process.cwd());
await openPage(server.url);
console.log("ready");
setInterval(() => {}, 1000);
`;
    await writeFile(join(dir, "suite.mjs"), suite);
    const before = await chromeProcesses();
    const knownProfiles = profiles();
    const child = spawn(process.execPath, [join(dir, "suite.mjs")], {
      cwd: dir,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const closed = new Promise<string | null>((done) =>
      child.once("exit", (_code, signal) => done(signal)),
    );
    try {
      await new Promise<void>((ready, failed) => {
        child.stdout.on("data", (chunk) => String(chunk).includes("ready") && ready());
        child.once("exit", () => failed(new Error("suite exited before it was ready")));
      });
      const started = (await chromeProcesses()).filter((pid) => !before.includes(pid));
      expect(started.length).toBeGreaterThan(0);
      child.kill("SIGTERM");
      expect(await closed).toBe("SIGTERM");
      const deadline = Date.now() + 5000;
      let left = started;
      while (left.length > 0 && Date.now() < deadline) {
        await new Promise((tick) => setTimeout(tick, 100));
        const alive = await chromeProcesses();
        left = started.filter((pid) => alive.includes(pid));
      }
      expect(left).toEqual([]);
      expect(profiles().filter((name) => !knownProfiles.includes(name))).toEqual([]);
    } finally {
      child.kill("SIGKILL");
    }
  });
});
