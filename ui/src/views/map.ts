import type {
  UiChangeMap,
  UiFeature,
  UiMapCheckLink,
  UiMapEdge,
  UiMapFile,
  UiMapNode,
} from "../../../src/ui/contract.js";
import { h } from "../dom.js";
import {
  executionTone,
  executionWord,
  plural,
  relativeTime,
  runShape,
  type Tone,
} from "../format.js";
import {
  BOX_HEIGHT,
  BOX_WIDTH,
  type LayoutBox,
  type LayoutLabel,
  type LayoutLink,
  layoutMap,
} from "../map-layout.js";
import type { Actions, AppState, MapView } from "../state.js";
import { cardHead, empty, pill, resource, shape } from "./parts.js";

const SVG = "http://www.w3.org/2000/svg";
/** Changed declarations not explained by any slice are filtered under this key. */
const NO_SLICE = "(none)";

export function mapPanel(feature: UiFeature, state: AppState, actions: Actions): Node {
  return resource(state.maps[feature.id], "Reading the change", actions, (map) =>
    mapContent(feature, map, state, actions),
  );
}

function mapContent(
  feature: UiFeature,
  map: UiChangeMap,
  state: AppState,
  actions: Actions,
): HTMLElement {
  const view = state.map[feature.id] ?? { openModules: [], allOpen: false };
  const byId = new Map(map.nodes.map((node) => [node.id, node]));
  const order = map.readingOrder
    .map((id) => byId.get(id))
    .filter((node): node is UiMapNode => node !== undefined)
    .filter((node) => matchesSlice(node, view.slice));
  const selected = byId.get(view.selected ?? "") ?? order[0];
  const ticks = state.reviewed[feature.id] ?? {};
  if (map.files.length === 0)
    return h(
      "div",
      { class: "map" },
      mapHeader(map, ticks),
      h(
        "div",
        { class: "card card-body" },
        empty(
          "No code change to map",
          `Nothing differs between ${baseWords(map)} and ${endWords(map)}.`,
        ),
      ),
    );
  return h(
    "div",
    { class: "map" },
    mapHeader(map, ticks),
    graphCard(feature, map, selected, view, ticks, actions),
    h(
      "div",
      { class: "columns map-columns" },
      h(
        "div",
        { class: "column-list" },
        readingList(feature, map, order, selected, view, ticks, actions),
      ),
      h(
        "div",
        { class: "column-main" },
        selected ? nodeDetail(feature, map, selected, ticks, actions) : null,
      ),
    ),
  );
}

function matchesSlice(node: UiMapNode, slice: string | undefined): boolean {
  if (!slice) return true;
  if (slice === NO_SLICE) return node.slices.length === 0;
  return node.slices.some((link) => link.id === slice);
}

function mapHeader(map: UiChangeMap, ticks: Record<string, string>): HTMLElement {
  const changed = map.nodes.filter((node) => node.role === "changed");
  const reviewed = changed.filter((node) => ticks[node.id] === node.change?.digest).length;
  const lines = map.files.reduce((sum, file) => sum + file.added + file.removed, 0);
  return h(
    "header",
    { class: "review-header map-header" },
    h(
      "p",
      { class: "hero-meta", title: map.readAt },
      `From ${baseWords(map)} to ${endWords(map)} · read ${relativeTime(map.readAt)}`,
    ),
    h(
      "h2",
      { class: "page-headline" },
      `${plural(changed.length, "changed declaration")} in ${plural(map.files.length, "file")}`,
    ),
    h(
      "p",
      { class: "lead" },
      `${plural(lines, "line")} added or removed. ${reviewed} of ${changed.length} ticked as reviewed in this browser. The map shows where the change is and what VISP recorded about it; it does not judge it.`,
    ),
    graphState(map),
    map.notes.length || cuts(map).length
      ? h(
          "ul",
          { class: "map-notes" },
          [...map.notes, ...cuts(map)].map((note) => h("li", { class: "fine" }, note)),
        )
      : null,
  );
}

function baseWords(map: UiChangeMap): string {
  const commit = map.base.commit ? ` (${map.base.commit.slice(0, 10)})` : "";
  if (map.base.how === "explicit") return `${map.base.ref}${commit}`;
  if (map.base.how === "feature-start") return `the commit before the feature's brief${commit}`;
  if (map.base.how === "empty-tree") return "an empty repository";
  return `HEAD${commit}, since the brief is not committed yet`;
}

function endWords(map: UiChangeMap): string {
  return map.end.how === "feature-end" && map.end.commit
    ? `the last commit that recorded this feature (${map.end.commit.slice(0, 10)})`
    : "the working tree";
}

function graphState(map: UiChangeMap): HTMLElement {
  const words: Record<UiChangeMap["graph"]["state"], [Tone, string]> = {
    current: ["good", "Index current"],
    divergent: ["warn", "Index out of date"],
    unverified: ["warn", "Index not checked"],
    missing: ["warn", "No index"],
  };
  const [tone, word] = words[map.graph.state];
  return h("p", { class: "map-state" }, pill(tone, word));
}

function cuts(map: UiChangeMap): string[] {
  const { omitted } = map;
  return [
    omitted.files
      ? `${plural(omitted.files, "changed file")} past the 200-file limit are not shown.`
      : "",
    omitted.hiddenFiles
      ? `${plural(omitted.hiddenFiles, "changed file")} left out: VISP state, instruction files, secrets or blocked paths.`
      : "",
    omitted.neighbours
      ? `${plural(omitted.neighbours, "caller, callee or test", "callers, callees or tests")} not drawn at the node limit.`
      : "",
  ].filter(Boolean);
}

function readingList(
  feature: UiFeature,
  map: UiChangeMap,
  order: readonly UiMapNode[],
  selected: UiMapNode | undefined,
  view: MapView,
  ticks: Record<string, string>,
  actions: Actions,
): HTMLElement {
  return h(
    "section",
    { "aria-labelledby": "reading-title", class: "reading" },
    h(
      "div",
      { class: "reading-head" },
      h(
        "h2",
        { id: "reading-title", class: "eyebrow list-title" },
        `Reading order · ${order.length}`,
      ),
      sliceFilter(feature.id, map, view, actions),
    ),
    order.length === 0
      ? empty("Nothing in this slice", "No changed declaration is linked to the chosen slice.")
      : h(
          "ol",
          { class: "reading-list" },
          order.map((node) =>
            readingItem(feature.id, node, node.id === selected?.id, ticks, actions),
          ),
        ),
  );
}

function sliceFilter(
  feature: string,
  map: UiChangeMap,
  view: MapView,
  actions: Actions,
): HTMLElement {
  const select = h(
    "select",
    { class: "switcher map-filter", "aria-label": "Show changes for", "data-key": "map-slice" },
    h("option", { value: "", selected: !view.slice }, "All slices"),
    map.slices.map((slice) =>
      h(
        "option",
        { value: slice.id, selected: view.slice === slice.id },
        `${slice.id} · ${slice.goal}`,
      ),
    ),
    h("option", { value: NO_SLICE, selected: view.slice === NO_SLICE }, "Not named by a slice"),
  );
  select.addEventListener("change", () =>
    actions.setMapView(feature, { slice: select.value || undefined }),
  );
  return select;
}

function readingItem(
  feature: string,
  node: UiMapNode,
  isSelected: boolean,
  ticks: Record<string, string>,
  actions: Actions,
): HTMLElement {
  const button = h(
    "button",
    {
      class: `reading-item ${isSelected ? "is-selected" : ""}`,
      type: "button",
      "aria-pressed": isSelected ? "true" : "false",
      "data-key": `map-read:${node.id}`,
    },
    h(
      "span",
      { class: "reading-name" },
      h("span", { class: "strong" }, node.name),
      h("span", { class: "fine" }, ` ${node.kind}`),
    ),
    h("span", { class: "mono fine reading-path" }, place(node)),
    h(
      "span",
      { class: "finding-tags" },
      node.slices.length
        ? [...new Set(node.slices.map((link) => link.id))].map((id) =>
            h("span", { class: "chip" }, id),
          )
        : pill("warn", "No slice"),
      checkMarks(node.checks),
      node.findings.length
        ? pill(
            node.findings.some((f) => f.required) ? "bad" : "neutral",
            plural(node.findings.length, "finding"),
          )
        : null,
      node.untested ? pill("warn", "Untested") : null,
      node.drawn ? null : h("span", { class: "fine" }, "not drawn"),
    ),
  );
  button.addEventListener("click", () => actions.setMapView(feature, { selected: node.id }));
  return h("li", { class: "reading-row" }, reviewTick(feature, node, ticks, actions), button);
}

function reviewTick(
  feature: string,
  node: UiMapNode,
  ticks: Record<string, string>,
  actions: Actions,
): HTMLElement {
  const digest = node.change?.digest ?? "";
  const ticked = ticks[node.id];
  const current = ticked === digest;
  const label = current
    ? `Reviewed: ${node.name}`
    : ticked
      ? `Changed since you ticked it: ${node.name}`
      : `Mark ${node.name} reviewed`;
  const box = h("input", {
    type: "checkbox",
    class: `review-tick ${ticked && !current ? "is-stale" : ""}`,
    checked: current,
    "aria-label": label,
    title: label,
    "data-key": `map-tick:${node.id}`,
  });
  box.addEventListener("change", () => actions.toggleReviewed(feature, node.id, digest));
  return box;
}

function checkMarks(checks: readonly UiMapCheckLink[]): Node[] {
  return checks.map((check) =>
    h(
      "span",
      { class: "map-check", title: checkWords(check) },
      shape(checkShape(check), check.current ? "" : "is-stale"),
      h("span", { class: "mono fine" }, check.id),
    ),
  );
}

function checkShape(check: UiMapCheckLink): string {
  return check.status === "not-run" ? "none" : runShape(check.status);
}

function checkWords(check: UiMapCheckLink): string {
  if (check.status === "not-run") return `${check.id}: not run`;
  const word = executionWord(check.status);
  return `${check.id}: ${check.current ? word : `${word}, out of date`}`;
}

const place = (node: UiMapNode) =>
  node.startLine === undefined
    ? node.path
    : `${node.path}:${node.startLine}${node.endLine && node.endLine !== node.startLine ? `–${node.endLine}` : ""}`;

function graphCard(
  feature: UiFeature,
  map: UiChangeMap,
  selected: UiMapNode | undefined,
  view: MapView,
  ticks: Record<string, string>,
  actions: Actions,
): HTMLElement {
  const open = (module: string) =>
    view.allOpen || view.openModules.includes(module) || selected?.module === module;
  const layout = layoutMap(map.nodes, map.edges, open);
  const toggleAll = h(
    "button",
    { class: "button", type: "button", "data-key": "map-open-all" },
    view.allOpen ? "Collapse modules" : "Open all modules",
  );
  toggleAll.addEventListener("click", () =>
    actions.setMapView(feature.id, { allOpen: !view.allOpen, openModules: [] }),
  );
  return h(
    "section",
    { class: "card map-card", "aria-labelledby": "map-graph-title" },
    cardHead(
      "map-graph-title",
      "Where it changed",
      "Changed declarations, what calls them, what they call and their tests. Solid lines are relations the index resolved; dashed lines are name matches it could not resolve.",
      toggleAll,
    ),
    h("div", { class: "map-scroll" }, drawing(feature.id, layout, selected, view, ticks, actions)),
  );
}

function drawing(
  feature: string,
  layout: ReturnType<typeof layoutMap>,
  selected: UiMapNode | undefined,
  view: MapView,
  ticks: Record<string, string>,
  actions: Actions,
): SVGSVGElement {
  const width = layout.width + 80;
  const svg = svgEl("svg", {
    class: "map-svg",
    viewBox: `-8 0 ${width} ${layout.height + 8}`,
    width,
    height: layout.height + 8,
    role: "group",
    "aria-label": "Change map",
  });
  svg.append(
    svgEl(
      "defs",
      {},
      svgEl(
        "marker",
        {
          id: "map-arrow",
          viewBox: "0 0 10 10",
          refX: 9,
          refY: 5,
          markerWidth: 7,
          markerHeight: 7,
          orient: "auto-start-reverse",
        },
        svgEl("path", { d: "M0 0L10 5L0 10z", class: "map-arrow" }),
      ),
    ),
  );
  for (const column of layout.columns)
    svg.append(svgEl("text", { x: column.x, y: 14, class: "map-column" }, column.title));
  for (const link of layout.links) svg.append(linkPath(link, selected));
  for (const label of layout.labels) svg.append(moduleLabel(feature, label, view, actions));
  for (const box of layout.boxes) svg.append(boxShape(feature, box, selected, ticks, actions));
  return svg;
}

function linkPath(link: LayoutLink, selected: UiMapNode | undefined): SVGGElement {
  const touches =
    selected &&
    link.edges.some((edge) => edge.source === selected.id || edge.target === selected.id);
  const words = link.resolved ? link.kind.replace("_", " ") : "possible call, name match only";
  const group = svgEl(
    "g",
    {
      class: `map-link kind-${link.kind} ${link.resolved ? "is-resolved" : "is-guess"} ${touches ? "is-near" : ""}`,
    },
    svgEl(
      "title",
      {},
      `${words}${link.count > 1 ? ` ×${link.count}` : ""}: ${link.edges
        .map((edge) => edge.at ?? "")
        .filter(Boolean)
        .join(", ")}`,
    ),
    svgEl("path", { d: link.path, "marker-end": "url(#map-arrow)" }),
  );
  if (link.count > 1 || !link.resolved)
    group.append(
      svgEl(
        "text",
        { x: link.labelX, y: link.labelY - 4, class: "map-link-label" },
        link.resolved ? `×${link.count}` : "name match?",
      ),
    );
  return group;
}

function moduleLabel(
  feature: string,
  label: LayoutLabel,
  view: MapView,
  actions: Actions,
): SVGGElement {
  const text = `${label.open ? "▾" : "▸"} ${label.module} · ${label.count}`;
  const group = svgEl(
    "g",
    {
      class: "map-module",
      role: "button",
      tabindex: 0,
      "aria-expanded": label.open ? "true" : "false",
      "aria-label": `${label.open ? "Collapse" : "Open"} ${label.module}, ${plural(label.count, "node")}`,
      "data-key": `map-module:${label.module}:${label.x}`,
    },
    svgEl("text", { x: label.x, y: label.y + 14 }, clip(text, 34)),
  );
  activate(group, () => {
    const openModules = label.open
      ? view.openModules.filter((module) => module !== label.module)
      : [...view.openModules, label.module];
    actions.setMapView(feature, { openModules, allOpen: false });
  });
  return group;
}

function boxShape(
  feature: string,
  box: LayoutBox,
  selected: UiMapNode | undefined,
  ticks: Record<string, string>,
  actions: Actions,
): SVGGElement {
  const node = box.kind === "node" ? box.nodes[0] : undefined;
  return node
    ? nodeBox(feature, box, node, node.id === selected?.id, ticks, actions)
    : moduleBox(feature, box, actions);
}

function nodeBox(
  feature: string,
  box: LayoutBox,
  node: UiMapNode,
  isSelected: boolean,
  ticks: Record<string, string>,
  actions: Actions,
): SVGGElement {
  const reviewed = node.change !== undefined && ticks[node.id] === node.change.digest;
  const title = `${node.name} (${node.kind}) ${place(node)}`;
  const file = node.path.slice(node.path.lastIndexOf("/") + 1);
  const group = boxGroup(
    box,
    `role-${node.role} ${isSelected ? "is-selected" : ""} ${reviewed ? "is-reviewed" : ""}`,
    {
      "aria-pressed": isSelected ? "true" : "false",
      "aria-label": `${title}${reviewed ? ", reviewed" : ""}`,
    },
    title,
    node.name,
    `${node.kind} · ${file}${node.startLine ? `:${node.startLine}` : ""}`,
  );
  const status = nodeTone(node);
  if (status)
    group.insertBefore(
      svgEl("rect", {
        x: box.x,
        y: box.y,
        width: 5,
        height: BOX_HEIGHT,
        rx: 2,
        class: `map-status tone-${status}`,
      }),
      group.querySelector("text"),
    );
  if (reviewed)
    group.append(
      svgEl("text", { x: box.x + BOX_WIDTH - 18, y: box.y + 22, class: "map-box-tick" }, "✓"),
    );
  activate(group, () => actions.setMapView(feature, { selected: node.id }));
  return group;
}

/** A collapsed module: opening it selects its first changed node, which opens the module. */
function moduleBox(feature: string, box: LayoutBox, actions: Actions): SVGGElement {
  const role = box.nodes.some((entry) => entry.role === "changed")
    ? "changed"
    : (box.nodes[0]?.role ?? "caller");
  const count = plural(box.nodes.length, "node");
  const group = boxGroup(
    box,
    `role-${role} is-module`,
    { "aria-label": `Open ${box.module}: ${count}` },
    `${box.module}: ${box.nodes.map((entry) => entry.name).join(", ")}`,
    count,
    box.module,
  );
  activate(group, () => actions.setMapView(feature, { selected: firstChanged(box.nodes)?.id }));
  return group;
}

function boxGroup(
  box: LayoutBox,
  classes: string,
  aria: Record<string, string>,
  title: string,
  name: string,
  sub: string,
): SVGGElement {
  return svgEl(
    "g",
    {
      class: `map-box ${classes}`,
      role: "button",
      tabindex: 0,
      ...aria,
      "data-key": `map-box:${box.key}`,
    },
    svgEl("title", {}, title),
    svgEl("rect", { x: box.x, y: box.y, width: BOX_WIDTH, height: BOX_HEIGHT, rx: 7 }),
    svgEl("text", { x: box.x + 12, y: box.y + 15, class: "map-box-name" }, clip(name, 26)),
    svgEl("text", { x: box.x + 12, y: box.y + 29, class: "map-box-sub" }, clip(sub, 30)),
  );
}

const firstChanged = (nodes: readonly UiMapNode[]) =>
  nodes.find((node) => node.role === "changed") ?? nodes[0];

/** The worst of a changed node's covering checks; a stale run is a warning, never a pass. */
function nodeTone(node: UiMapNode): Tone | undefined {
  if (node.role !== "changed") return undefined;
  if (node.findings.some((finding) => finding.required)) return "bad";
  const tones = node.checks.map((check) =>
    check.status === "not-run" || !check.current ? "warn" : executionTone(check.status),
  );
  if (tones.includes("bad")) return "bad";
  if (tones.includes("warn") || node.untested || !tones.length) return "warn";
  return "good";
}

function nodeDetail(
  feature: UiFeature,
  map: UiChangeMap,
  node: UiMapNode,
  ticks: Record<string, string>,
  actions: Actions,
): HTMLElement {
  const file = map.files.find((entry) => entry.path === node.path);
  return h(
    "section",
    { class: "card map-detail", "aria-labelledby": "map-detail-title" },
    cardHead(
      "map-detail-title",
      node.name,
      `${node.kind} · ${place(node)}`,
      node.change
        ? h(
            "label",
            { class: "tick-label" },
            reviewTick(feature.id, node, ticks, actions),
            "Reviewed",
          )
        : null,
    ),
    h(
      "div",
      { class: "card-body map-detail-body" },
      h("p", null, roleSentence(map, node)),
      node.role === "changed" ? why(feature, map, node) : null,
      warnings(node),
      neighbours(map, node),
      file && node.change ? hunks(file, node) : null,
    ),
  );
}

function roleSentence(map: UiChangeMap, node: UiMapNode): string {
  if (node.change)
    return `Changed: ${plural(node.change.added, "line")} added and ${node.change.removed} removed, in ${plural(node.change.hunks.length, "hunk")}.`;
  const touching = map.edges.filter((edge) => edge.source === node.id || edge.target === node.id);
  const reason =
    node.role === "test"
      ? "a test the index links to a changed file"
      : node.role === "callee"
        ? "the change calls it"
        : node.distance >= 2
          ? "it calls a caller of the change"
          : touching.some((edge) => !edge.resolved)
            ? "an unresolved call in it has the changed name"
            : "it calls the change";
  return `Not changed. Shown because ${reason}.`;
}

function why(feature: UiFeature, map: UiChangeMap, node: UiMapNode): HTMLElement {
  const slices = [...new Set(node.slices.map((link) => link.id))].map((id) => {
    const slice = map.slices.find((entry) => entry.id === id);
    const reasons = node.slices
      .filter((link) => link.id === id)
      .map((link) =>
        link.via === "scope" ? "its scope names this file" : "its checkpoint saw this file change",
      );
    return h(
      "li",
      null,
      h("span", { class: "chip" }, id),
      ` ${slice?.goal ?? ""} `,
      h("span", { class: "fine" }, `(${reasons.join("; ")})`),
    );
  });
  const outcomes = node.outcomes.map((id) => {
    const outcome = feature.outcomes.find((entry) => entry.id === id);
    return h("li", null, h("span", { class: "chip" }, id), ` ${outcome?.statement ?? ""}`);
  });
  return h(
    "div",
    { class: "map-why" },
    h("h3", { class: "eyebrow" }, "Why it changed"),
    slices.length
      ? h("ul", { class: "plain-list" }, slices)
      : h(
          "p",
          { class: "tone-text-warn" },
          "No slice's scope names this file, and no checkpoint saw it change.",
        ),
    outcomes.length ? h("ul", { class: "plain-list" }, outcomes) : null,
    h("h3", { class: "eyebrow" }, "Checks that cover it"),
    node.checks.length
      ? h(
          "ul",
          { class: "plain-list" },
          node.checks.map((check) =>
            h(
              "li",
              null,
              shape(checkShape(check), check.current ? "" : "is-stale"),
              " ",
              check.execution
                ? h(
                    "a",
                    {
                      href: `#/f/${encodeURIComponent(feature.id)}/runs?run=${encodeURIComponent(check.execution)}`,
                    },
                    checkWords(check),
                  )
                : checkWords(check),
              h(
                "span",
                { class: "fine" },
                check.via === "declared"
                  ? " · the check declares this file"
                  : " · runs a test the index links to it",
              ),
            ),
          ),
        )
      : h("p", { class: "fine" }, "No check declares this file or runs a test linked to it."),
    node.findings.length
      ? [
          h("h3", { class: "eyebrow" }, "Open findings that name it"),
          h(
            "ul",
            { class: "plain-list" },
            node.findings.map((finding) =>
              h(
                "li",
                null,
                pill(
                  finding.required ? "bad" : "neutral",
                  finding.required ? "Must fix" : "Optional",
                ),
                " ",
                finding.problem,
                h(
                  "span",
                  { class: "fine" },
                  ` · ${finding.id}, ${finding.via === "names-line" ? "names a line inside it" : finding.via === "names-symbol" ? "names it as a call" : "names its file"} (a text match)`,
                ),
              ),
            ),
          ),
        ]
      : null,
  );
}

function warnings(node: UiMapNode): HTMLElement | null {
  const items = [
    node.untested ? "Changed, and no test in the index or check covers it." : "",
    node.unseenCallers.length
      ? `Possible callers the index could not resolve: ${node.unseenCallers.join("; ")}.`
      : "",
    node.dynamicImports
      ? `Its file loads ${plural(node.dynamicImports, "module")} at run time; relations through them are missing.`
      : "",
    node.indexBehind
      ? "The index is older than this file; its line range and relations may be off."
      : "",
    node.afterCheckpoints ? "Changed again after the last slice checkpoint." : "",
  ].filter(Boolean);
  return items.length
    ? h(
        "div",
        { class: "map-warnings" },
        h("h3", { class: "eyebrow warn" }, "What the map cannot see"),
        h(
          "ul",
          { class: "plain-list" },
          items.map((item) => h("li", null, item)),
        ),
      )
    : null;
}

function neighbours(map: UiChangeMap, node: UiMapNode): HTMLElement | null {
  const byId = new Map(map.nodes.map((entry) => [entry.id, entry]));
  const lines = map.edges
    .filter((edge) => edge.source === node.id || edge.target === node.id)
    .map((edge) => edgeWords(edge, node, byId));
  return lines.length
    ? h(
        "div",
        null,
        h("h3", { class: "eyebrow" }, "Connections"),
        h(
          "ul",
          { class: "plain-list" },
          lines.map((line) => h("li", null, line)),
        ),
      )
    : null;
}

function edgeWords(edge: UiMapEdge, node: UiMapNode, byId: ReadonlyMap<string, UiMapNode>): string {
  const outgoing = edge.source === node.id;
  const other = byId.get(outgoing ? edge.target : edge.source);
  const name = other ? `${other.name} (${other.path})` : outgoing ? edge.target : edge.source;
  const at = edge.at ? ` at ${edge.at}` : "";
  if (edge.kind === "tested_by") return outgoing ? `Tested by ${name}${at}` : `Tests ${name}${at}`;
  if (edge.kind === "possible-call")
    return outgoing
      ? `May call ${name}: ${edge.at ?? ""} (name match only)`
      : `May be called from ${name}: ${edge.at ?? ""} (name match only)`;
  return outgoing ? `Calls ${name}${at}` : `Called by ${name}${at}`;
}

function hunks(file: UiMapFile, node: UiMapNode): HTMLElement {
  const shown = (node.change?.hunks ?? [])
    .map((index) => file.hunks[index])
    .filter((hunk) => hunk !== undefined);
  return h(
    "div",
    { class: "map-hunks" },
    h("h3", { class: "eyebrow" }, `The change · ${file.status} file`),
    file.binary ? h("p", { class: "fine" }, "Binary, or too large to show here.") : null,
    shown.map((hunk) =>
      h(
        "pre",
        { class: "code-block map-hunk" },
        h("span", { class: "line-ctx map-hunk-head" }, hunk.header),
        hunk.lines.map((line) =>
          h(
            "span",
            {
              class: line.startsWith("+")
                ? "line-add"
                : line.startsWith("-")
                  ? "line-del"
                  : "line-ctx",
            },
            line,
          ),
        ),
        hunk.omittedLines
          ? h("span", { class: "line-ctx fine" }, `… ${hunk.omittedLines} more lines not shown`)
          : null,
      ),
    ),
  );
}

const clip = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;

/** Click, Enter and Space all activate an SVG button. */
function activate(element: SVGElement, run: () => void): void {
  element.addEventListener("click", run);
  element.addEventListener("keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    if (key === "Enter" || key === " ") {
      event.preventDefault();
      run();
    }
  });
}

/** SVG elements; like `h`, every string reaches the drawing as a text node. */
function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number | undefined>,
  ...children: (Node | string)[]
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes))
    if (value !== undefined) element.setAttribute(name, String(value));
  for (const child of children)
    element.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  return element;
}
