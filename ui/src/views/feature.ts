import type { UiFeature } from "../../../src/ui/contract.js";
import { h, icon } from "../dom.js";
import { currentStage, describeNext, relativeTime, STAGES } from "../format.js";
import { renderMarkdown } from "../markdown.js";
import type { Actions, AppState, Tab } from "../state.js";
import { activityPanel } from "./activity.js";
import { mapPanel } from "./map.js";
import { nowPanel } from "./now.js";
import { command, disclosure, resource } from "./parts.js";
import { reviewPanel } from "./review.js";
import { runsPanel } from "./runs.js";

export function featurePage(
  state: AppState,
  actions: Actions,
  id: string,
  tab: Tab,
  run: string | undefined,
): Node {
  return resource(state.features[id], "Loading feature", actions, (feature) =>
    h(
      "article",
      { class: "feature", "aria-labelledby": "feature-title" },
      tab === "now" ? hero(feature, state, actions) : compactHeader(feature),
      panel(feature, state, actions, tab, run),
    ),
  );
}

/** The one sentence a person needs first: what the agent is doing, and what it runs next. */
function hero(feature: UiFeature, state: AppState, actions: Actions): HTMLElement {
  const { headline, tone } = describeNext(feature.next);
  const slice = feature.slices.find((entry) => entry.id === feature.next.task);
  const key = `request:${feature.id}`;
  const finished = feature.lifecycle === "accepted" || feature.next.action === "complete";
  return h(
    "section",
    { class: `card hero tone-${tone}`, "aria-labelledby": "feature-title" },
    h(
      "div",
      { class: "hero-top" },
      h(
        "div",
        { class: "hero-main" },
        h(
          "p",
          { class: "hero-meta" },
          h("span", { class: "mono strong" }, feature.id),
          h("span", null, feature.goal),
          slice
            ? [
                h("span", { "aria-hidden": "true" }, "·"),
                h(
                  "span",
                  null,
                  "slice ",
                  h("span", { class: "mono strong" }, slice.id),
                  ` ${slice.goal}`,
                ),
              ]
            : null,
        ),
        h("h1", { id: "feature-title", class: "hero-headline" }, headline),
        h("p", { class: "hero-objective" }, feature.next.objective),
        feature.next.recovery && feature.next.recovery !== feature.next.objective
          ? h("p", { class: "hero-recovery" }, feature.next.recovery)
          : null,
        disclosure(
          key,
          h("span", null, "What you asked for"),
          () =>
            h(
              "blockquote",
              { class: "original-request" },
              feature.originalRequest,
              h("p", { class: "fine" }, "Kept verbatim. VISP never rewrites the original request."),
            ),
          actions,
          state.expanded.has(key),
          "request-disclosure",
        ),
      ),
      h(
        "div",
        { class: "hero-next" },
        feature.next.command && !finished
          ? [
              h("p", { class: "eyebrow" }, "Agent runs next"),
              command(feature.next.command, actions),
              h(
                "p",
                { class: "fine", title: feature.readAt },
                `Read ${relativeTime(feature.readAt)} from visp next. You don't need to run it.`,
              ),
            ]
          : h(
              "p",
              { class: "fine", title: feature.readAt },
              `Read ${relativeTime(feature.readAt)}`,
            ),
      ),
    ),
    stageBar(feature),
  );
}

function stageBar(feature: UiFeature): HTMLElement {
  const { index, detail } = currentStage(feature.next, feature.lifecycle === "accepted");
  return h(
    "ol",
    { class: "stages", "aria-label": "Feature stages" },
    STAGES.map((stage, position) => {
      const progress = position < index ? "done" : position === index ? "current" : "todo";
      return h(
        "li",
        {
          class: `stage stage-${progress}`,
          "aria-current": progress === "current" ? "step" : undefined,
        },
        h("span", { class: "stage-bar", "aria-hidden": "true" }),
        h(
          "span",
          { class: "stage-name" },
          stage,
          progress === "current" && detail ? ` · ${detail}` : "",
          progress === "done" ? h("span", { class: "sr-only" }, " (done)") : null,
        ),
      );
    }),
  );
}

/** Other tabs keep the feature and its state in view without repeating the hero. */
function compactHeader(feature: UiFeature): HTMLElement {
  const { headline, tone } = describeNext(feature.next);
  return h(
    "header",
    { class: "compact-header" },
    h(
      "p",
      { class: "hero-meta" },
      h("span", { class: "mono strong" }, feature.id),
      h("span", { id: "feature-title" }, feature.goal),
    ),
    h(
      "a",
      { class: `now-chip tone-${tone}`, href: `#/f/${encodeURIComponent(feature.id)}/now` },
      h("span", { class: "now-dot", "aria-hidden": "true" }),
      headline,
    ),
  );
}

function panel(
  feature: UiFeature,
  state: AppState,
  actions: Actions,
  tab: Tab,
  run: string | undefined,
): Node {
  if (tab === "review") return reviewPanel(feature, state, actions);
  if (tab === "runs") return runsPanel(feature, state, actions, run);
  if (tab === "activity") return activityPanel(feature, state, actions);
  if (tab === "handoff") return handoffPanel(feature, actions);
  if (tab === "map") return mapPanel(feature, state, actions);
  return nowPanel(feature, state, actions);
}

function handoffPanel(feature: UiFeature, actions: Actions): HTMLElement {
  const copy = h("button", { class: "button", type: "button" }, icon("copy"), "Copy Markdown");
  copy.addEventListener("click", () => actions.copy(feature.report, copy));
  return h(
    "section",
    { class: "card handoff", "aria-label": "Handoff document" },
    h(
      "div",
      { class: "panel-intro" },
      h(
        "p",
        null,
        "The reviewer document, built from recorded evidence. It's what ",
        h("code", null, "visp pr"),
        " prints for the pull request.",
      ),
      copy,
    ),
    renderMarkdown(feature.report),
  );
}
