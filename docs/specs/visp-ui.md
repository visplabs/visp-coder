# Spec: `visp ui`

Status: 0.1 implemented on `feat/visp-ui`; 0.2 and 0.3 not started · Target: visp-coder 0.6 · Owner: Dineth Keshawa Jayathilaka · Written 2026-09-27

## 1. Summary

`visp ui` starts a local, read-mostly web dashboard for the VISP workflow in the current repository. It shows features, slices, checks, executions, reviews and the requests that are waiting for a person, and updates live as the agent works. From 0.2 it is also where a person makes the decisions VISP reserves for humans, and those decisions carry an SSH signature that the agent cannot produce on its own.

It ships inside the `visp-coder` package (no separate project or package). A thin VS Code extension (§13) reuses the same server and adds editor-native features.

## 0.1 as built

What landed differs from the plan below in these places. The plan is kept as written for 0.2 and 0.3.

| Plan | As built | Why |
| --- | --- | --- |
| Routes `/status`, `/next`, `/features`, `/features/:id/review`, `/pr`, `/activity` | `/meta`, `/overview`, `/features/:id` (one view model carrying outcomes, slices, runs, findings, reviews, questions, activity, captures and the `pr` document), `/features/:id/executions/:id`, `/requests`, `/health`, `/events`, `/ping` | One consistent read per feature; check output stays out of it and loads on demand |
| JSON Schemas generated into `docs/specs/ui-contract/` | Not yet. `src/ui/contract.ts` is imported by the page, so drift fails the build | Deferred; needed before a second client such as the VS Code extension |
| Lease at `.visp/state/ui.json` | `$XDG_RUNTIME_DIR/visp-ui-<uid>/<hash>.json`, mode 0600, holding the token | Keeps the token out of the repository (open question 4) |
| Preact or web components | Plain TypeScript with a small DOM builder, no dependencies | Nothing to install; every string reaches the DOM as text (open question 1) |
| `visp feedback --reply` | `visp critic feedback --reply`, supplied by the server as `replyCommand` and tested against the CLI's registered options | The subcommand lives under `critic` |
| Requests service in `src/workflow/product/` | `src/ui/requests.ts` | Only the dashboard uses it so far; move it when `status` or MCP needs it |

Added later: a Map tab (`/features/:id/map`), specified in [change-map.md](change-map.md).

Also added from use: a pasted fresh link recovers an open tab; unchanged data never re-renders, so focus, typing and scroll survive live updates; passing runs headline their pass count rather than a `fail 0` line; long recorded text is previewed with "Show all".

## 2. Problem

- **No human surface.** VISP is driven by the agent through the CLI and MCP. A person sees state only by running `visp status`, `visp next` or `visp pr` and reading text. Nothing tells them when the agent is waiting on them.
- **Human input is unauthenticated.** Every human-reserved input is recorded as a claim:
  - An intent change records "Origin of the intent-change decision; not proof of human identity" (`src/cli/commands/product.ts`).
  - `visp critic feedback --reply` records "the user's verbatim feedback; never an actor-written answer", but nothing distinguishes an actor-written reply.
  - Internals: "local hashes identify content without authenticating who produced it."
- **Evidence is hard to inspect.** Check output, screenshots under `captures/`, reviewer activity and stale-evidence reasons live in separate files and JSON envelopes.

## 3. Goals and non-goals

### Goals

1. Show the current VISP state of one repository, live, without the person running commands.
2. Make every value traceable to the service and file it came from.
3. Surface every request that needs a person, in one inbox.
4. From 0.2, let a person record human-reserved decisions with a signature VISP verifies.
5. Add no new source of truth: the UI renders what the workflow services return and computes no verdicts.

### Non-goals

- Showing the agent's transcript or progress. Claude Code, Codex and the IDE hosts already do that.
- Driving the agent (starting features, editing briefs, authorizing slices, running `done`). Those stay with the agent through CLI/MCP.
- Remote or multi-user access. Loopback only.
- A hosted service, accounts, telemetry, or any network request beyond loopback.
- A standalone desktop app.

## 4. Users and journeys

The primary user is a developer running a coding agent under VISP in one or more local repositories.

| ID | Journey | Version |
| --- | --- | --- |
| J1 | Run `visp ui`, see the active feature: outcomes, slice progress, the next action and what it is waiting on. | 0.1 |
| J2 | Open a failed check and read its command, output, exit code, environment identity and whether the result is stale. | 0.1 |
| J3 | Read the critic's open findings with the evidence each cites (execution, screenshot, file and line). | 0.1 |
| J4 | Get a browser notification when the agent asks a question (`visp critic feedback --ask`), hands off, or acceptance is ready. | 0.1 |
| J5 | Preview the `visp pr` document before the agent opens the pull request. | 0.1 |
| J6 | Answer a pending feedback request; the reply is recorded as signed human input. | 0.2 |
| J7 | Approve or refuse an intent change, a scope widening or an override, with a signature. | 0.2 |
| J8 | Dispute or accept a critic finding with a signed reason. | 0.2 |
| J9 | Sign off acceptance so that the feature is not accepted on AI review alone. | 0.2 |
| J10 | See all registered repositories and which ones are waiting on a person. | 0.3 |
| J11 | In VS Code, see findings in the Problems panel and authorized scope in the explorer. | 0.3 |

## 5. Versions

- **0.1, read-only.** `visp ui` for one repository. Journeys J1–J5. No write endpoints.
- **0.2, signed decisions.** `visp decide` (CLI) and `POST /api/v1/decisions`. Journeys J6–J9. The `decisions.requireSignature` config option.
- **0.3, reach.** A multi-repository view (J10) and the VS Code extension (J11). Probe results (if Probe ships) appear as a findings source.

## 6. Architecture

```
visp ui ──> src/ui/server.ts (node:http, loopback)
              ├── GET  /api/v1/*        ──> workflow services (same as CLI and MCP) ──> Envelope<T>
              ├── GET  /api/v1/events   ──> SSE; fed by src/ui/watcher.ts on .visp/
              ├── GET  /captures/*      ──> symlink-safe file serving from features/<id>/captures/
              ├── POST /api/v1/decisions (0.2) ──> decision service ──> signature verify ──> state transaction
              └── GET  /*               ──> static assets from dist/ui/
```

- **One process, same services.** The server calls the workflow services the CLI and MCP call. It never shells out to `visp`, and it never reads `.visp/` files to derive state. Responses use the existing `Envelope<T>` from `src/cli/output.ts`, so `--json`, MCP and the UI share one contract.
- **The UI computes nothing.** Status, staleness, "next action" and every verdict come from the services. The front-end only formats.
- **Locking.** Reads use the non-mutating `workspace()` path and never take `.visp/state/mutation.lock`. A read that returns `STATE_BUSY` is shown as "a writer is active", not as an error or empty state. Decisions (0.2) take the lock through the normal mutating path.
- **Build identity.** `/api/v1/meta` reports package version, build ID and the installed build (from doctor). A mismatch shows a banner with `visp install` as the copyable fix. Decisions are refused on mismatch, as other product mutations are.

### Repository layout

| Path | Contents |
| --- | --- |
| `src/ui/server.ts` | HTTP server, routing, security middleware |
| `src/ui/routes/*.ts` | One module per resource; each maps to a workflow service |
| `src/ui/watcher.ts`, `src/ui/sse.ts` | Change detection and the event stream |
| `src/ui/security.ts`, `src/ui/path-security.ts` | Token, Host/Origin checks, CSP, safe file reads |
| `src/ui/contract.ts` | Versioned resource types (`UI_CONTRACT_VERSION`) |
| `src/cli/commands/ui.ts` | The `visp ui` command |
| `ui/` | Front-end source, built into `dist/ui/` and included in the npm package |
| `extensions/vscode/` | VS Code extension (0.3), a second pnpm workspace package |

## 7. Command: `visp ui`

```
visp ui [--port <n>] [--no-open] [--feature <id>] [--json]
```

- Binds `127.0.0.1`. The default port is random; `--port` pins it.
- Generates a per-launch token and prints the URL `http://127.0.0.1:<port>/#t=<token>`. The token is in the URL fragment, so it never reaches the server's logs or the `Referer` header. The page exchanges it for an `HttpOnly`, `SameSite=Strict` cookie on first load.
- Opens the default browser unless `--no-open`.
- `--json` prints one envelope `{command: "ui", ok: true, data: {url, port, pid, buildId, contractVersion}}` and keeps running. The VS Code extension uses this.
- Runs until interrupted. Writes nothing to the repository and nothing under `.visp/`, except a lease file `.visp/state/ui.json` (`pid`, `port`, `buildId`, no token) so that a second `visp ui` reuses the running server instead of starting another.
- Refuses to start outside a VISP-initialized repository, with `visp init` as the recovery.

## 8. HTTP API (contract v1)

All responses are `Envelope<T>`. All `GET` routes are side-effect free.

| Route | Service | Data |
| --- | --- | --- |
| `GET /api/v1/meta` | doctor / build identity | version, build ID, installed build, contract version, repository root, active rules |
| `GET /api/v1/status` | status | Same data as `visp status --json` |
| `GET /api/v1/next` | next (non-waiting variant) | Same data as `visp next --json`, without the 120-second review wait |
| `GET /api/v1/features` | feature list | id, goal, branch, state, updated time |
| `GET /api/v1/features/:id` | brief + product state | brief, outcomes with status, slices with scope and checks |
| `GET /api/v1/features/:id/executions` | evidence | execution records, newest first, with stale reasons |
| `GET /api/v1/executions/:id` | evidence | full record, including output (truncated at 1 MB, with a byte count) |
| `GET /api/v1/features/:id/review` | review | open and closed findings, attribution, cited evidence |
| `GET /api/v1/features/:id/pr` | pr | the Markdown document from `visp pr` |
| `GET /api/v1/features/:id/activity` | activity logs | reviewer web searches, tester networked commands |
| `GET /api/v1/requests` | inbox (new) | pending human requests; see §9 |
| `GET /api/v1/doctor` | doctor | installation health, lock owners |
| `GET /api/v1/events` | SSE | `{resource, feature?, revision}` change events and a heartbeat every 15 s |
| `GET /captures/:feature/*` | static | screenshots and journey artifacts |
| `POST /api/v1/decisions` | decisions (0.2) | see §10 |

- **Contract versioning.** `UI_CONTRACT_VERSION` starts at `1`. Adding a field is compatible; removing or renaming one needs a new version. The front-end and extension send `Accept-Contract: 1` and the server refuses a version it does not serve.
- **Schemas.** JSON Schemas are generated from `src/ui/contract.ts` and checked in under `docs/specs/ui-contract/`. A test fails if they drift from the types.
- **No hidden waits.** The `next` route never blocks on a running review. It returns `action: wait` immediately, and an SSE event announces the review result.

## 9. The requests inbox

A request is anything that needs a person. The inbox is derived by a new service (`src/workflow/product/requests.ts`) that other surfaces (`visp status`, MCP) can reuse.

| Kind | Source | Resolved by |
| --- | --- | --- |
| `feedback` | a pending `visp critic feedback --ask` request | a reply or defer (0.2 in the UI; the CLI works today) |
| `handoff` | `completion: handoff` from `next` (review budget spent with findings open) | a person reading `visp pr`; informational |
| `acceptance` | a feature whose checks and assessments pass, waiting on `accept` | human sign-off (0.2) |
| `intent-change` | a brief update that changed protected intent | approve or refuse (0.2) |
| `scope-widening` | a brief update that widened a slice's `scope.allowed` after authorization | approve or refuse (0.2) |
| `override` | a proposed override in `overrides.json` | approve or refuse (0.2) |
| `environment` | an `environment-failed` execution that needs the host fixed | informational, with the rerun command |

In 0.1 every request is displayed with its source and a copyable CLI command. Nothing in 0.1 resolves a request from the UI.

## 10. Signed decisions (0.2)

### 10.1 Decision record

A decision is a canonical-JSON payload signed with `ssh-keygen -Y sign -n visp-decision@v1`:

```json
{
  "v": 1,
  "kind": "approve-intent-change",
  "repository": "<repository identity>",
  "feature": "F003",
  "target": "<request id>",
  "subject": { "briefHash": "<sha256>", "evidenceRevision": "<n>" },
  "decision": "approve",
  "reason": "<free text>",
  "nonce": "<128-bit random>",
  "createdAt": "2026-09-27T10:00:00Z"
}
```

- **Kinds:** `feedback-reply`, `feedback-defer`, `approve-intent-change`, `refuse-intent-change`, `approve-scope-widening`, `refuse-scope-widening`, `approve-override`, `refuse-override`, `dispute-finding`, `accept-finding`, `sign-off-acceptance`.
- **Binding.** The subject hashes bind a decision to the state the person saw. If the brief or evidence has changed since, the decision is refused as stale and the UI reloads.
- **Replay.** Nonces are recorded in the feature's decision history; a reused nonce is refused.
- **Canonical JSON.** This needs strict canonicalization: reject `NaN`, `Infinity`, non-plain objects, cycles and sparse arrays, and domain-separate the hash. Port Kit's `src/integration/canonical-json.ts`. The current `src/core/hash.ts` hashes a `Date` or `Map` as `{}`, which is not acceptable for signed payloads.
- **Storage.** Append-only under `.visp/features/<id>/decisions/`, with a projection in product state, written in a normal state transaction.

### 10.2 Signers

- **Allowed signers** are listed in `visp.yml` under `decisions.signers` (OpenSSH `allowed_signers` lines). The list is committed, so adding a signer shows in the pull request diff.
- **Verification.** `ssh-keygen -Y verify` against that list, with the namespace. CI (`visp guard --scope tasks`) re-verifies every decision in the committed feature.
- **Changing the list** is itself shown in `visp pr` under a "Signer changes" heading.
- **`decisions.requireSignature`** (default `false` in 0.2, reconsidered for 1.0). When `true`, the human-reserved transitions in §10.1 refuse unsigned input, and `accept` requires a `sign-off-acceptance` decision. When `false`, unsigned input keeps working and is labelled "claimed, not signed" everywhere it appears, including `visp pr`.

### 10.3 Who signs

- The server signs by calling `ssh-keygen -Y sign` with a key held in `ssh-agent`. The browser never sees a key.
- **The key must require a human act per signature:** a key added with `ssh-add -c` (the agent shows a confirmation dialog) or a FIDO key (`ed25519-sk`, touch required). `visp doctor` warns when a configured signer key is in the agent without confirmation. VISP cannot prove this; it is documented as the operator's responsibility.
- **`visp decide`** is the CLI equivalent (`visp decide --request <id> --approve|--refuse --reason "…"`). It uses the same service and the same signing path, for people who prefer the terminal.

### 10.4 Threat model (to be red-teamed; see §15)

The agent runs as the same OS user as the person. Assume it can read and write any file the user can, read the process list, call the loopback server, and run `visp`.

| Attack | Mitigation | Residual risk |
| --- | --- | --- |
| The agent writes a decision file directly | Unsigned or badly signed decisions are rejected; with `requireSignature`, unsigned input cannot complete a transition | none beyond the signing cases below |
| The agent adds its own key to `decisions.signers` | The change appears in the PR diff, under "Signer changes" in `visp pr`, and is verified in CI against the committed list | A person who merges without reading the diff |
| The agent calls `POST /decisions` or `visp decide` | Signing needs a human act (confirmation dialog or key touch) | The person confirms a prompt they did not initiate. The dialog does not show the payload, so the UI shows a short code for the pending decision and the docs tell people to confirm only right after clicking. |
| The agent edits `.visp/` policy, overrides or briefs to route around decisions | The scope guard must stop exempting trust-bearing files under `.visp/` (prerequisite, §14) | Until that fix lands, 0.2 must not ship |
| A malicious web page calls the loopback server (CSRF, DNS rebinding) | §11 controls; decisions still need a signature | none beyond signing |
| A stolen or replayed decision | Subject binding, nonce history, namespace | none |

## 11. Security

- **Loopback only.** Bind `127.0.0.1`. Refuse to bind anything else, including with a flag.
- **Token.** Per launch, 256 bits, delivered in the URL fragment and exchanged for an `HttpOnly`, `SameSite=Strict` cookie. Every API and SSE request needs it. It is never written to disk.
- **Host header allowlist:** `127.0.0.1:<port>` and `localhost:<port>` only (DNS rebinding).
- **Origin check** on every non-`GET` request. No CORS headers.
- **CSP:** `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'`, with the addition the VS Code webview needs (§13). No inline scripts, no `eval`.
- **File serving.** Only from `features/<id>/captures/`, via a resolver that rejects `..`, absolute paths and symlinks, opens with `O_NOFOLLOW`, and rechecks device and inode after opening (port Hyper's `src/cockpit/path-security.ts` and Intel's `src/security/safe-walker.ts`). `Content-Type` comes from an allowlist of image and text types, with `X-Content-Type-Options: nosniff`.
- **Output rendering.** Check output and reviewer text are rendered as text, never as HTML. Markdown (`pr`) goes through a sanitizer with raw HTML disabled.
- **No execution from the UI.** 0.1 runs nothing. 0.2 runs only the signing step. Commands are shown to copy, never run.

## 12. Front-end

### 12.1 Screens

| Screen | Contents |
| --- | --- |
| **Overview** | Active feature, next action, request count, build and health banner |
| **Feature** | Original request (verbatim), outcomes with status and evidence, slices as feature → brief → work → done → review → accept → pr, scope per slice |
| **Checks** | Executions by slice and check; pass, fail, environment-failed or stale; output viewer; verifier and environment identity; the stale reason |
| **Review** | Findings (open first) with attribution, cited executions, screenshots and file:line; review budget used |
| **Requests** | The inbox (§9). 0.2 adds decision controls. |
| **PR** | Rendered `visp pr` document |
| **Health** | Doctor output, lock owners, build identity, active policy rules |

### 12.2 Data display rules

These come from Hyper's ADR 0004 (`code_automation_llm/visp-hyper-agent/docs/adr/0004-cockpit-read-only-local-surface.md`).

- Every resource has an explicit state: `present`, `missing`, `stale`, `corrupt`, `busy` or `unavailable`. Missing, stale or corrupt data is never shown as empty or as success.
- Every value can show its source: the service and the underlying file path.
- A claimed value (unsigned `--by`, actor-supplied text) is visibly labelled as claimed.
- Commands are copyable and never executed.
- The policy rules list shows only rules that are enforced. This depends on the policy-rules cleanup (§14).

### 12.3 Technology

- TypeScript, bundled by esbuild (already used by `tsup`) into `dist/ui/`. One small view library (Preact or plain web components; decide in M1). No CSS framework.
- No network requests except to the loopback server. Fonts self-hosted: reuse the Fira subsets from `visp-labs/assets/fonts/`.
- Visual design follows `code_automation_llm/visp-cockpit/design/visp-cockpit.dc.html` for layout and component states, recoloured to Visp Code's blue (`--code` token in `visp-labs/styles.css`). Light and dark themes follow the system.
- Keyboard navigable, visible focus, WCAG 2.2 AA contrast, usable from 900 px wide (narrower is not a goal for 0.1).
- Live updates: an `EventSource` on `/api/v1/events`. A change event re-fetches only the named resource. On disconnect, show "live updates paused", retry with backoff (1 s doubling to 30 s) and poll the open feature every 10 s until the stream is back. While the stream is open, re-read the open feature every 30 s and 1 s after each change event, because the stream does not see edits to product files; never show old data as current.

## 13. VS Code extension (0.3)

- **Package.** `extensions/vscode/`, a second pnpm workspace package, released as a `.vsix` on its own schedule. It depends on the contract types, not on runtime code.
- **Discovery.** It finds `visp` on `PATH` or the project's `node_modules`, checks the build ID against the installed one, then attaches to a running server via `.visp/state/ui.json` or starts `visp ui --no-open --json`.
- **Webview.** It embeds the same UI via `asExternalUri` for the loopback URL. It adds no screens of its own.
- **Editor-native features (the reason the extension exists):**
  - Open critic findings become diagnostics in the Problems panel at their file and line.
  - The explorer marks files in the authorized scope and warns on out-of-scope edits.
  - A status bar item shows the active slice and the request count.
  - A notification appears for new requests, with "Open in Visp" as the action.
  - "Open diff at finding" opens the file at the cited line.
- **Hosts.** VS Code, Cursor and Windsurf (engines `^1.96.0`, matching Visp Code Note). Reuse Visp Code Note's build and test setup (esbuild, `@vscode/test-electron`).

## 14. Prerequisites in visp-coder

| Item | Needed for | Status |
| --- | --- | --- |
| The scope guard stops exempting trust-bearing files under `.visp/` (`src/orchestrate/guard.ts:52`) | 0.2 | task suggested, not started |
| The policy rules are either enforced or removed (25 of 26 are displayed but unenforced) | 0.1 Health screen | task suggested, not started |
| Strict canonical JSON (port Kit `src/integration/canonical-json.ts`) | 0.2 | not started |
| A non-waiting variant of the `next` service | 0.1 | not started |
| A requests service (§9) | 0.1 | not started |
| Hardened `git` calls (hooks and fsmonitor off, global config ignored; see Intel `src/adapters/git-history.ts`) | recommended before any server that reads git state | not started |

## 15. Build plan and model allocation

The feature is built under VISP itself (dogfooding). Each milestone is a VISP feature with its own brief, checks and review.

| Milestone | Work | Astra (gpt-6-astra) | Sol (gpt-6-sol) |
| --- | --- | --- | --- |
| M0 | Prerequisites (§14) | Review the guard redesign | Implement the fixes with tests |
| M1 | Contract and server | Design the contract types and route map; review the security middleware | Server, routes, SSE, watcher, lease file, `visp ui` command, schema generation, contract tests |
| M2 | Front-end 0.1 | Review data-state handling against §12.2 | Screens, live updates, themes, accessibility, Playwright tests |
| M3 | Requests inbox | Define request derivation rules | Requests service, inbox screen, `status` and MCP exposure |
| M4 | Signed decisions 0.2 | Threat model; red-team (try to approve as the agent) | Decision service, `visp decide`, signing and verification, CI verification, `visp pr` sections |
| M5 | VS Code extension 0.3 | Review the webview CSP and discovery | Extension, diagnostics, decorations, tests |
| M6 | Multi-repository view 0.3 | none | Registry at `~/.config/visp/projects.json`, overview across repositories |

## 16. Testing and acceptance

### Tests

- **Contract:** every route's `data` validates against its checked-in schema; schemas match `src/ui/contract.ts`.
- **Security:** a wrong or missing token, a wrong `Host`, a wrong `Origin` on `POST`, `..` and absolute paths, a symlink planted under `captures/`, a file swapped between open and read, and HTML in check output are each refused or escaped.
- **State fixtures from real runs.** Fixtures are produced by running `visp` commands in temporary repositories, not written by hand (Cockpit's hand-written fixtures could not survive a state-format change). Cover each resource state in §12.2.
- **Live update:** a state change made through the CLI appears in an open page within 500 ms.
- **Decisions (0.2):** a valid signature is accepted; unsigned (with `requireSignature`), a wrong namespace, an unlisted key, a stale subject and a reused nonce are each refused; CI re-verification fails on a tampered decision.
- **Extension (0.3):** `@vscode/test-electron` tests that findings appear as diagnostics and that a build mismatch is reported.

### Acceptance criteria for 0.1

1. `visp ui` in a repository with an active feature opens a page showing the feature's outcomes, slices, checks, findings and next action, matching `visp status --json` and `visp next --json` field for field.
2. When the agent runs `visp done`, the page updates without a reload.
3. A pending `visp critic feedback --ask` request appears in the inbox and triggers a browser notification.
4. Stopping the agent mid-write (`STATE_BUSY`) shows "a writer is active", never an empty feature.
5. The page makes no request to any host other than the loopback server.
6. First render is under 1 s for a feature with 20 slices and 200 executions on a mid-range laptop.
7. All security tests in §16 pass.

### Measured against items 2 and 6 (11 October 2026): met on a laptop, not on a small VM

`tests/integration/ui/large-demo.test.ts` seeds a feature with 20 slices through the workflow services: 200 real `node --test` executions with trail compaction held off, or the 110 that VISP keeps with `VISP_UI_LARGE_COMPACT=1`. `bench/ui/bench-ui.mjs` times the page in headless Chrome: cold HTTP cache, signed in, 7 trials. Medians, with the slowest trial in brackets (with 7 trials a p90 is close to the slowest):

| Measure | Laptop, 110 executions | Laptop, 200 executions | VM, 110 | VM, 200 | Target |
| --- | --- | --- | --- | --- | --- |
| First render, Now (all 20 slices and every run mark painted) | 575 ms (590) | 624 ms (646) | 980 ms (1,056) | 1,085 ms (1,106) | < 1 s |
| First render, Runs (every run row) | 530 ms (568) | 614 ms (734) | 1,129 ms (1,219) | 1,191 ms (1,309) | < 1 s |
| Same, Now, at 4× CPU throttling | 843 ms (847) | 954 ms (967) | 1,912 ms | 2,255 ms | — |
| `visp brief --patch` to the decision on the open page | 387 ms (414) | — | not re-measured | — | 500 ms |
| Same, at 4× CPU throttling | 487 ms (548) | — | — | — | — |
| `visp verify` to its new run mark on the open page | 289 ms (370) | — | not re-measured | — | 500 ms |
| Same, at 4× CPU throttling | 411 ms (893) | — | — | — | — |

Laptop: AMD Ryzen 9 5900HS (8 cores), Chrome 155, playwright-core 1.63. VM: 4 vCPU Xeon at 2.8 GHz, idle, measured on 10 October with an earlier version of the script. Live times run from the last write under `.visp/`; in every trial the change showed well before the 10-second refresh. Notes:

- **The VM live times are withdrawn.** The earlier script ran each CLI command synchronously, which stalled its own event handling, and its page watcher scanned the whole document on every mutation while timing the re-render. Its VM figures (1,184 ms for `brief`, 1,290 ms for `verify`) are not comparable and were not re-measured. Its VM first-render figures used the same measurement as now, but the bracketed values were the slowest trial, not a p90.
- **A feature rarely holds 200 executions.** The trail keeps the newest 100 plus those reviews cite and the latest of each check (`trail.ts`), so the seed settles at 110.
- **The watcher is fast.** The `change` event that names the feature reaches the page about 150 ms after the first write under `.visp/`, for `verify` as well as `brief` (median 147 ms and 151 ms). The earlier note that `verify`'s event comes 600 ms after the first write was an artifact of the synchronous command. The page then re-fetches the feature, which takes most of the remaining time.
- **The cost is parsing, not the number of runs.** Profiled on the VM: alone, `/api/v1/features/<id>` takes about 200 ms, `/api/v1/requests` 250 ms and `/api/v1/overview` 60 ms; page load issues them together on the server's one thread. Reading the product record took 522 ms of the requests' time: 399 ms parsing `brief.yaml` (12 KB, about 11 ms per parse, roughly three parses per request) and about 170 ms schema validation. Hashing the product source took 97 ms and git subprocesses about 200 ms. On the laptop the feature request alone takes about 425 ms at 110 executions and 480 ms at 200, so the same parsing cost is what keeps a slower machine from the target.

## 17. Reuse map

| Source | What to reuse |
| --- | --- |
| `visp-hyper-agent/src/cockpit/{server,sse,watcher,security,path-security}.ts` | Loopback server, token, Host checks, CSP, SSE, watcher, safe reads (about 1,640 lines, with about 4,700 lines of tests) |
| `visp-hyper-agent/docs/adr/0004-cockpit-read-only-local-surface.md` | Data display rules |
| `visp-cockpit/design/visp-cockpit.dc.html` | Layout, component states, palette structure |
| `visp-kit/src/integration/canonical-json.ts` | Strict canonical JSON |
| `visp-kit/src/review/review-decision-signature.ts` | SSH signing and verification (add an allowed-signers list; Kit used `check-novalidate`) |
| `visp-intel/src/security/safe-walker.ts`, `src/adapters/git-history.ts` | `O_NOFOLLOW` reads, hardened git calls |
| `visp-notes-vscode-design-package/` | Extension build and test setup |
| `visp-labs/assets/fonts/`, `styles.css` | Fonts, the Visp Code colour token |

Paths outside visp-coder are relative to `/home/dinethj/Documents/projects/code_automation_llm/` or `/home/dinethj/Documents/projects/`. The Kit, Hyper, Intel and Cockpit repositories are being sunset, so port code and tests before they are archived.

## 18. Open questions

1. **View library:** Preact or plain web components? Decide in M1 by bundle size and test ergonomics.
2. **`requireSignature` default:** should it become `true` in 1.0, making AI-only acceptance impossible by default?
3. **Signer UX on macOS and Windows:** `ssh-add -c` needs an askpass program. Is FIDO the recommended path there?
4. **Lease file:** should `.visp/state/ui.json` move under the user's runtime directory, so it never appears in the repository's `.visp/`?
5. **Multi-repository view:** one user-level server for all repositories, or one server per repository with a shared overview page?
6. **Probe results:** should they flow through the review service as findings, or through their own resource?
