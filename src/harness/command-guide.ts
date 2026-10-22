/** An illustrative fragment, never inserted into authored intent or saved automatically. */
export const BRIEF_FIELDS_EXAMPLE = {
  outcomes: [{ id: "O001", kind: "functional", statement: "The requested behavior is observable" }],
  slices: [
    {
      id: "T001",
      goal: "Deliver the usable behavior",
      outcomes: ["O001"],
      scope: { allowed: ["src/feature.js"] },
      checks: [],
    },
  ],
};

export const BRIEF_INPUT_HELP = `Edit the existing brief returned by --template; preserve originalRequest, feature and acceptanceBaseline.
Use these field shapes, replacing the illustrative result and file path:
${JSON.stringify(BRIEF_FIELDS_EXAMPLE, null, 2)}
Optional behavior examples use {title, given: [], when, expected: [], outcomes: []}.
Executable checks use --check-template command or --check-template browser.
A command check whose result is an image file (render, chart, SVG) adds \`images: [out.png]\`, a PNG or SVG it writes in every run, and lists an experience outcome naming what the picture must show.
Prefer --patch - --reason "<decision>" for changed fields (arrays merge by ID); use --from - --reason "<decision>" for a full replacement. Status and execution records are generated, not brief inputs.`;

/** One discoverability catalogue for generated host instructions and their examples. */
export const VISP_COMMANDS = [
  {
    command: "next",
    when: "Start or resume",
    example: "visp next",
    next: "Read-only routing: follow the returned action; unresolved is not complete.",
  },
  {
    command: "feature",
    when: "New request",
    example: 'visp feature "<goal>" --check "<test command>" --source-brief -',
    next: 'Pass the request with a quoted heredoc and the host\'s maximum timeout. --check also works all of it as one slice (the visp work --check step). On the lean profile (the default) it returns in seconds: run it in the foreground. Only when visp.yml sets workflow.profile: full or worker: weak does it keep running while VISP writes acceptance tests: on Codex keep its session open and poll it; on a blocking shell (Claude Code Bash) start it with run_in_background:true and read its output for the result. Once it prints, you have the slice (without --check, run visp work --feature <id> --check "<test command>" for one). Never start feature again: a repeat can create a second feature. After a kill or error, run visp work --feature <id>; add --retry-tests only when work reports the acceptance tests failed or stopped. Use brief --template for several usable slices.',
  },
  {
    command: "brief",
    when: "Plan or revise a decision",
    example: "visp brief --template",
    next: "Prefer --patch - for changed fields; keep the first slice to one usable behavior.",
  },
  {
    command: "work",
    when: "Implement a slice",
    example: 'visp work --check "<test command>"',
    next: "Read relevant outcomes/code, then edit only the authorized scope. --inspect reads without authorizing.",
  },
  {
    command: "query",
    when: "An ownership/caller/test question",
    example: 'visp query search "<symbol or behavior>"',
    next: "Use callers, testsFor or impact with the returned entity; inspect source.",
  },
  {
    command: "capture",
    when: "Observe a browser interaction",
    example: "visp capture --task <id> --from -",
    next: "Use act, settle, act again in one journey; inspect images. After repair, --replay <run-id> repeats the original check.",
  },
  {
    command: "critic",
    when: "Only when `visp next` prints a critic command",
    example: "visp critic --preflight",
    next: "Host-delegated review only (with VISP's own reviewer `visp done` runs it). Setup-needed: inspect capabilities; ready: prepare, delegate, submit, or dispatch through an attached adapter.",
  },
  {
    command: "critic feedback",
    when: "Only when `visp next` shows a manual-feedback request",
    example: 'visp critic feedback --ask "What should I improve in this version?"',
    next: "Ask the user with the host's question tool only if it exists and questions are allowed; otherwise `--id <request-id> --defer`. Continue unrelated work.",
  },
  {
    command: "review",
    when: "Only when `visp next` prints a review command",
    example: "visp review --task <id> --prepare",
    next: "Pause edits until it returns. Read packetPath and images; submit with --session <id> --from -.",
  },
  {
    command: "done",
    when: "The slice is usable",
    example: "visp done --task <id>",
    next: 'Run it in the foreground, never with run_in_background or a redirect: it waits for VISP\'s reviewer (about 1-2 min) and prints the result, so there is nothing to poll. A feature that lists requirements takes one --account "R001=<check id> <test name>" per requirement (work prints the full command). Then follow the next step it prints; a handoff or complete ends your loop.',
  },
  {
    command: "accept",
    when: "Next directs final acceptance",
    example: "visp accept --feature <id>",
    next: "Run the final product checks and report accepted status or remaining gaps.",
  },
  {
    command: "pr",
    when: "Only when `visp next` prints it",
    example: "visp pr --feature <id>",
    next: "Prints the evidence record and what is still open for the human reviewer. It reads recorded state; it changes and pushes nothing.",
  },
] as const;

export function commandMap(includeNext = true, includeCritic = includeNext) {
  return [
    includeNext ? "| When | Command | Next |" : "| When | Command |",
    includeNext ? "|---|---|---|" : "|---|---|",
    ...VISP_COMMANDS.filter(
      (entry) => includeCritic || !["critic", "critic feedback", "review"].includes(entry.command),
    ).map((entry) =>
      includeNext
        ? `| ${entry.when} | \`${entry.example}\` | ${entry.next} |`
        : `| ${entry.when} | \`${entry.example}\` |`,
    ),
  ].join("\n");
}

/**
 * The installed guide must not depend on critic settings: readiness compares installed
 * assets with the plan, so a later `visp critic --on` would make it look uninstalled. It
 * leaves out the long reviewer prose, which work/next deliver when it applies, and keeps
 * the short critic rows so those commands stay discoverable.
 */
export function commandGuide(criticEnabled = true, criticCommands = criticEnabled) {
  const guide = `# VISP command guide

The executable is \`visp\`; the package is \`visp-coder\`. Commands accept \`--help\`.

\`visp next\` only reports the next action; it does not record final acceptance. Run \`visp accept\` when that action directs it.

${commandMap(true, criticCommands)}

For a literal request containing backticks, dollar signs or quotes, use a quoted heredoc:

\`\`\`sh
visp feature "<goal>" --check "<test command>" --source-brief - <<'REQUEST'
<verbatim request>
REQUEST
\`\`\`

\`--check\` makes \`feature\` also run \`visp work --check "<test command>"\`, so its reply holds the slice's context and the \`visp done\` to run next. Without it, run \`visp work --check "<test command>"\` after \`feature\`.

A repeat \`visp work\` may pass \`--known <contextId>\` from an earlier reply still in view; that reply's unchanged excerpts are not repeated.

## Understand, build, observe

${BRIEF_INPUT_HELP}

Use \`visp brief --check-template command\` or \`visp brief --check-template browser\` for editable check shapes (MCP: brief with checkTemplate). Replace the example executable or URL/selectors and link only outcomes actually exercised. Descriptive prose belongs in brief examples. Unlinked exploratory checks remain allowed; passing them does not declare coverage.

Keep the template's \`acceptanceBaseline\` unchanged: VISP pins independently supplied acceptance checks there. Put implementation checks in \`checks\`; do not hash the source you intend to change into an acceptance expectation.
Resolve research questions with the host's research tools or a bounded local experiment only when the answer can change implementation. Record the conclusion, evidence and consequence in the existing brief. The retired research/spec/plan/tasks commands are not another workflow. Graph queries answer concrete code questions; an empty graph does not delay a new slice.

Start with one complete behavior through result and recovery. Challenge a slice that includes every level or screen before expanding content. Do not impose arbitrary file or layer counts. Assess functionality, non-functional needs, experience and code quality against the user's request.

## Recovery and legacy features

If \`work\` reports a browser startup or permission gap, recover the host and retry with
\`visp work --retry-environment\`. A startup gap does not prevent scoped implementation. If
the scope check rejects the work, inspect the named changes, restore unintended changes or
revise the intended scope, then retry. Keep sandboxing enabled and never work around a URL policy refusal.

For a legacy feature or current product history needing upgrade, use the installed
\`visp-migrate --project <project> preview\`, then
\`visp-migrate --project <project> apply\`. Preview is read-only; apply preserves a raw backup
in the migration transaction. Stop old writers before applying and restart MCP with the upgraded
executable afterward. \`visp next\` and \`visp status\` only read state; they never migrate it.

For UI work, recover the browser and capture the usable interaction before spending a product critic call. Continue the same build–observe–fix loop when the critic is unavailable.

For a browser capture, pipe YAML/JSON to \`visp capture --task <id> --from -\`:

\`\`\`yaml
url: project:/index.html
viewport: {width: 1280, height: 720}
actions:
  - {kind: click, selector: "#start", capture: true}
  - kind: drag
    selector: "#handle"
    position: {x: 0.5, y: 0.5}
    by: {x: -0.4, y: 0.2}
    captureDuring: true
    captureAfterMs: [300, 900]
  - {kind: wait-for, selector: "#result", visibility: visible, capture: true}
\`\`\`

Waits use \`durationMs\` (1–10000). Follow settling waits with \`wait-for\` or \`compare\` to establish the expected state. Use real controls. \`project:/index.html\` serves a static page (HTML/JS/CSS, no backend) from the project on a port VISP chooses, so start nothing; for an app with a backend or build step, start your server on a free port you choose (not a fixed common one such as 3000, which another process may hold) and use its URL. A drag ends at viewport-pixel \`to\` or, as fractions of the element's box, \`by\`; it starts at \`from\` (pixels) or \`position\` (fractions). \`captureDuring: true\` captures the held state at full pull before release and \`captureAfterMs: [300, 900]\` captures again that many ms after release; \`position\`/\`by\` refuse rotated, skewed, flipped or offset-path elements, so use pixels there. Each journey allows six total captures, including the automatic initial capture, the final capture when the last action does not request one, \`capture: true\`, drag \`captureDuring: true\` and each \`captureAfterMs\` offset. Operation records are generated. Capture and verify return matching before/after observations; investigate possible regressions and execution gaps, and inspect actual images. Work and review handoffs attach a recheck to findings linked to recorded execution: use its command to revisit the original path, then inspect the result and one nearby behavior affected by the edit. A matching rerun is observed-unassessed, not a resolved finding. These comparisons are advisory, not quality approval. Legacy runs without a saved journey still need --from. A different input that succeeds does not resolve an earlier failed input.

## Reviewer execution

Critic is configurable and on by default. The configured model/effort are returned by preflight; never substitute silently. Scheduled review authorizes one bounded delegation where the host allows it. Configured, reserved, invoked, returned and accepted-review are distinct states.

1. Run \`visp critic --preflight\` for product review. Early design advice is optional. If requested, use
   \`--phase understanding --question "<concrete decision>"\` before implementation. An unavailable request
   does not block ordinary work; while it is pending, pause scoped edits until it returns, fails, or expires.
2. Setup-needed means capability information is missing, not that a reviewer was refused. Inspect native delegation/model/tool/image support. Pipe actual host capability JSON using \`--capabilities -\`; do not copy example settings as observed facts. If retaining a report, put it under .visp/; a new file beside product source invalidates prior evidence.
3. With an attached capable host adapter, \`visp critic --dispatch\` inspects and invokes once. Standalone CLI supplies a native handoff; it cannot call the parent agent's tools. Standard MCP sampling cannot preserve the no-token-ceiling setting.
4. For a native handoff use \`visp critic --prepare --capabilities -\`, passing the same feature/task/phase. Delegate a fresh reviewer with returned model/effort and only packet/images; no worker history, custom skills, edits, execution or further delegation. Codex supports a fallback plan only where the host can honor these restrictions. Preparation creates a capability template with null unknown values. Fill only actual observed host metadata, use the generated responseSchemaPath (Codex fallback uses --output-schema), save reviewer JSON unchanged at responsePath, and follow the returned submission.command or literal submission.args; do not reconstruct paths or envelopes. Malformed JSON keeps the raw file and pending reservation; report failure without inventing a review or automatically invoking again.
5. Follow the returned reportUnavailable/failureCommand. For an unreserved early refusal use \`visp critic --phase understanding --failure-kind permission-denied --failure "<reason>"\` with the selected feature/task. For a reserved attempt use \`visp critic --attempt <id> --failure "<reason>"\` with the same selection. Other categories: host-unavailable, model-unavailable, image-unavailable, invocation-failed, schema-rejected, setup-unverified. An unverified setup is not a confirmed refusal. Do not retry a possibly billable pending call automatically. If a reserved call never started, add \`--not-invoked\`; this remains host-reported. When the blocker is resolved, follow the status recovery command with \`--retry-after <failed-attempt> --reason "<what changed>"\` and current capabilities. Use permission already given for the same packet and destination; do not ask again. Preflight is read-only; prepare or attached dispatch creates one fresh attempt within the remaining budget, preserving the failed record. Reuse unchanged evidence instead of repeating worker approvals.

The accepted critic submission records the product assessment; no separate worker approval is required. Follow the next action from done/verify/next. An unavailable early review permits implementation but supplies no quality credit. If the critic cannot run, continue the baseline host review of behavior and images and disclose the missing independent review; do not treat service availability as product quality. Critic --off is only for the user's explicit preference. Existing calls, deadlines and image budgets remain; VISP adds no text/token ceiling.

## Automatic and manual feedback

Default mode is auto (existing behavior). Select \`visp critic --mode auto|manual|both|off\` for an existing feature. For future features use \`visp critic defaults --save --mode both\`, optionally with --harness; project configuration \`critic: { mode: both }\` takes precedence. Legacy enabled/on/off select auto/off. Manual-only needs no reviewer model. Mode switches preserve automatic call history; manual questions consume no model-review calls.

When manual mode is enabled, work/next surface a question opportunity after the first usable observation. An earlier consequential design choice may warrant one focused question. Run \`visp critic feedback --task T001 --ask "Does this interaction match what you wanted?" --context "The preview is open; try dragging and releasing."\`. Attached hosts or MCP form elicitation show the popup; standalone CLI returns a handoff for the coding tool's user-question capability. Show relevant preview/images separately. If no popup exists, ask once in the conversation; never claim a popup was shown.

Record the user's verbatim reply with \`visp critic feedback --task T001 --id <request-id> --reply "<user feedback>"\`, or defer with --defer. Do not fabricate answers. Pending/interrupted requests are preserved and not automatically re-prompted. Continue unrelated work while waiting; defer is not approval. Feedback returns through work/next with its source identity and provenance. Use it to improve the product and observe the result; it does not itself pass checks, resolve an automatic critic, or weaken preserved outcomes. New feedback about a changed direction can be requested explicitly; do not repeatedly ask on every capture.

## Review sessions

When an exploratory journey failed, the prepare response may include host-only recovery drafts with current observation/image IDs. Inspect that counterevidence, fill the diagnosis and actual reviewer context, and submit the draft through its session only if it addresses the original failure. No product approval is implied. Unrelated input, stale evidence and declared-check waivers remain invalid.

\`visp review --prepare\` returns session, packetPath and responsePath under .visp. Read the packet and inspect its actual images. Complete the packet's response schema: summary, outcome assessments with cited evidence, zero to three findings, limitations and any resolutions. No category declarations, example-coverage ledger or identity fields are needed; unknown remains unresolved. Submit that JSON with \`visp review --session <id> --from -\`, or --from responsePath. VISP supplies selection/hashes and links selected before/after images from cited execution IDs; these links establish observation, not quality. Do not create review inputs beside product source or edit generated state. The old --template and stdin interface remains supported. Submission returns a compact recording receipt; --detail returns the full result, neither establishes acceptance.

An outside-session reference requires preparing a session with the relevant --group; it does not prove an image was never viewed. New captures do not invalidate an existing selection. Actual source/contract/environment changes require fresh applicable evidence. Passing commands and delivered images do not establish quality.

Opt in to \`workflow.reviewMode: observation-preview\` in visp.yml to inspect original goals and representative states without worker judgments. Report visible contradictions, locations, consequences, corrections and next checks; zero to three findings, not forced criticism. This preview is unvalidated by live model comparisons. Optional style advice never blocks acceptance.
`;
  return criticEnabled ? guide : (guide.split("## Reviewer execution")[0] ?? guide);
}
