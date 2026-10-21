import { actions } from "./actions.js";
import { announcer } from "./announce.js";
import { h } from "./dom.js";
import { updateTitle } from "./notify.js";
import { TABS } from "./state.js";
import { pending, state } from "./store.js";
import { featurePage } from "./views/feature.js";
import { needsPage } from "./views/needs.js";
import { healthPage, homePage } from "./views/pages.js";
import { TAB_NAMES, topbar } from "./views/topbar.js";

const root = document.getElementById("app") as HTMLElement;

export function render(): void {
  const focusKey = (document.activeElement as HTMLElement | null)?.dataset.key;
  const selection = captureSelection();
  const scroll = pending.scrollTop ? 0 : window.scrollY;
  root.replaceChildren(...(state.signedOut ? [signedOutPage()] : appShell()));
  window.scrollTo({ top: scroll });
  pending.scrollTop = false;
  if (pending.focusMain && !state.signedOut) {
    pending.focusMain = false;
    document.getElementById("main")?.focus({ preventScroll: true });
  } else restoreFocus(focusKey, selection);
  updateTitle();
}

function appShell(): Node[] {
  return [
    h("a", { class: "skip-link", href: "#main" }, "Skip to content"),
    topbar(state, actions),
    h("main", { id: "main", class: "page", tabindex: -1, "data-key": "main" }, page()),
    footer(),
    ...(state.showHelp ? [helpDialog()] : []),
    announcer,
  ];
}

function page(): Node {
  const route = state.route;
  if (route.view === "feature")
    return featurePage(state, actions, route.feature, route.tab, route.run);
  if (route.view === "needs") return needsPage(state, actions);
  if (route.view === "health") return healthPage(state, actions);
  return homePage(state, actions);
}

function footer(): HTMLElement {
  const meta = state.meta.data;
  const help = h(
    "button",
    { class: "link-button", type: "button", "data-key": "help" },
    "Keyboard shortcuts",
  );
  help.addEventListener("click", () => actions.toggleHelp());
  return h(
    "footer",
    { class: "footer" },
    h(
      "div",
      { class: "footer-inner" },
      meta ? h("span", { class: "mono" }, `VISP ${meta.version}`) : null,
      h(
        "a",
        { href: "#/health", "aria-current": state.route.view === "health" ? "page" : undefined },
        "Installation health",
      ),
      help,
      h("span", null, "Read-only. Commands are shown to copy, never run."),
    ),
  );
}

function signedOutPage(): HTMLElement {
  return h(
    "main",
    { class: "signed-out" },
    h("img", { src: "/symbol.svg", alt: "", width: 40, height: 40 }),
    h("h1", null, "Open the latest link from your terminal"),
    h(
      "p",
      null,
      "This dashboard opens only from the link ",
      h("code", null, "visp ui"),
      " printed, so other pages in your browser can't read it. If the dashboard was restarted, its old link stopped working. Paste the new one here, or run it again:",
    ),
    h("pre", { class: "code-block" }, h("code", null, "visp ui")),
  );
}

const SHORTCUTS: readonly (readonly [string, string])[] = [
  [`1 – ${TABS.length}`, TABS.map((tab) => TAB_NAMES[tab]).join(", ")],
  ["n", "Needs you"],
  ["r", "Refresh now"],
  ["Esc", "Back from a run, or close this help"],
  ["?", "Show or hide shortcuts"],
];

function helpDialog(): HTMLElement {
  const close = h("button", { class: "button", type: "button", "data-key": "help-close" }, "Close");
  close.addEventListener("click", () => actions.toggleHelp());
  return h(
    "div",
    { class: "help-layer", role: "dialog", "aria-modal": "true", "aria-labelledby": "help-title" },
    h(
      "div",
      { class: "help" },
      h("h2", { id: "help-title" }, "Keyboard shortcuts"),
      h(
        "dl",
        null,
        SHORTCUTS.map(([key, text]) =>
          h("div", null, h("dt", null, h("kbd", null, key)), h("dd", null, text)),
        ),
      ),
      close,
    ),
  );
}

function captureSelection(): { start: number; end: number } | undefined {
  const active = document.activeElement;
  return active instanceof HTMLTextAreaElement
    ? { start: active.selectionStart, end: active.selectionEnd }
    : undefined;
}

function restoreFocus(
  key: string | undefined,
  selection: { start: number; end: number } | undefined,
): void {
  const target = key && document.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
  if (!target) return;
  target.focus({ preventScroll: true });
  if (selection && target instanceof HTMLTextAreaElement)
    target.setSelectionRange(selection.start, selection.end);
}
