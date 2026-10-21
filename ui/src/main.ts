import { openEvents, signIn } from "./api.js";
import { onKey } from "./keyboard.js";
import { liveHandlers, startLive } from "./live.js";
import { render } from "./render.js";
import {
  loadFeatureAndMap,
  loadMeta,
  loadOverview,
  loadRequests,
  refreshVisible,
} from "./resources.js";
import { readReviewed } from "./reviewed.js";
import { applyRoute } from "./router.js";
import { readSeen } from "./seen.js";
import { parseRoute } from "./state.js";
import { schedule, setRenderer, state } from "./store.js";
import { applyTheme } from "./theme.js";

const TOKEN_HASH = /^#t=([A-Za-z0-9_-]+)$/;

async function start(): Promise<void> {
  setRenderer(render);
  applyTheme();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme());
  // A fresh link pasted into an open tab only changes the hash; start over with it.
  window.addEventListener("hashchange", () => {
    if (TOKEN_HASH.test(location.hash)) location.reload();
  });
  const token = TOKEN_HASH.exec(location.hash)?.[1];
  if (token) {
    const signedIn = await signIn(token).catch(() => false);
    history.replaceState(null, "", `${location.pathname}#/`);
    if (!signedIn) {
      state.signedOut = true;
      render();
      return;
    }
  }
  const seen = readSeen();
  state.seenBefore = { ...seen };
  state.reviewed = readReviewed();
  state.route = parseRoute(location.hash);
  render();
  await Promise.all([loadMeta(), loadOverview()]);
  if (state.signedOut) return render();
  window.addEventListener("hashchange", applyRoute);
  document.addEventListener("keydown", onKey);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshVisible();
  });
  applyRoute();
  void loadRequests();
  // The stream names what changed, but sees only `.visp/`. While it is open the open feature
  // is also re-read every 30 s and a second after each change, since edits to the product's
  // own files make checks stale without an event; while it is down the page polls.
  startLive({
    open: openEvents,
    ...liveHandlers({
      route: () => state.route,
      visible: () => document.visibilityState === "visible",
      signedOut: () => state.signedOut,
      live: () => state.live,
      setLive: (live) => {
        state.live = live;
      },
      loadOverview: () => void loadOverview(),
      loadRequests: () => void loadRequests(),
      loadFeature: loadFeatureAndMap,
      refreshVisible,
      schedule,
    }),
  });
}

void start();
