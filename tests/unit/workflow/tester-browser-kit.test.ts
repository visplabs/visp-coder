import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { environmentOnly } from "../../../src/workflow/product/tester/pinned-dispute-model.js";
import {
  TESTER_BROWSER_KIT,
  testerBrowserKitLines,
  testerOwnContent,
  withTesterBrowserKit,
} from "../../../src/workflow/product/tester/tester-browser-kit.js";

const run = promisify(execFile);
const root = process.cwd();
const tasks = join(root, "bench/tasks");
const text = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");
const quoted = (prompt: string) => prompt.slice(prompt.indexOf("“") + 1, prompt.lastIndexOf("”"));
const catapult = quoted(text("tests/fixtures/review-calibration/catapult-preview/prompt.md"));
const PROMPT_FILES = ["task.md", "session1.md", "session2.md", "conventions.md", "noise.md"];
const promptsOf = (task: string) =>
  PROMPT_FILES.filter((file) => existsSync(join(tasks, task, file))).map((file) => ({
    name: `${task}/${file}`,
    body: text("bench/tasks", task, file),
  }));

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "visp-kit-unit-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("tester browser kit gating", () => {
  it("adds no line for API, CLI and carryover requests", () => {
    const quiet = ["reservations-api", "spreadsheet-cli", "conventions-carryover"];
    for (const task of quiet)
      for (const prompt of promptsOf(task))
        expect(testerBrowserKitLines(prompt.body), prompt.name).toEqual([]);
    // lighthouse-pixel asks for a "64×64 pixel canvas scaled up", which reads as a browser canvas.
    // xbox-controller-svg asks for an SVG with a viewBox and a styled interface, which reads as a page.
    const canvas = ["lighthouse-pixel", "xbox-controller-svg"];
    for (const task of readdirSync(tasks).filter(
      (name) => !name.includes("game") && !canvas.includes(name),
    ))
      for (const prompt of promptsOf(task))
        expect(testerBrowserKitLines(prompt.body), prompt.name).toEqual([]);
    expect(testerBrowserKitLines("Export the report as CSV.")).toEqual([]);
    expect(testerBrowserKitLines("")).toEqual([]);
  });

  it("gives the canvas-worded pixel-art request the same kit as a browser game", () => {
    const lighthouse = testerBrowserKitLines(text("bench/tasks/lighthouse-pixel/task.md"));
    expect(lighthouse.length).toBeGreaterThan(3);
    expect(lighthouse).toEqual(testerBrowserKitLines(text("bench/tasks/slingshot-game/task.md")));
  });

  it("adds the rules and compact API for slingshot and catapult requests", () => {
    for (const request of [text("bench/tasks/slingshot-game/task.md"), catapult]) {
      const lines = testerBrowserKitLines(request);
      const prompt = lines.join("\n");
      expect(lines.length).toBeGreaterThan(3);
      expect(prompt).not.toContain(TESTER_BROWSER_KIT.trim());
      expect(prompt).toContain(
        "VISP inserts the kit at the top of your file; do not paste or redeclare it",
      );
      for (const signature of [
        "openPage(url,",
        "serveDir(dir,",
        "BrowserUnavailable(message)",
        "page.evaluate(code,",
        "page.waitFor(fn,",
        "page.rect(selector)",
        "page.point(selector,",
        "page.drag(from,",
        "page.click(point)",
        "page.sleep(ms)",
        "page.screenshot(path?)",
        "page.close()",
      ])
        expect(prompt).toContain(signature);
      expect(prompt.length).toBeLessThan(6500);
      expect(prompt).toContain("openPage");
      expect(prompt).toContain("Never write your own Chrome, DevTools or `--dump-dom` code");
      expect(prompt).not.toMatch(/dispatchEvent\(/);
    }
  });

  it("lets the tester ignore the kit when HTML, CSS or a UI is only file content or output", () => {
    const prompt = testerBrowserKitLines(
      "Write a Python CLI that renders a report as an HTML file.",
    );
    expect(prompt.length).toBeGreaterThan(0);
    const first = prompt[0] as string;
    expect(first).toContain(
      "If the request only mentions HTML, CSS or a UI as file content or output and nothing is opened in a browser, ignore this bullet and the kit and use the normal rules.",
    );
    expect(prompt[1]).toMatch(/^- When you use the kit, /);
    expect(prompt[2]).toMatch(/^- When you use the kit: /);
  });

  it("requires visible screen flow, effects over time and both drag axes", () => {
    const prompt = testerBrowserKitLines(catapult).join("\n");
    expect(prompt).toContain(
      "- Cover the request's screen flow through the visible controls (for example win → next level/next screen, loss → retry, restart) and each stated effect over time (damage, burning, timers) at least once; and for drag input assert the vertical direction as well as the horizontal one.",
    );
    expect(prompt).toContain(
      "Always-available controls: check in every state, including won, lost, game over and error",
    );
  });

  it("tells the tester to let BrowserUnavailable escape the per-test catch", () => {
    const prompt = testerBrowserKitLines(catapult).join("\n");
    expect(prompt).toContain("`!(err instanceof BrowserUnavailable)`");
    expect(prompt).toContain("`ENVIRONMENT ERROR: <err.message>`");
    expect(prompt).toContain("no `FAIL:` line");
  });
});

describe("tester browser kit source", () => {
  it("fits a raw template, stays small and prints no verdict line", () => {
    expect(TESTER_BROWSER_KIT).not.toContain("`");
    expect(TESTER_BROWSER_KIT).not.toContain("${");
    expect(Buffer.byteLength(TESTER_BROWSER_KIT)).toBeLessThan(12 * 1024);
    expect(TESTER_BROWSER_KIT).not.toMatch(/\b(?:FAIL|PASS)\b/);
    expect(TESTER_BROWSER_KIT).not.toContain("console.");
    expect(TESTER_BROWSER_KIT).not.toContain("process.stdout");
  });

  it("adds no assertion the pinned file could be counted on", () => {
    expect(TESTER_BROWSER_KIT.match(/\bassert\w*|AssertionError/g) ?? []).toHaveLength(0);
  });

  it("is a valid ES module that avoids names a tester file would declare", async () => {
    const file = join(dir, "kit.mjs");
    await writeFile(file, TESTER_BROWSER_KIT);
    await run(process.execPath, ["--check", file]);
    const declared = [
      ...TESTER_BROWSER_KIT.matchAll(
        /^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)/gm,
      ),
    ].map((match) => match[1] as string);
    const exported = ["BrowserUnavailable", "openPage", "serveDir"];
    expect(declared.filter((name) => !name.startsWith("kit")).sort()).toEqual(exported);
    const imports = [...TESTER_BROWSER_KIT.matchAll(/^import \* as (\w+) from/gm)];
    expect(imports.every((match) => match[1]?.startsWith("kit"))).toBe(true);
  });
});

describe("tester browser kit when the browser cannot start", () => {
  // The suite pattern the prompt teaches: BrowserUnavailable leaves the per-test catch.
  const suite = `import { BrowserUnavailable, openPage } from "./kit.mjs";
const tests = [["opens the page", async () => { const page = await openPage("http://127.0.0.1:1/"); await page.close(); }], ["never reached", async () => {}]];
let failed = false;
try {
  for (const [name, body] of tests) {
    try { await body(); } catch (err) {
      if (err instanceof BrowserUnavailable) throw err;
      console.log("FAIL: " + name + ": " + err.message);
      failed = true;
    }
  }
} catch (err) {
  console.log("ENVIRONMENT ERROR: " + err.message);
  process.exit(1);
}
if (failed) process.exit(1);
`;

  it("lets the suite print one environment line and no failure line", async () => {
    await writeFile(join(dir, "kit.mjs"), TESTER_BROWSER_KIT);
    await writeFile(join(dir, "suite.mjs"), suite);
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith("acceptance-chrome-"));
    const result = await run(process.execPath, [join(dir, "suite.mjs")], {
      env: { ...process.env, CHROME_BIN: join(dir, "no-such-chrome") },
    }).then(
      (done) => ({ code: 0, output: done.stdout }),
      (failure: { code: number; stdout: string }) => ({
        code: failure.code,
        output: failure.stdout,
      }),
    );
    expect(result.code).toBe(1);
    const lines = result.output.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^ENVIRONMENT ERROR: .*no-such-chrome/);
    expect(result.output).not.toMatch(/FAIL:/);
    expect(environmentOnly(result.output, ["opens the page", "never reached"])).toBe(true);
    const after = readdirSync(tmpdir()).filter((name) => name.startsWith("acceptance-chrome-"));
    expect(after.filter((name) => !before.includes(name))).toEqual([]);
  });
});

describe("VISP browser kit insertion", () => {
  const request = "Build a browser UI.";
  it.each(["openPage", "serveDir", "BrowserUnavailable"])(
    "supplies an undefined %s",
    async (name) => {
      const file = { name: "ui.acceptance.mjs", content: `console.log(typeof ${name});\n` };
      const prepared = await withTesterBrowserKit(request, file);
      expect(prepared.content).toContain(`// VISP inserted browser kit\n${TESTER_BROWSER_KIT}`);
      expect(testerOwnContent(prepared.content)).toBe(file.content);
      expect(await withTesterBrowserKit(request, prepared)).toEqual(prepared);
    },
  );

  it.each([
    "async function openPage() {}",
    "export async function openPage() {}",
    "class BrowserUnavailable extends Error {}",
    "const serveDir = () => {};",
    "let openPage;",
    "var BrowserUnavailable;",
    "const { openPage } = helpers;",
    "const { open: openPage } = helpers;",
    "const [serveDir] = helpers;",
    "import { openPage } from './helpers.mjs';",
    "import { open as openPage } from './helpers.mjs';",
    "import openPage from './helpers.mjs';",
    "import * as serveDir from './helpers.mjs';",
  ])("preserves tester-defined bindings: %s", async (definition) => {
    const file = { name: "ui.mjs", content: `${definition}\nconsole.log(openPage);\n` };
    expect(await withTesterBrowserKit(request, file)).toEqual(file);
  });

  it.each([
    "console.log('openPage serveDir BrowserUnavailable');",
    "// openPage serveDir BrowserUnavailable\nconsole.log(1);",
    "const helpers = { openPage: () => {} }; helpers.openPage();",
  ])("does not insert the kit for comments, strings or property names: %s", async (content) => {
    const file = { name: "ui.mjs", content };
    expect(await withTesterBrowserKit(request, file)).toEqual(file);
  });

  it("only supplies kit bindings to UI JavaScript files", async () => {
    const file = { name: "cli.mjs", content: "openPage();\n" };
    expect(await withTesterBrowserKit("Build a CLI", file)).toEqual(file);
    const python = { name: "ui.py", content: "openPage()\n" };
    expect(await withTesterBrowserKit(request, python)).toEqual(python);
  });

  it("keeps the interpreter directive first and removes only VISP's inserted source from feedback", async () => {
    const file = {
      name: "ui.mjs",
      content: "#!/usr/bin/env node\nawait openPage('http://localhost');\n",
    };
    const prepared = await withTesterBrowserKit(request, file);
    expect(prepared.content).toMatch(/^#![^\n]+\n\/\/ VISP inserted browser kit/);
    expect(testerOwnContent(prepared.content)).toBe(file.content);
    expect(testerOwnContent(TESTER_BROWSER_KIT + file.content)).toBe(
      TESTER_BROWSER_KIT + file.content,
    );
    await writeFile(join(dir, file.name), prepared.content);
    await run(process.execPath, ["--check", join(dir, file.name)]);
  });
});
