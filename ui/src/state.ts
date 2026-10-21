import type {
  RequestKind,
  UiChangeMap,
  UiError,
  UiEvidence,
  UiExecution,
  UiFeature,
  UiHealth,
  UiMeta,
  UiOverview,
  UiRequests,
} from "../../src/ui/contract.js";
import type { LiveState } from "./live.js";

export interface Resource<T> {
  readonly data?: T;
  readonly error?: UiError;
  readonly loading: boolean;
  /** When the data was last read, in page time. */
  readonly at?: number;
}

export const idle = <T>(): Resource<T> => ({ loading: false });

export type Tab = "now" | "review" | "runs" | "activity" | "handoff" | "map" | "evidence";
/** New tabs go last so the shortcuts of the earlier ones keep their meaning. */
export const TABS: readonly Tab[] = [
  "now",
  "review",
  "runs",
  "activity",
  "handoff",
  "map",
  "evidence",
];

/** Which requests the Needs you page lists. */
export type NeedsFilter = "all" | RequestKind;
/** Which runs the Runs tab lists. */
export type RunsFilter = "all" | "problems" | "tester";

export type Route =
  | { readonly view: "home" }
  | { readonly view: "feature"; readonly feature: string; readonly tab: Tab; readonly run?: string }
  | { readonly view: "needs" }
  | { readonly view: "health" };

export interface AppState {
  meta: Resource<UiMeta>;
  overview: Resource<UiOverview>;
  requests: Resource<UiRequests>;
  health: Resource<UiHealth>;
  features: Record<string, Resource<UiFeature>>;
  executions: Record<string, Resource<UiExecution>>;
  maps: Record<string, Resource<UiChangeMap>>;
  evidence: Record<string, Resource<UiEvidence>>;
  route: Route;
  live: LiveState;
  signedOut: boolean;
  /** Disclosure state that must survive a live re-render. */
  expanded: Set<string>;
  /** Reply drafts, kept in state so a live update never erases typing. */
  drafts: Record<string, string>;
  /** When each feature's activity was last opened, for the "new since" marker. */
  seenBefore: Record<string, string>;
  wrapOutput: boolean;
  notifications: NotificationPermission | "unsupported";
  showHelp: boolean;
  /** The finding open in each feature's Review tab. */
  selectedFinding: Record<string, string>;
  needsFilter: NeedsFilter;
  runsFilter: RunsFilter;
  /** The Map tab's view of each feature: selected node, slice filter and opened modules. */
  map: Record<string, MapView>;
  /** Reviewed ticks for this browser, by feature and node, holding the digest that was ticked. */
  reviewed: Record<string, Record<string, string>>;
}

export interface MapView {
  readonly selected?: string;
  readonly slice?: string;
  readonly openModules: readonly string[];
  readonly allOpen: boolean;
}

export function initialState(): AppState {
  return {
    meta: idle(),
    overview: idle(),
    requests: idle(),
    health: idle(),
    features: {},
    executions: {},
    maps: {},
    evidence: {},
    route: { view: "home" },
    live: "connecting",
    signedOut: false,
    expanded: new Set(),
    drafts: {},
    seenBefore: {},
    wrapOutput: true,
    notifications: typeof Notification === "undefined" ? "unsupported" : Notification.permission,
    showHelp: false,
    selectedFinding: {},
    needsFilter: "all",
    runsFilter: "all",
    map: {},
    reviewed: {},
  };
}

export function parseRoute(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#/, "").split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "needs") return { view: "needs" };
  if (parts[0] === "health") return { view: "health" };
  if (parts[0] === "f" && parts[1]) {
    const tab = (TABS as readonly string[]).includes(parts[2] ?? "") ? (parts[2] as Tab) : "now";
    const run = new URLSearchParams(query).get("run") ?? undefined;
    return { view: "feature", feature: parts[1], tab, ...(run ? { run } : {}) };
  }
  return { view: "home" };
}

export function routeHash(route: Route): string {
  if (route.view === "needs") return "#/needs";
  if (route.view === "health") return "#/health";
  if (route.view === "home") return "#/";
  const base = `#/f/${encodeURIComponent(route.feature)}/${route.tab}`;
  return route.run ? `${base}?run=${encodeURIComponent(route.run)}` : base;
}

export interface Actions {
  navigate(route: Route): void;
  toggle(key: string): void;
  copy(text: string, button: HTMLElement): void;
  refresh(): void;
  setDraft(key: string, value: string): void;
  enableNotifications(): void;
  cycleTheme(): void;
  toggleWrap(): void;
  toggleHelp(): void;
  selectFinding(feature: string, id: string): void;
  filterNeeds(filter: NeedsFilter): void;
  filterRuns(filter: RunsFilter): void;
  /** Changes the Map tab's view of a feature; opening a node opens its module. */
  setMapView(feature: string, change: Partial<MapView>): void;
  toggleReviewed(feature: string, node: string, digest: string): void;
}

export const executionKey = (feature: string, id: string) => `${feature}/${id}`;
