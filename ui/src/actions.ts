import { announce } from "./announce.js";
import { refreshVisible } from "./resources.js";
import { writeReviewed } from "./reviewed.js";
import { navigate } from "./router.js";
import type { Actions } from "./state.js";
import { schedule, state } from "./store.js";
import { currentTheme, saveTheme } from "./theme.js";

export const actions: Actions = {
  navigate,
  toggle(key) {
    if (state.expanded.has(key)) state.expanded.delete(key);
    else state.expanded.add(key);
    schedule();
  },
  copy(text, button) {
    const label = button.querySelector(".copy-label") ?? button;
    const original = label.textContent;
    const done = (word: string) => {
      label.textContent = word;
      announce(word);
      window.setTimeout(() => {
        label.textContent = original;
      }, 1_600);
    };
    navigator.clipboard?.writeText(text).then(
      () => done("Copied"),
      () => done("Select and copy manually"),
    ) ?? done("Select and copy manually");
  },
  refresh: refreshVisible,
  setDraft(key, value) {
    state.drafts[key] = value;
  },
  enableNotifications() {
    if (typeof Notification === "undefined") return;
    void Notification.requestPermission().then((permission) => {
      state.notifications = permission;
      schedule();
    });
  },
  cycleTheme() {
    const order = { system: "light", light: "dark", dark: "system" } as const;
    saveTheme(order[currentTheme()]);
    schedule();
  },
  toggleWrap() {
    state.wrapOutput = !state.wrapOutput;
    schedule();
  },
  toggleHelp() {
    state.showHelp = !state.showHelp;
    schedule();
  },
  selectFinding(feature, id) {
    state.selectedFinding[feature] = id;
    schedule();
  },
  filterNeeds(filter) {
    state.needsFilter = filter;
    schedule();
  },
  filterRuns(filter) {
    state.runsFilter = filter;
    schedule();
  },
  setMapView(feature, change) {
    const current = state.map[feature] ?? { openModules: [], allOpen: false };
    state.map[feature] = { ...current, ...change };
    schedule();
  },
  toggleReviewed(feature, node, digest) {
    const ticks = { ...(state.reviewed[feature] ?? {}) };
    if (ticks[node] === digest) delete ticks[node];
    else ticks[node] = digest;
    state.reviewed = { ...state.reviewed, [feature]: ticks };
    writeReviewed(state.reviewed);
    schedule();
  },
};
