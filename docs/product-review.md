# Product review

This page covers browser journeys, ad hoc capture and review sessions: how VISP observes a running product and how a reviewer's judgments are recorded against that evidence. For the brief and the check gate, see [the workflow guide](workflow.md). For the independent reviewer, see [the critic guide](critic.md).

## Browser journey checks

Put a repeatable journey directly in the brief and list its check ID in the slice's `checks`. `visp done` and `visp verify` execute it and record its operations, measurements and screenshots:

```yaml
checks:
  - id: C002
    command:
      kind: browser-journey
      journey:
        url: http://localhost:3000/
        viewport: { width: 390, height: 844 }
        actions:
          - { kind: click, selector: '#start', capture: true }
          - kind: wait-for
            selector: '#game'
            attribute: { name: data-state, value: playing }
            timeoutMs: 5000
            capture: true
    outcomes: [O001]
    files: [index.html, src/game.js]
    environment: browser
```

Use the application's real selectors, states and files. An HTTP(S) application must already be running. For a static page or game (HTML, JS and CSS, no backend) use the journey url `project:/index.html`: VISP serves the project itself for the journey on a loopback port it chooses and stops the server afterwards, so no server needs to be started. That server answers GET and HEAD only, serves the current project bytes, never serves `.env*`, `.git`, `.visp`, `dist/`, `build/`, `node_modules/`, configured blocked paths, anything behind a symlink or any file with more than one hard link, and refuses requests beyond 20000 per journey or 128 MiB in total. An app that needs a build output or a backend runs its own server on a free port. Journeys run in an installed Chrome/Chromium (`CHROME_BIN`, or `google-chrome` by default) with an isolated profile and the browser sandbox enabled; VISP never downloads a browser or uses your open session.

A `file:///…` URL works when every loaded file is a regular, non-symlinked, single-link file inside the project and outside blocked paths. Workers, popups and downloads are unsupported in this mode; use a local HTTP server for those applications.

Each journey records an initial capture, runs its actions and records the final state. Limits: 60 seconds and six captures per journey, 10 seconds per wait.

## Actions

| Kind | Use |
| --- | --- |
| `click`, `tap` | Activate a control; optional `position: {x, y}` (0–1, relative to the element's border box) |
| `move` | Move the pointer to an element or relative `position` |
| `drag` | `selector`; end at viewport-pixel `to` or at `by: {x, y}` (−1 to 1, fractions of the element's width and height from the start); start at pixel `from` or `position: {x, y}` (0–1 of the border box), default the element centre; `input: pointer\|touch`, `steps`, `durationMs`, `cancel` (touch only); `captureDuring` captures the held state at full pull before release; `captureAfterMs: [300, 900]` (1–3 increasing offsets, 50–2000) captures again that many ms after release |
| `scroll` | Bring an offscreen control into view; optional `block: start\|center\|end\|nearest` |
| `key` | Press a special key or a single letter/digit |
| `resize` | Change the viewport within the same session, keeping application state |
| `wait-for` | Wait for `visibility: visible\|hidden\|absent`, `enabled`, exact `text` or `attribute: {name, value}`; `timeoutMs` up to 10,000 |
| `wait` | Fixed `durationMs` delay (use only when a known deadline matters) |
| `compare` | Read two values in one browser task and check a relation |

Mark an action with `capture: true` when its rendered state matters. Pointer clicks travel natively from the previous position, so aim changes along the way are exercised.

A drag with captures at full pull and after release:

```yaml
url: project:/index.html
viewport: {width: 1280, height: 720}
actions:
  - kind: drag
    selector: canvas
    position: {x: 0.2, y: 0.5}
    by: {x: -0.15, y: 0.1}
    input: pointer
    steps: 12
    durationMs: 300
    captureDuring: true
    captureAfterMs: [300, 900]
  - kind: wait-for
    selector: '[role="status"]'
    text: Launched
    timeoutMs: 5000
    capture: true
```

`position` and `by` are fractions of the element's border box, so the drag follows the element if the layout changes; `from` and `to` are viewport pixels. Use one form per end (`from` or `position`, `to` or `by`). `position` and `by` refuse an element that is rotated, skewed, flipped or moved along an `offset-path`, because fractions of such a box are not the box you see; use pixels there. `captureDuring` records the held state at full pull, before release. Each `captureAfterMs` offset records another capture that many milliseconds after release, for motion that plays out after the input ends. Every one of these counts toward the six captures per journey.

A consistency check between two displays:

```yaml
actions:
  - {kind: wait-for, selector: '#resultCard', visibility: visible}
  - kind: compare
    left: {selector: '#hudScore'}
    right: {selector: '#resultScore'}
    mode: number
    relation: equal
    capture: true
```

`relation` is `equal`, `not-equal`, `less-than` or `greater-than`; ordered relations need `mode: number`. Either side can read an `attribute`; the right side can instead be a fixed `{value: "0"}`. Missing, ambiguous or blank values fail. `compare` does not poll, so use `wait-for` first when the product needs to settle.

Every capture also records bounded layout measurements: canvas scaling, clipping by ancestors, and the size and visibility of controls. They support image review; they do not score design quality.

Every journey is one fresh browser session. To test repeated use, reset or recovery, put the whole lifecycle in one `actions` array.

### Helpers for project tests

The `@visporg/visp-coder/testing` export offers the same building blocks to a project's own test suite: `runBrowserJourney` and `browserJourneySchema`; `activateControl` (real pointer, touch or keyboard input) and `assertControlReachable` (size, visibility, clipping and hit testing) for a page you supply; and `assertRecovery`, `assertFiniteState` and `assertTrajectoryClose` for simulation state. They check that input reaches a control, not that the application handled it; always assert the resulting state.

## Images from command checks

A result that is a picture rather than a page, such as a rendered scene, a chart or a generated image, is judged by looking at it. A command check that writes such a file declares it under `images` (up to four PNG, JPEG, WebP, GIF or SVG paths inside the project, not under `.visp/`):

```yaml
checks:
  - id: C002
    command: [python3, render.py, --out, output/scene.png]
    outcomes: [O002]
    images: [output/scene.png]
```

A check that declares images must cover an `experience` outcome that says how the picture must look, for example that each object, subject and concrete look (named colours, art style or viewpoint) the request names is recognizable in it; the brief is rejected otherwise. Technical outcomes alone (the file is written, the grid has a size) cannot fail on a picture that does not show what was asked for. With images delivered, the reviewer treats an object, subject or concrete look the request names that is missing, hidden, cut off or reads as something else as a departure from the request (a required finding), unlike polish beyond the request, which stays an optional finish finding. A real thing the request asks the picture to depict (a product or model, vehicle, animal, building, landmark) is recognized by its identifying parts and colouring, so the reviewer lists those parts, checks each in the image, and reports missing or unrecognizable ones that make it read as a different thing (or, for a named brand or model, a generic one) as one required finding per thing; a part that is simplified, or left out by a style the request names (a minimalist logo, an icon, a silhouette), stays finish, and colours or a style the request names override the real thing's. The rule covers only what the request names for a picture or screen to show; evaluative words such as modern, clean or polished stay finish, and an ordinary app's controls, forms and data tables are judged as before.

When the check passes, VISP copies each declared image into the feature's captures as an image of the current product version, and the review packet delivers it to the independent reviewer. The check must write each declared image every time it runs: an image that is missing afterwards, or left unchanged from before the run (a file from an earlier run, or an existing product file), fails the check, as does one that is a symbolic link, larger than 4 MiB, more than 8000 pixels on a side (the largest image the model API accepts) or not in one of those formats; the failure names the check and what to change. Only command checks declare images: a browser journey's captures already reach the reviewer, so a journey with `images` is rejected. Declared images are outputs: writing them does not change the product version, so rerunning the check does not make earlier evidence stale. A declared image that existed before the feature started (committed, or uncommitted work the feature started from) stays part of the product, so a check that rewrites it changes the product; the "Product changed while checks ran" gap then says to write the image to a new untracked path and declare that path. A declared SVG is rendered to PNG in a browser, one per check run, in software (without the GPU, whose software fallback on a host without one was too slow): an SVG that does not render fails the check, and one VISP cannot render for want of a browser is an environment failure. An HTML result needs a check that rasterizes it to PNG first.

### Pictures without a declaration

The product's pictures reach the reviewer even when no check declares them. After the checks pass on an unchanged product, VISP captures up to four PNG, JPEG, WebP, GIF or SVG files in the product that were written since the feature started (newest first, each once per product version, and not the declared images above). An SVG is rendered in a browser, since reviewers can view PNG files but not SVG ones: one browser per run, started before VISP takes its state lock, so other VISP commands are not kept waiting. An SVG over 1 MiB and an image over 8000 pixels on a side are skipped, the run's remaining SVGs are skipped once the browser fails, the next hour's runs skip SVGs too unless the browser executable changes, and an SVG that does not render is not tried again until its content changes. These captures never fail a check. When one of these pictures has no image of the reviewed version (it did not render, is too large to deliver, or no check run passed on that version), the review packet names it under `limitations`, so the reviewer says what it cannot assess rather than reading the missing image as nothing to see. Declaring the image on a check remains the reliable way, because it also makes the picture's look an outcome the reviewer can fail.

### Files of another coding host

Untracked instruction and settings files of a coding host other than the configured `harness` (for example `AGENTS.md`, `.codex/` and `.agents/` in a Claude Code project, or `CLAUDE.md` and `.claude/` in a Codex project) are not part of the product: they do not change its version, count against a slice's scope or raise input warnings. Tracked files, the configured host's own files, any file a slice scope or check names (allowed or expected, for a request to write an `AGENTS.md`) or forbids, and any file `workflow.blockedPaths` blocks stay part of the product. Naming means a pattern whose literal part is the file or a directory containing it (`AGENTS.md`, `**/AGENTS.md`, `.codex/**`, `.codex/`); a catch-all such as the `**` scope `visp work --check` writes, or an extension pattern such as `*.md`, names nothing, whether allowed or forbidden. `visp doctor` lists the ignored ones under `other host files` as information; no action is needed.

## Ad hoc capture

For an exploratory observation, pass a journey on stdin:

```sh
visp capture --from - --task T001 <<'YAML'
url: http://localhost:3000/
viewport: { width: 390, height: 844 }
actions:
  - { kind: click, selector: '#start', capture: true }
YAML
```

New ad hoc captures record an agent-proposed exploratory expectation unless they match a declared browser check or you link declared outcomes with `--outcome O001` (MCP `outcomes: ["O001"]`). A failed unlinked expectation is reported once as information and stays in history; it is not required replay work. Declared checks, outcome-linked journeys and independent reviewer-required defects retain their obligations. Legacy receipts without ownership metadata retain their existing semantics.

Retire your own unlinked exploratory hypothesis with `visp capture --retire <run-id> --reason "Ordinary missed aim; winning was only a hypothesis"` (MCP `retire`, `reason`). The one-line reason is recorded separately and shown to the independent reviewer alongside the original failure. Retirement never changes a failed receipt to a pass. A reviewer can still require repair by citing its operation or image evidence in a required finding.

After a repair, `visp capture --replay <run-id>` reruns a recorded journey against the current code and compares observations; a shallower new capture cannot erase a known failure. MCP `visp_capture` accepts the same journey object, or `replay`.

`visp capture --replay-batch <run-id>` (MCP `replayBatch`) replays the canonical saved input plus distinct saved neighbouring transitions on the same route and control targets in one result. It excludes unsupported failed exploratory hypotheses and retired exploratory journeys. Each journey starts fresh, preserves its actions and assertions, and returns its own receipt and status, including failures. No new neighbour is invented; add one explicitly when relevant coverage is missing.

`visp observations --outcome <id>` lists an outcome's captured output, freshness and image paths. MCP `visp_observations` delivers the actual images.

## Failed journeys

A failed journey keeps its completed operations and the last observation: expected state, actual state, elapsed time and diagnostics, plus any partial images. Partial images never count as a successful journey. Uncaught application exceptions are recorded as behavioral failures. A retained failure stays open until the same journey passes on the repaired product; an unrelated successful capture does not clear it.

Browser startup and permission problems are environment failures, not product failures. For slices with browser checks, `visp work` first confirms that an isolated browser can start and capture. If it cannot, implementation may continue inside scope, but browser checks and experience review stay unresolved until the host environment is fixed (install a browser, set `CHROME_BIN`, or grant the host's permission) and `--retry-environment` succeeds.

## Prepare and submit a review

```sh
visp review --prepare --task T001
# Give the packet and its images to the reviewer, then submit its JSON:
visp review --task T001 --session <id> --from -
visp next
```

`--prepare` creates a session under `.visp/features/<id>/review-sessions/` with the original request, relevant source, current images, evidence IDs and a response schema. VISP supplies the subject identity and evidence selection; the reviewer supplies only judgments:

```json
{
  "summary": "The start interaction reaches the playing state; recovery is not yet observed.",
  "assessments": [],
  "findings": [],
  "limitations": ["Recovery needs an observation before acceptance."],
  "resolutions": []
}
```

This example is deliberately unresolved. A real response fills `assessments` with the packet's outcome and expectation IDs, a status (`satisfied`, `failed`, `unclear` or `unavailable`), a reason and cited evidence IDs. `findings` (zero to three) state the problem, its consequence, the next useful check, the affected outcomes and evidence, and whether the correction is required. Optional style suggestions stay advisory.

MCP uses `visp_review` with `prepare: true`, then `session` and `response`. Submission returns a compact receipt; `--detail` (MCP `detail: true`) returns the full bundle. `recorded: true` means the judgments were saved, not that the product was accepted.

Submission revalidates the source, contract, environment and selected image bytes. If the product changed since preparation, prepare a new session. Unknown evidence IDs, images outside the selection and stale evidence are rejected. A returned review that fails validation is reported as rejected and is not retried automatically.

Other review modes:

- `visp review` (no flags) returns the current review bundle; `--group <ids…>` delivers selected image groups (each group keeps one run and viewport together).
- `--handoff` prepares a reviewer context for the host's configured model without starting one.
- `--template` prints editable judgments for the older envelope format, which remains accepted.
- `--dispatch` uses a reviewer adapter attached by an embedding host; the standalone CLI has none and records the gap.

Report `reviewer.context` honestly (`fresh`, `current`, `unavailable` or `unspecified`). These fields are attributed claims, not authenticated independence.

## What satisfies an outcome

- Every mandatory outcome and each of its expectations needs a current assessment before `accept`.
- A satisfied judgment must cite current, successful, related evidence. Failed, stale or unknown executions, and references to the original request, cannot support it.
- An expectation with a `viewport` needs an image captured at that viewport.
- A required experience outcome needs before, input and after images from an executed journey. VISP derives these links from the runner record when the reviewer cites the check's evidence ID. A static picture has no journey: when no browser-journey check covers the outcome and no slice that owns it writes a web page or component (`.html`, `.jsx`, `.tsx`, `.vue`, `.svelte`), a cited current image from a passing check that declares `images` and covers the outcome is enough. A web game still needs its journey; one still frame does not show play.
- Nonvisual outcomes do not need screenshots.

## Resolving findings

Specific findings stay open until addressed with current counterevidence. Submit `resolutions: [{id, explanation, evidence}]` using the packet's open finding IDs; a general approval cannot erase a particular failure.

- `disposition: repaired` (default) needs a fresh successful rerun of the same check or journey. Command checks need declared `verifierFiles`, and the verifier must be unchanged.
- `disposition: disproved` needs a fresh successful execution and an explanation of why the finding was wrong.
- A functional repair also needs `regression`: either `{kind: checked, explanation, evidence}` citing a distinct passing behavior in the finding's scope on the repaired version, or `{kind: not-applicable, explanation}`.

If a known finding lacks sufficient repair evidence, VISP records the rest of the review and leaves that finding open with the reason in `limitations`.

Evidence that VISP lists as unavailable (a core file it could not deliver as text, a rendered image it did not capture) cannot support a judgment. When an assessment, finding, resolution or probe cites it beside evidence VISP delivered, VISP drops the unavailable citation instead of discarding the review, and records `VISP dropped citations of evidence it could not deliver: ...` in the summary (assessments) or `limitations`. A judgment marked `unclear` or `unavailable` keeps its citations, and citations of stale, unknown or ambiguous evidence are never dropped, so a review citing an ambiguous evidence ID is still refused.

For a finding with recorded execution evidence, `work`, critic packets and review sessions include a `recheck` that names the journey or check to rerun and its replay or verify command. A matching later execution is labeled `observed-unassessed` until a reviewer judges it.

A mistaken exploratory expectation (an ad hoc capture that expected the wrong thing) can be resolved inside a review submission:

```yaml
experimentResolutions:
  - runId: <failed exploratory run>
    replacementRunId: <later completed run>
    outcome: <outcome ID>
    reason: The outcome requires the terminal victory state, not an enabled launch button.
    evidence: [<replacement observation ID>, <replacement image ID>]
```

This needs a completed replacement run for the same task with a successful observation and an intact image. Declared check journeys cannot be waived this way: revise the method in the brief and rerun the same declared check.

## Correction budget and visual review

The brief's `design.refinementCycles` (default 2) bounds correction cycles after an initial finding. Cycles count assessed implementation changes after a failure; unavailable reviews, duplicate submissions and metadata edits do not spend them. Exhausting the budget never turns a failure into a pass.

For UI work, `work` schedules a first-render visual checkpoint before content expands. Review the primary activity's scale, composition, contrast and interaction feedback at the actual viewport sizes. Working controls and a consistent theme do not establish visual quality, and an image does not establish unobserved behavior.

`workflow.reviewMode: observation-preview` is an opt-in mode that gives the independent reviewer observation-first guidance and keeps selected intermediate images labeled from recorded operations. The default is `current`.
