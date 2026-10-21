import { field, named, walkNamed } from "../../../graph/extract/nodes.js";
import { parseSource, type SyntaxNode } from "../../../graph/extract/parser.js";
import { hasUiIntent } from "../request-promises.js";
import browserKit from "./scripts/browser-kit.script.mjs?raw";

/**
 * A browser kit for the tester's single test file (Node 22+, standard library only): a real
 * headless Chrome from CHROME_BIN, native mouse and touch input, and a teardown that never
 * throws. It prints nothing (never `FAIL:` or `PASS:`), adds no assertions and defines only
 * `BrowserUnavailable`, `serveDir` and `openPage`. Its source is scripts/browser-kit.script.mjs,
 * inserted verbatim.
 */
export const TESTER_BROWSER_KIT = browserKit;

const BROWSER_RULES: readonly string[] = [
  "- Browser UI: the request describes something used in a browser. If the request only mentions HTML, CSS or a UI as file content or output and nothing is opened in a browser, ignore this bullet and the kit and use the normal rules. Otherwise write the file as Node.js (`*.acceptance.mjs`) and drive the real page with the kit API below. VISP inserts the kit at the top of your file; do not paste or redeclare it. It adds no assertions and does not count toward the 30-test/500-line guidance for your own content. The 64 KB file limit includes the inserted kit. Start the product the way the request says; when it only says index.html opens over HTTP, use `serveDir(process.cwd())`. `openPage(url, { width, height, touch })` starts a fresh headless Chrome and returns a page with `evaluate`, `waitFor`, `rect`, `point`, `drag`, `click`, `screenshot` and `close`. Interact only through native input (`page.point(selector, fx, fy)`, `page.drag(from, to, { held })`, `page.click(p)`) and read state through the interfaces the request names with `page.evaluate`. Never synthesize input with dispatchEvent, `new PointerEvent` or `element.click()`: that does not show that real input works. Never write your own Chrome, DevTools or `--dump-dom` code.",
  "- When you use the kit, choose real-input cases as a player would: press on the element the request says is pressed (search a small grid over its box for a start point where the drag changes state, bounded by iteration count), pull in at least two different directions, one with a vertical component, and assert only the direction (sign or quadrant) the request's convention implies. Use the viewports the request names, with `touch: true` for a phone.",
  "- When you use the kit: if `openPage` throws `BrowserUnavailable` (Chrome cannot start or was lost), that is an environment problem, not a product failure: re-throw it out of your per-test try/catch (print a `FAIL:` line only when `!(err instanceof BrowserUnavailable)`), stop running further tests, and print exactly one line `ENVIRONMENT ERROR: <err.message>` from your top-level handler, with no `FAIL:` line and no stack trace, then exit non-zero. Any other error (for example the page does not load) is that test's failure. Always `await page.close()` in a finally block and close servers you start; `close` never throws.",
  "- When you use the kit, open the page and check once that the interface the request names (for example its test hooks) exists, with one short wait; when it is missing, print each test's FAIL line without opening or waiting again, so an unimplemented project fails within seconds.",
  "- Cover the request's screen flow through the visible controls (for example win → next level/next screen, loss → retry, restart) and each stated effect over time (damage, burning, timers) at least once; and for drag input assert the vertical direction as well as the horizontal one. Always-available controls: check in every state, including won, lost, game over and error.",
];

/**
 * Tester-prompt lines for a request that describes something to see in a browser: the rules
 * and compact API signatures. VISP supplies the source in the saved test file. Nothing for any other request.
 */
export function testerBrowserKitLines(request: string): readonly string[] {
  if (!hasUiIntent(request)) return [];
  return [
    ...BROWSER_RULES,
    "",
    "Browser kit API (provided by VISP; Point = { x, y } in viewport CSS pixels):",
    "```text",
    "new BrowserUnavailable(message) -> Error; Chrome could not start or was lost.",
    "serveDir(dir, { fallback = 'index.html', dotfiles = false } = {}) -> Promise<{ url, close() }>; serve files over loopback HTTP.",
    "openPage(url, { width = 1280, height = 800, touch = false, timeoutMs = 20000 } = {}) -> Promise<page>; open fresh real Chrome.",
    'page.evaluate(code, ...args) -> Promise<JSON value>; run a function with args in the page; a string is an expression, and a string whose value is a function ("(a) => a") is called with args.',
    "page.waitFor(fn, { timeoutMs = 8000, everyMs = 50 } = {}, ...args) -> Promise<truthy value>; poll fn(...args) in the page. Page code cannot read Node variables: pass them as args.",
    "page.rect(selector) -> Promise<{ x, y, width, height }>; first matching element's viewport box.",
    "page.point(selector, fx = 0.5, fy = 0.5) -> Promise<Point>; fractional position in an element's box.",
    "page.drag(from, to, { steps = 12, stepMs = 16, held } = {}) -> Promise<void>; native press/move/release; await held() before release.",
    "page.click(point) -> Promise<void>; native click or tap.",
    "page.sleep(ms) -> Promise<void>; bounded delay.",
    "page.screenshot(path?) -> Promise<Buffer>; PNG, optionally also saved to path.",
    "page.close() -> Promise<void>; safe teardown, never throws.",
    "```",
    "",
  ];
}

const INSERTED_BROWSER_KIT = `// VISP inserted browser kit\n${TESTER_BROWSER_KIT}\n`;
const KIT_NAMES = new Set(["openPage", "serveDir", "BrowserUnavailable"]);

/** Prepare once before validation: baseline, saved file and pin hash all use these bytes. */
export async function withTesterBrowserKit(
  request: string,
  file: { name: string; content: string },
): Promise<{ name: string; content: string }> {
  if (!hasUiIntent(request) || !file.name.endsWith(".mjs")) return file;
  if (file.content.includes(TESTER_BROWSER_KIT)) return file;
  const parsed = await parseSource("javascript", file.content);
  if (parsed.kind !== "parsed") return file;
  try {
    const root = parsed.tree.root;
    // A legacy kit or tester-owned binding must never be redeclared by the inserted kit.
    if (named(root).some(definesKitName)) return file;
    let referenced = false;
    walkNamed(root, (node) => {
      if (
        ["identifier", "shorthand_property_identifier"].includes(node.type) &&
        KIT_NAMES.has(node.text)
      )
        referenced = true;
      return !referenced;
    });
    if (!referenced) return file;
    const shebang = file.content.match(/^#![^\n]*(?:\n|$)/)?.[0] ?? "";
    return {
      ...file,
      content: shebang + INSERTED_BROWSER_KIT + file.content.slice(shebang.length),
    };
  } finally {
    parsed.dispose();
  }
}

function definesKitName(node: SyntaxNode): boolean {
  if (node.type === "export_statement") {
    const declaration = field(node, "declaration");
    return declaration !== undefined && definesKitName(declaration);
  }
  if (
    ["function_declaration", "generator_function_declaration", "class_declaration"].includes(
      node.type,
    )
  )
    return KIT_NAMES.has(field(node, "name")?.text ?? "");
  if (["lexical_declaration", "variable_declaration"].includes(node.type))
    return named(node).some((child) => patternDefinesKitName(field(child, "name")));
  if (node.type !== "import_statement") return false;
  let defined = false;
  walkNamed(node, (child) => {
    if (child.type === "import_specifier") {
      defined ||= KIT_NAMES.has((field(child, "alias") ?? field(child, "name"))?.text ?? "");
      return false;
    }
    if (child.type === "identifier" && KIT_NAMES.has(child.text)) defined = true;
    return !defined;
  });
  return defined;
}

function patternDefinesKitName(node: SyntaxNode | undefined): boolean {
  if (!node) return false;
  if (["identifier", "shorthand_property_identifier_pattern"].includes(node.type))
    return KIT_NAMES.has(node.text);
  if (node.type === "pair_pattern") return patternDefinesKitName(field(node, "value"));
  if (["assignment_pattern", "object_assignment_pattern"].includes(node.type))
    return patternDefinesKitName(field(node, "left"));
  return named(node).some(patternDefinesKitName);
}

/** Repair feedback contains only the tester's own content, keeping the kit out of responses. */
export function testerOwnContent(content: string): string {
  const shebang = content.match(/^#![^\n]*(?:\n|$)/)?.[0] ?? "";
  const body = content.slice(shebang.length);
  return body.startsWith(INSERTED_BROWSER_KIT)
    ? shebang + body.slice(INSERTED_BROWSER_KIT.length)
    : content;
}
