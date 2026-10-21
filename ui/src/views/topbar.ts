import type { FeatureSummary, UiFeature } from "../../../src/ui/contract.js";
import { h, icon } from "../dom.js";
import { type Actions, type AppState, TABS, type Tab } from "../state.js";
import { currentTheme } from "../theme.js";
import { newActivityCount } from "./activity.js";

export const TAB_NAMES: Record<Tab, string> = {
  now: "Now",
  review: "Review",
  runs: "Runs",
  activity: "Activity",
  handoff: "Handoff",
  map: "Map",
  evidence: "Evidence",
};

export function topbar(state: AppState, actions: Actions): HTMLElement {
  const route = state.route;
  const feature = route.view === "feature" ? state.features[route.feature]?.data : undefined;
  return h(
    "header",
    { class: "topbar" },
    h(
      "div",
      { class: "topbar-inner" },
      brand(state),
      featureSwitcher(state, actions),
      route.view === "feature"
        ? tabs(route.feature, route.tab, feature, state)
        : h("span", { class: "tabs-spacer" }),
      h(
        "div",
        { class: "topbar-end" },
        liveIndicator(state),
        themeButton(actions),
        needsButton(state),
      ),
    ),
  );
}

function brand(state: AppState): HTMLElement {
  const repo = state.meta.data?.repository;
  return h(
    "a",
    {
      class: "brand",
      href: "#/",
      "aria-label": `VISP dashboard${repo ? ` for ${repo.name}` : ""}`,
    },
    h("img", { src: "/symbol.svg", alt: "", width: 26, height: 26 }),
    h("span", { class: "brand-name" }, "VISP"),
    repo
      ? [
          h("span", { class: "brand-slash", "aria-hidden": "true" }, "/"),
          h("span", { class: "brand-repo", title: repo.root }, repo.name),
        ]
      : null,
  );
}

/** A native select: keyboard and screen-reader behaviour come with it. */
function featureSwitcher(state: AppState, actions: Actions): HTMLElement | null {
  const features = state.overview.data?.features ?? [];
  if (features.length < 2) return null;
  const selected = state.route.view === "feature" ? state.route.feature : "";
  const select = h(
    "select",
    { class: "switcher", "aria-label": "Feature", "data-key": "switcher" },
    selected ? null : h("option", { value: "", selected: true }, "Choose a feature"),
    features.map((feature) =>
      h(
        "option",
        { value: feature.id, selected: feature.id === selected },
        `${feature.id} · ${feature.goal}${attention(feature) ? " •" : ""}`,
      ),
    ),
  );
  select.addEventListener("change", () => {
    if (select.value) actions.navigate({ view: "feature", feature: select.value, tab: "now" });
  });
  return h("label", { class: "switcher-wrap" }, h("span", { class: "sr-only" }, "Feature"), select);
}

const attention = (feature: FeatureSummary) =>
  feature.pendingQuestions > 0 || feature.openFindings > 0;

function tabs(
  id: string,
  current: Tab,
  feature: UiFeature | undefined,
  state: AppState,
): HTMLElement {
  const counts: Partial<Record<Tab, number>> = feature
    ? {
        review: feature.findings.length,
        runs: feature.executions.filter((run) => run.current && run.status !== "passed").length,
        activity: newActivityCount(feature, state.seenBefore[feature.id]),
      }
    : {};
  return h(
    "nav",
    { class: "tabs", "aria-label": "Feature sections" },
    TABS.map((tab, index) => {
      const count = counts[tab] ?? 0;
      return h(
        "a",
        {
          class: "tab",
          href: `#/f/${encodeURIComponent(id)}/${tab}`,
          "aria-current": tab === current ? "page" : undefined,
          "data-key": `tab:${tab}`,
          title: `${TAB_NAMES[tab]} (${index + 1})`,
        },
        TAB_NAMES[tab],
        count > 0
          ? h(
              "span",
              { class: `tab-count tab-count-${tab}`, "aria-label": `${count} new or open` },
              String(count),
            )
          : null,
      );
    }),
  );
}

function liveIndicator(state: AppState): HTMLElement {
  const words = { live: "Live", connecting: "Connecting…", paused: "Updates paused" } as const;
  return h(
    "span",
    { class: `live live-${state.live}`, role: "status", "aria-live": "polite" },
    h("span", { class: "live-dot", "aria-hidden": "true" }),
    words[state.live],
  );
}

function themeButton(actions: Actions): HTMLElement {
  const theme = currentTheme();
  const next = { system: "light", light: "dark", dark: "system" } as const;
  const button = h(
    "button",
    {
      class: "icon-button",
      type: "button",
      "aria-label": `Theme: ${theme}. Switch to ${next[theme]}`,
      title: `Theme: ${theme}`,
      "data-key": "theme",
    },
    icon(theme === "light" ? "sun" : theme === "dark" ? "moon" : "auto"),
  );
  button.addEventListener("click", () => actions.cycleTheme());
  return button;
}

function needsButton(state: AppState): HTMLElement {
  const count = state.requests.data?.requests.length ?? 0;
  return h(
    "a",
    {
      class: `needs-button ${count > 0 ? "has-needs" : ""}`,
      href: "#/needs",
      "aria-current": state.route.view === "needs" ? "page" : undefined,
      "data-key": "nav:needs",
    },
    "Needs you",
    h("span", { class: "needs-count", "aria-label": `${count} waiting` }, String(count)),
  );
}
