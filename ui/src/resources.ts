import type {
  UiChangeMap,
  UiEvidence,
  UiExecution,
  UiFeature,
  UiHealth,
  UiMeta,
  UiOverview,
  UiRequests,
} from "../../src/ui/contract.js";
import { type Loaded, load, SignedOutError } from "./api.js";
import { announceHeadline, noticeNewRequests } from "./notify.js";
import { executionKey, type Resource, type Route, type Tab } from "./state.js";
import { schedule, state } from "./store.js";

async function fetchInto<T>(
  path: string,
  current: Resource<T> | undefined,
  assign: (value: Resource<T>) => void,
): Promise<Loaded<T> | undefined> {
  assign({ ...(current ?? {}), loading: true });
  if (current?.data === undefined) schedule();
  try {
    const result = await load<T>(path);
    if (
      result.ok &&
      current?.data !== undefined &&
      !current.error &&
      sameData(current.data, result.data)
    ) {
      // Nothing changed: skip the re-render so focus, selection and scroll stay put.
      assign({ data: current.data, loading: false, at: Date.now() });
      return result;
    }
    // Keep the last good data when a refresh fails, but say that it failed.
    assign(
      result.ok
        ? { data: result.data, loading: false, at: Date.now() }
        : {
            ...(current?.data !== undefined && result.status === 0 ? { data: current.data } : {}),
            error: result.error,
            loading: false,
          },
    );
    schedule();
    return result;
  } catch (cause) {
    if (cause instanceof SignedOutError) state.signedOut = true;
    assign({ ...(current ?? {}), loading: false });
    schedule();
    return undefined;
  }
}

/** Compares recorded content, ignoring when it was read. */
function sameData(a: unknown, b: unknown): boolean {
  const strip = (key: string, value: unknown) => (key === "readAt" ? undefined : value);
  return JSON.stringify(a, strip) === JSON.stringify(b, strip);
}

export const loadMeta = () =>
  fetchInto<UiMeta>("/api/v1/meta", state.meta, (value) => {
    state.meta = value;
  });
export const loadOverview = () =>
  fetchInto<UiOverview>("/api/v1/overview", state.overview, (value) => {
    state.overview = value;
  });
const loadHealth = () =>
  fetchInto<UiHealth>("/api/v1/health", state.health, (value) => {
    state.health = value;
  });

export async function loadRequests(): Promise<void> {
  const result = await fetchInto<UiRequests>("/api/v1/requests", state.requests, (value) => {
    state.requests = value;
  });
  if (result?.ok) noticeNewRequests(result.data);
}

export async function loadFeature(id: string): Promise<void> {
  const result = await fetchInto<UiFeature>(
    `/api/v1/features/${encodeURIComponent(id)}`,
    state.features[id],
    (value) => {
      state.features[id] = value;
    },
  );
  if (result?.ok) announceHeadline(result.data);
}

function loadExecution(feature: string, id: string): void {
  const key = executionKey(feature, id);
  if (state.executions[key]?.data) return; // A recorded run never changes.
  void fetchInto<UiExecution>(
    `/api/v1/features/${encodeURIComponent(feature)}/executions/${encodeURIComponent(id)}`,
    state.executions[key],
    (value) => {
      state.executions[key] = value;
    },
  );
}

/** The map reads git and the index, so it loads only while its tab is open. */
export async function loadMap(id: string): Promise<void> {
  await fetchInto<UiChangeMap>(
    `/api/v1/features/${encodeURIComponent(id)}/map`,
    state.maps[id],
    (value) => {
      state.maps[id] = value;
    },
  );
}

/** The evidence record reads git like the map, so it too loads only while its tab is open. */
async function loadEvidence(id: string): Promise<void> {
  await fetchInto<UiEvidence>(
    `/api/v1/features/${encodeURIComponent(id)}/evidence`,
    state.evidence[id],
    (value) => {
      state.evidence[id] = value;
    },
  );
}

/** A feature, and its map or evidence record when that tab shows it. */
export function loadFeatureAndMap(id: string): void {
  void loadFeature(id);
  if (state.route.view === "feature" && state.route.feature === id) loadTab(id, state.route.tab);
}

function loadTab(id: string, tab: Tab): void {
  if (tab === "map") void loadMap(id);
  if (tab === "evidence") void loadEvidence(id);
}

export function loadForRoute(route: Route): void {
  if (route.view === "feature") {
    void loadFeature(route.feature);
    if (route.run) loadExecution(route.feature, route.run);
    loadTab(route.feature, route.tab);
  }
  if (route.view === "health") void loadHealth();
  if (route.view === "needs") void loadRequests();
}

export function refreshVisible(): void {
  void loadOverview();
  void loadRequests();
  if (state.route.view === "feature") loadFeatureAndMap(state.route.feature);
}
