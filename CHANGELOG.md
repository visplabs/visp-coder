# Changelog

## Unreleased

### Fixed
- **The tester's browser kit calls a function written as a string, and `waitFor` passes arguments.** In five slingshot-game benchmark runs the pinned suite failed because of the kit, not the game: `page.evaluate("() => window.gameTest.snapshot()")` and `page.evaluate(fn.toString(), ...args)` returned the function itself (an empty object) instead of calling it, and `page.waitFor((l) => ..., options, level)` dropped `level`. `evaluate` now calls a string whose value is a function with the given arguments, and refuses arguments with any other string. `waitFor(fn, options, ...args)` passes them on, rejects a second argument that is not an options object, and its timeout names the last error from the page; a page function that reads a Node variable gets a note to pass it as an argument. Expression and statement strings behave as before. With only the kit replaced, three of those runs' pinned suites go from 15, 13 and 2 failing tests to none on the same products. The tester's kit API lines say how arguments reach page code.
- **A suite broken by one defect reaches a review.** When one broken helper turned 14 to 16 pinned tests red (three benchmark runs), VISP accepted five disputes and refused the rest, and the reviewer, which launches only when every failing test is disputed, never ran: the runs ended with no review. Up to 30 disputes (the tester's test guidance) may now await a ruling, so one call can dispute them all and one review rules on all of them; a reason or failure output shared with an earlier dispute reaches the reviewer once. Past 30, the refusal tells the worker to report the disagreement and run `visp pr`.

## 0.5.0-beta.4 - 2026-10-15

### Security
- The MCP SDK is now 1.32.1 (from 1.30.0) and its server dependencies are on patched versions: `proxy-addr` 2.0.8, `fast-uri` 3.1.8, `hono` 4.13.13, `ip-address` 10.7.4 and `qs` 6.16.0. These close published advisories, including an OAuth client that could send credentials to an authorization server the MCP server chose, IP spoofing through IPv4-mapped IPv6 trust subnets, and several denial-of-service and parsing issues. VISP's MCP tools and their schemas are unchanged.

### Added
- **A command check can hand the reviewer a picture** (`images: [path.png]`, up to four PNG, JPEG, WebP, GIF or SVG files inside the project; VISP renders an SVG to PNG in a browser, failing the check if it does not render and reporting an environment failure if no browser runs). In an isometric voxel-scene benchmark neither review saw the picture, because only browser journeys produced review images: both said no images were supplied and judged the scene from source. When the check passes, VISP copies each declared image into the feature's captures as an image of the product version the check ran against, and the review packet delivers it. The check must write each declared image in every run: one that is missing afterwards or unchanged from before the run (a PNG left by an earlier version, or an existing product file) fails the check, as does one that is a symbolic link, larger than 4 MiB, more than 8000 pixels on a side (the model API's limit) or not in one of those formats, each with a note naming the check and what to change; paths under `.visp/` and `images` on a browser journey are refused. Declared images are outputs, so a rerun that writes a different image does not make earlier evidence stale (a declared image that existed before the feature started, committed or inherited as uncommitted work, stays part of the product, and when the check rewrites it the "Product changed while checks ran" gap says to write the image to a new untracked path). The resident rules and `VISP.commands.md` tell workers to give an image-file result's check `images: [out.png]`, a PNG or SVG it writes (keeping the requested format too), and an experience outcome naming what the picture must show.
- **Pictures the product makes reach the reviewer without a declaration.** Workers declared a picture output in 1 of 6 visual benchmark runs, so reviewers saw source and a "core file unavailable" note instead of the picture. After the checks pass on an unchanged product, up to four product images (PNG, JPEG, WebP, GIF or SVG) written since the feature started become review captures of that version, newest first, each once per version. Images over 8000 pixels on a side are skipped. An SVG is rendered in a browser, since reviewers can view PNG files but not SVG ones; the run's SVGs share one browser started before VISP takes its state lock (other VISP processes give up on the lock after 5 s), the rest are skipped once the browser fails, a browser that failed is not started again for an hour unless its executable changes, and an SVG that does not render is not tried again until it changes. Nothing in this step can fail a check.
- `visp doctor` reports an `other host files` check: untracked instruction or settings files of a coding host other than the configured one (for example `AGENTS.md` and `.codex/` in a Claude Code project), which VISP no longer treats as product. It lists them as information with no action needed: committing them would make them product again, and deleting them would remove another app's files.
- **`visp uninstall`, the reverse of `visp install`.** A project that tried VISP had no way back short of deleting files by hand. It removes only what install wrote and still recognizes as VISP's, in one recoverable transaction: generated files whose content still matches, the VISP block in `AGENTS.md` or `CLAUDE.md`, VISP's hook entries in `.claude/settings.json` and the `visp` entry in the host's MCP configuration (JSON, JSONC or TOML; only those entries change, the rest of the file keeps its bytes and the previous text is saved under `.visp/state/backups/`), the Git `pre-commit` hook if it is VISP's (a hook install set aside as `pre-commit.local` is restored), an unedited CI workflow, and the install record. A file or hook entry you edited is reported and kept; `--force` removes it too (an edited Git hook is saved under `.visp/state/backups/` first). It refuses while a slice is authorized, even with `--force` (finish it with `visp done`), and refuses a `--harness` other than the installed one. `--dry-run` previews every path, `--harness <host>` picks the host (default: the configured one) and `--json` prints the result. Feature history and project state under `.visp/`, `visp.yml` and the `.gitignore` entries from `init` are kept (uninstall removes only `.visp/hooks/*.mjs`, the install record and the asset manifest, and writes backups); the output says how to delete them by hand. Files install created are deleted when emptied, files you already had are kept; a file that ended with two newlines or none (instruction files, `.codex/config.toml`) comes back with one, since an appended block cannot be told apart from trailing blank lines that were already there. Project checks may not run `visp uninstall` (except `--dry-run`), like `visp install`.
- **The reviewer checks a real thing the request asks a picture to depict by its identifying parts.** In six visual benchmark runs of "an SVG of a PS5 controller", reviewers who saw the picture called a controller with no two-tone shell, no shoulder buttons and no logo "generic" in an optional finding, the worker went on to accept, and the blind judge marked each missing part down (overall 5 to 7 of 10). The visual review rule now has the reviewer first list the objects and looks the request names, then, for a real thing to be depicted (a product or model, vehicle, animal, building, landmark), list and check its identifying parts and colouring; a missing or unrecognizable part that makes it read as a different thing (or, for a named brand or model, a generic one) is one required finding per thing naming every such part. Parts left out by a style the request names (a minimalist logo, an icon, a silhouette) and colours or styles it names stay as requested. In two paired batches (Haiku 5.5 worker, Sonnet 5.5 reviewer, three runs per arm each) the lighthouse picture's judge score rose both times (8.33 → 8.67, 7.67 → 8.33); the PS5 controller and the voxel pagoda moved by a third of a point in opposite directions between batches, with equal part counts pooled.

### Changed
- **A check that declares images must cover an `experience` outcome** that says how the picture must look. In the benchmark rerun the reviewer saw the rendered scene and reported that the requested cherry blossoms and garden were not recognizable and that a tree hid the pagoda, but both findings were optional: every outcome in the brief was technical (file written, grid size, flat shading, determinism) and finish findings are always optional, so the worker accepted the unchanged picture. The brief is now rejected without such an outcome, with an error that names the check and the slices that run it, and the visual review rule says that an object, subject or concrete look (named colours or palette, art style, viewpoint) the request names for a picture or screen to show that is missing, hidden, cut off or reads as something else is a departure from the request: a required finding that keeps its outcome unsatisfied. Recognizable objects are no longer listed as a finish trait; evaluative words such as modern, clean or polished stay finish, and the rule adds nothing for an ordinary app's controls, forms or data tables. Polish beyond the request stays an optional finish finding. A required experience outcome otherwise needs a browser journey's before, input and after images, which a static picture (a Python render, an SVG) never has, so `visp accept` could not pass; when no browser-journey check covers the outcome and no slice that owns it writes a web page or component, a satisfied assessment citing a current image from the check now satisfies it (a web game still needs its journey).
- **The Claude Code hook refuses a backgrounded `visp work`, `done`, `verify`, `accept`, `next`, `pr`, `status`, `brief`, `critic` or `review`, and the Claude Code and Codex shell hooks refuse one inside a shell loop.** A backgrounded command is sent to the foreground with a 600000 ms timeout; a loop is refused with host-neutral text: run the command by itself with the host's maximum shell timeout. In the Oct 13 benchmark workers started `visp done` and `visp accept` as background tasks (about 15 s of work) and then waited for them in polling loops (`pgrep -f` matching its own shell, `tail -f` piped to `grep -m1`) for up to 9 minutes. A loop such as `until visp status | grep -q …; do sleep 10; done` is refused in the foreground too, since it polls until the host's timeout; a loop elsewhere on the line (`for …; done && visp verify`) is not. Only `visp` (or its path, or `npx @visporg/visp-coder`) as the command counts, also inside `$(…)`, backticks, a subshell or `bash -c`, with the verb as the first word after it, so quoted text, `grep visp` and a request in a heredoc are not refused. `visp feature` (which keeps writing acceptance tests after it prints the feature id) and `visp ui` may still run in the background. The resident rules no longer say "Poll" about a running `visp feature`; they say to run `visp work` at its id and never rerun feature, and the standard profile says to wait on done/verify/accept handles until they return instead of polling them. Rerun `visp install` to update the hook and the rules.
- **`visp ui` polls less while its live connection is up.** With the event stream open the page re-reads the open feature every 30 s (and once a second after each change) instead of every 10 s, so edits to your product's own files still show. If the connection drops, the page polls every 10 s and reconnects with a growing delay (1 s up to 30 s), and stops reconnecting when the dashboard no longer accepts its link.
- Every `visp` command starts faster, the edit hook's `visp guard` included: the MCP SDK and its schema converter now load only when serving MCP or preparing a review. `visp guard --path` took a median 389 ms instead of 573 ms (20 runs, loaded machine).
- `visp done`, `visp verify` and the Git pre-commit guard read the project's environment files faster on large trees: directories are read concurrently. With a 20,000-file ignored virtualenv the scan took 38 ms instead of 168 ms (median, loaded machine), and `visp guard --json` 721 ms instead of 877 ms. What is scanned is unchanged.
- A capture run is recorded once, in the feature's product state, which every command reads and which is committed with the trail. It was also written to the git-ignored `captures/run-<id>.json`, which nothing read. `visp trail prune` removes the copies earlier builds wrote.
- Every `visp work` reply names its context pack with a `contextId`. A worker that still has an earlier reply in view can pass it back with `visp work --known <contextId>` (MCP `known`) so that unchanged source excerpts, related files, memory notes, skills, examples, decisions, acceptance baseline and earlier project decisions are not repeated; the reply says what it left out and that calling `work` without `--known` sends everything. Without `--known`, every reply is complete, as before.

### Fixed
- **Required findings on slices that share files no longer send `visp next` back and forth between them.** In a slingshot-game benchmark run the feature review's required finding named the win/loss outcome (T002) and the turn outcome (T001), and both slices edited `game.js`. Once the review budget was spent, `visp next` sent the worker to whichever slice's checks had not run on the current version; each repair left the other slice's checks stale, so it alternated between `visp work --task T001` and `--task T002` until the run timed out. Two findings, one per slice, alternated the same way. The finding was also first routed to T001, the earlier slice, though its fix belonged to T002, and `visp done` refused the worker's edit to T002's test as out of scope. Each finding now has one owner slice: the slice whose review reported it, else the slice of the first outcome it names, else the first slice. `visp next` reopens that slice, and once the budget is spent each owner gets one repair round, which counts when its checks pass on a version after the latest review and stays counted when another slice's repair changes shared files. `visp next` hands off to `visp pr` when every finding has had its round, nothing currently fails and the current version is one a round passed on; an edit after that goes back to `visp done` first.
- A desktop app importing a Claude Code project wrote `AGENTS.md`, `.codex/` and `.agents/` into it mid-run; as product files they made an acceptance stale and failed `visp done` with a scope violation the worker could not resolve. Untracked files of another coding host are no longer part of the product identity, scope check or input warnings (tracked ones, the configured host's own files, ones a slice scope or check names or forbids, as `AGENTS.md`, `**/AGENTS.md` or `.codex/**` do, and ones the configuration blocks still are; a catch-all such as the `**` scope of `visp work --check`, allowed or forbidden, names none of them).
- A review was discarded, or an outcome left unassessed, when the reviewer cited evidence VISP had listed as unavailable (a rendered PNG VISP could not deliver as text) beside current evidence: about 30 reviews across the benchmarks, among them every voxel-scene run's. Such a citation is now dropped and recorded as a limitation (`VISP dropped citations of evidence it could not deliver: ...`) when the same verdict also cites known evidence. A judgment marked unclear or unavailable keeps its citations, and stale, unknown and ambiguous citations are never dropped (a citation of an ambiguous ID, which VISP also lists as unavailable, still makes the review fail as before).
- Hooks written by the same VISP build installed at another path (nvm, npx, a local `node_modules`) no longer count as missing. Every generated hook embeds the path of the CLI that wrote it and was compared byte for byte, so `visp feature` refused to start on hosts other than Claude Code and `visp doctor` reported the hooks as stale or edited. The check now re-renders the hook with the path it embeds: the build ID, version and template must match, and the CLI it calls must exist.
- A `[mcp_servers.visp]` table added to `.codex/config.toml` by hand is accepted when it starts this VISP build (`node` with this build's CLI and `serve --mcp`; other keys may differ). It was always reported as customized: `visp doctor` suggested `doctor --fix`, which answered "add it manually", which the user had already done. For a table that does not start this build, doctor and install now say exactly what to set, or to delete the table and rerun `visp install`.
- Registering the MCP server in a JSON or JSONC host configuration (`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `opencode.json`) re-serialized the whole file, so every comment and the file's own layout were lost, with no backup. `visp install` now changes only the `visp` entry's text, in the file's own indentation and line endings, and uninstall removes only that entry. Before rewriting any host MCP configuration, Codex's TOML included, it keeps the previous text under the git-ignored `.visp/state/backups/`.
- A reviewer or tester killed with SIGKILL left its private copy of the Codex sign-in (`auth.json`) in the temporary directory for up to an hour. The copy now names the process that made it, and the next reviewer, tester or `visp doctor --fix` removes it as soon as that process has ended (a process on another host or in another PID namespace is never assumed ended).
- A sign-in that could not be copied for the reviewer was ignored, so `codex exec` then failed with an unrelated-looking error. VISP now stops with an error naming the file it could not copy, and when no `auth.json` exists and Codex fails, the error names where it looked.
- **A fresh clone no longer refuses every edit before `visp install`.** `.claude/settings.json` is committed but `.visp/hooks/` is not, so in a clone that had not run `visp install` the edit hook command failed and Claude Code refused every Edit and Write with a node stack trace, and printed a hook error on every prompt, stop and shell command. The commands now check for the script first. Without it, an edit is allowed when this checkout has no authorization state, and refused with a message naming `visp install` when a slice may be authorized (a marker exists, or the state is a link or unreadable), so deleting the script mid-slice does not switch enforcement off. The prompt, Stop and shell hooks do nothing without the script. `visp doctor` names the missing script instead of reporting the hook as not installed.
- On Windows the Claude Code hook commands used cmd.exe syntax (`%CLAUDE_PROJECT_DIR%`, `exit /b 2`), but Claude Code runs hook commands with Git Bash there, so every edit was refused even after `visp install`. Every platform now gets the same POSIX command. `visp install` replaces entries written by earlier builds without `--force`, and uninstall removes them.
- The MCP `visp_guard` tool now runs the same pipeline as `visp guard --path`, so its answer matches the edit hook's field for field: it reports `protocolVersion` and, on a refusal, `committable`; while another VISP process is saving it waits briefly and then says to retry, instead of reporting an interrupted update; and a refusal during a pending independent review says so instead of pointing at `visp_next`.

## 0.5.0-beta.3 - 2026-10-12

### Changed
- **The package is now `@visporg/visp-coder`** and the repository is [visplabs/visp-coder](https://github.com/visplabs/visp-coder). Install with `npm install -g @visporg/visp-coder@beta`; the executables (`visp`, `visp-migrate`, `visp-runner`) are unchanged. The library exports moved with it (`@visporg/visp-coder/testing`, `/graph`, `/runner`); browser suites that still import `visp-coder/testing` keep their helper semantics. The generated pull request workflow installs the scoped package, so rerun `visp install` to update it.

### Added
- **A VISP-launched Claude reviewer** (`critic.launch: claude-exec` with `critic.harness: claude-code`). VISP-launched review existed only through `codex exec`, so projects without Codex access, or whose Codex plan no longer offers the reviewer model, got no independent review unless the worker's host delegated one. VISP now runs one `claude -p` per reserved call: `--restricted --safe-mode` with only Read, Grep and Glob, no settings files, hooks, MCP servers or saved session, the configured model and effort, and the packet's response schema as structured output. `visp doctor` checks the CLI and its sign-in.
- **An independent tester with `claude-exec`.** The tester started only with `critic.launch: codex-exec` and a Codex critic, so `claude-exec` and host reviews got no acceptance tests and no notice. `claude-exec` now starts a restricted `claude -p` tester in an empty temporary directory after a bounded sign-in check (new projects; tests of an existing codebase stay with the Codex tester). `work` reports a skipped tester with its reason, `--retry-tests` refuses when no tester is configured, and a critic without its own harness uses the project's, so `codex-exec` in a Codex project also gets the tester.
- **Flip check in the product loop** (`workflow.flipCheck`, default `auto`). Each passing declared check runs once more on the pre-change implementation in a temporary copy of the project, and its execution records `failsWithoutChange`. A check that passes either way is shown to the worker and reviewer as a coverage gap; the result is display only and never gates acceptance. The check's external side effects happen twice, so set `off` for checks that must not run twice; spellings of the project path the copy cannot rewrite are listed in `docs/configuration.md`.
- Workers are pointed at up to eight existing tests that exercise the source they changed, and reviewers must report weakening, skipping, deleting or deselecting an existing test unless the request changes that behavior (quoting the request sentence).
- **Disputing a wrong pinned test.** In 3 of 15 Codex-worker benchmark runs a pinned acceptance test that was itself wrong blocked the whole loop, so the independent reviewer never ran and the worker ended stuck: a browser suite passed every assertion but exited non-zero because deleting Chrome's temporary profile threw `ENOTEMPTY` (about 15 `done` calls), a suite asserted an object key order the request does not state, and a spreadsheet suite put `=MIN(A1:C1)` in B1, a cycle by the request's own definition, and expected 0. The only guidance was a sentence asking for an intent change, which no worker managed and which an unreviewed intent change could not settle anyway. The worker can now run `visp done --dispute "<test name>" --reason "<request quote + why>"` (also `accept`, and MCP `dispute`/`reason`) for a test that failed in that run. A disputed failure no longer keeps `done` from launching the independent reviewer, which receives the test name, the tester's quote, the reason, the bounded failure output and the test source, and rules `upheld` or `rejected`, quoting the request. An upheld test is waived (the suite skips it through `VISP_WAIVED_TESTS`) and the waiver and reasoning are recorded in `acceptance-tests.json` and `visp pr`; a rejected test stays required and cannot be disputed again on the same source. Only failing declared tests can be disputed, a reason is required, and the worker never rules. Failing pinned tests now also reach `next` on the last open slice, with the dispute command once per reply (or, with no VISP-launched reviewer, a plain statement that nothing can be waived). A dispute names a test on a `FAIL:` line of a blocking run; the reviewer is launched despite the failure only when every failing test is disputed; only a review VISP launched and observed can rule, and an upheld waiver is verified against the critic state, so editing `acceptance-tests.json` waives nothing; a dispute the reviewer leaves unruled gets one more review and then goes to `visp pr`; a suite that cannot skip tests counts as passed when every failing test is waived. The tester prompt gains rules that only the assertions may fail the run (teardown errors are caught), that assertions never depend on incidental ordering, that failing tests print `FAIL: <name>`, and that the suite skips waived tests.
- Independent testers surface ambiguous request rules, their reasonable readings and the conventional choice without freezing ambiguous assertions. Notes are saved in `acceptance-tests.json`, delivered as "Decide explicitly" notes in CLI/MCP `work` replies, and included in reviewer packets.
- **`visp ui`, a live local dashboard.** It shows what the agent is doing now, what each outcome's evidence proves (the agent's checks, the independent tester's pinned suite and the reviewer's judgment, with out-of-date runs never counted as passes), every check run with its full output, the independent reviewer's findings and the evidence they cite, the activity since you last looked, the `visp pr` handoff, and a Needs you inbox of questions the agent asked, work ready for acceptance, review budgets spent and blocked checks, with a count in the browser tab and optional browser notifications. It reads the same services as `visp status`, updates within a moment of any recorded change, and changes nothing: it runs no commands and shows commands to copy instead. It listens on `127.0.0.1` only, signs in with a one-time link token, and loads nothing from the network. It follows the system's light or dark setting and works down to phone width. See [the dashboard guide](docs/dashboard.md).
- **Visp Memory as the long-term store** (experimental, opt-in with `memory.service: {command: visp-memory}`). When a feature starts, VISP records the earlier features' requests in Visp Memory, paragraph by paragraph, and adds the decisions Visp Memory selects for the new request (none when nothing is relevant enough) to that request and to every `work` reply, so the worker, tester and reviewer see them without looking anything up. `memory.enabled: false` switches it off too. With a VISP-launched Codex reviewer, its model chooses among a wide candidate set (`memory.service.select: model`, the default; `keyword` uses Visp Memory's selection alone): with ten unrelated earlier features in the store, keyword relevance scored everything alike and delivered fourteen notes, near-miss limits from other endpoints included, while missing a needed one; the model chose exactly the three that applied.
- **Project rules.** When a user's recorded prompt states rules for later work ("these conventions apply to this change and to all later work", "from now on, …", "going forward, …"), `visp feature` records them in `.visp/rules.json` without the worker's help. The tester and reviewer judge against the current rules and every `work` reply shows them as plain numbered lines; they are read when used, not copied into a feature's fixed request, so a removed rule stops applying at once. All recorded prompts are read together, so a later message that replaces or withdraws a rule wins. `visp rules` lists them; `visp rules remove <id>` removes one captured by mistake. With a VISP-launched Codex reviewer (`critic.launch: codex-exec`), the reviewer's model reads the rules at low effort (about ten seconds, seeing only the prompt), and a rule is kept only when it quotes the prompt verbatim; phrase matching, the fallback, found 4 of 18 held-out prompts that stated lasting rules, and the model found all 18 with none in 12 ordinary requests. In a two-session benchmark, fresh sessions applied 3 of 24 convention checks when the conventions were only in VISP's records and 24 of 24 when they were restated in the request.
- Independent testers write one goal test per level, stage or scenario the request defines, instead of testing only the first: in the Oct 9 catapult runs every pinned suite tested one level's win, so unwinnable later levels shipped. Goal searches start from candidates the product exposes (aiming at each remaining target), keep the most progressive action between steps, and stop at about 150 attempts; a suite may take about 90 s against a working product. Suites that open the page check once that the named test hooks exist, so an unimplemented project fails within seconds. Calls through Node's assert module imported under another name (`import check from "node:assert"`) count toward the three-assertion minimum; a method of the same name on another object (`page.check(...)`) does not.

### Fixed
- **Existing repositories.** On SWE-bench Verified Mini, VISP's review never ran on Django or Sphinx. Each of these causes is fixed:
  - `visp init` picks its preset from the dominant tracked source language, not from a stray `package.json`. It adopts a suggested whole-project check only if its toolchain is available and the check passes now (90 s shared budget), and lists the others with the command to add once they pass.
  - A configured check whose tool or npm script is missing is an environment failure, not a product failure.
  - Review sources are decoded only from valid UTF-8 bytes; others are delivered as binary. A Latin-1 test fixture made every review fail with "Source changed while preparing review".
  - When a slice scope covers more than about 64 files (the default `**` on Django is 6,148), the review core is the files changed since authorization, not the whole scope, which overflowed the packet in every run.
  - Reviews of products too large for one restorable candidate copy (2,000 files / 32 MiB) keep file identities and refuse restoration instead of refusing review.
  - Reviewers see a bounded diff of changes to existing files before other context, so a small change inside a large file is not missed.
  - `brief.yaml` is written so every string reads back exactly; a pasted issue with tab-only lines made VISP reject its own brief.
  - Refreshing the code graph no longer overflows the stack on large repositories (about 135,000 relations).
- On Node 22, every command printed "ExperimentalWarning: SQLite is an experimental feature" to stderr, which hosts and `--json` callers read. VISP now holds back that one warning when it loads `node:sqlite`.
- On native Windows, `npm` and other commands named without an extension resolved to Node's extensionless `npm` shell script, which Windows cannot start, so npm checks failed. VISP now tries only the extensions in `PATHEXT` when a name has none of them, as Windows does.
- On native Windows, `visp install` did not recognize its own Claude hook entries (written with backslashes), so an edited entry was not reported as customized, and an install over an older build's entries added new ones beside them instead of replacing them.
- On native Windows, writers racing for the state lock could fail with `EPERM` instead of waiting: a released lock directory stays pending deletion while another writer still has it open, and Windows refuses to create it again until then. `EPERM`, `EACCES` and `EBUSY` while taking the lock are now retried until the lock's timeout and reported only if they last that long.
- `visp ui` parses an unchanged `brief.yaml` and product state once instead of on every read: a dashboard request read the same record about three times, and parsing the brief took about 11 ms each time on a small VM.
- Product source snapshots hash files with bounded concurrency and batched Git identities: `visp next` on Django went from about 4.8 to 2.1 s and `visp done` from about 45 to 26 s, with the same path checks on every access.
- A retried independent tester keeps the mode it first started in. `visp work --feature <id> --retry-tests` and a repeated `visp feature` request decided execution mode from the project at retry time, without the `critic.existingCodeTests` check the first launch has, so a Codex tester that started on a new project could be retried in a writable, networked repository copy once source files had been committed, and `--write-tests`/`--retry-tests` ran it that way on an existing codebase that never opted in. VISP now records whether the project had existing code beside `tester-source-digest` (`tester-launch-mode`) when the tester first starts, retries use that mode, and both retry paths refuse execution mode unless `critic.existingCodeTests` is `true`, with the reason (an error from `work`, a note from `visp feature`). Features started before this record fall back to the current project, still behind the opt-in check.
- MCP `visp_query` with `operation: "unknowns"` lists the unknowns as its answer, with their detail. It said `no results` and then listed them under "Not determined", which the CLI had already stopped doing. Both surfaces now share one renderer; a CLI query with no rows but some unknowns now says `no results` before listing them.
- Independent acceptance baselines run against private launch-time source copies, so concurrent implementation no longer discards the suite. Each baseline uses a fresh copy; temporary files are cleaned up and environment filtering, process cleanup and output redaction remain in place.
- Independent review sweeps every stated rule and common input variants before spending its three findings on optional robustness. Unstated extreme limits are advisory and do not trigger repair cycles or extra middle-slice reviews.
- The memory gate carries decisions about a kind of argument or value to new operations that take the same kind: on a spreadsheet engine it never passed "digits must be a whole number from 0 to 10", stated for `ROUND`, to a request for `ROUNDUP` and `ROUNDDOWN` (0 of 5); now 5 of 5, still without near-miss limits of other arguments.
- A worker no longer discards earlier uncommitted work to start a feature. `visp feature` refused a working tree holding a previous session's uncommitted changes with "git commit the project baseline", and the worker ran `git checkout` on those files instead, losing the earlier feature. The refusal now names `git add -A && git commit -m "<what these changes are>"` and says not to discard them, and the Claude Code hook refuses `git checkout`/`git restore` of files with uncommitted changes and `git reset --hard` on a dirty tree. Branch switches, staged-only restores and stashes are unaffected.
- `visp feature` starts on uncommitted earlier work when Git cannot be written. Codex's workspace-write sandbox keeps `.git` read-only, so the commit the refusal asked for always failed, `visp next` kept pointing at `visp feature`, and workers gave up or edited without VISP (3 of 3 benchmark runs). A write probe of the git directories now decides: where Git is writable the refusal stays, worded for that case (commit, fixing a missing author identity or a failing hook; never discard); where it is not, the feature records the changed files' content in `.visp/state/inherited-changes/<feature>.json` and the reply says they are earlier work not to be discarded. Slice scope was already judged on content from `visp work`, so unchanged inherited files are not the feature's changes and files it changes further are; `visp guard`'s working-tree diff, input warnings and the `visp pr` document now agree.
- An edit authorization belongs to the host session that ran `visp work`. A first session ended with its slice open after the review budget ran out, and a later session with a new request edited under that leftover authorization without starting a feature for its own request (seen in three of nine second sessions of a two-session benchmark). The hooks now record the host session of each prompt and shell command (`.visp/session/host-session.json`, git-ignored), `visp work` stamps the session that runs it on the authorization, and the editor hook passes the editing session to `visp guard --session`, refusing writes under a grant from another session, naming both ways on: `visp feature` for a new request or `visp work --task <id>` to continue. Re-authorizing keeps the slice's baseline. Hosts whose prompt hook reports no session keep the previous behavior; installed hooks update with `visp install`.

### Fixed from the 28 September audit

Issues found by an internal audit on 28 September, outside the review loop.

**Scope enforcement and hooks**

- Commands and MCP tools started in a project subdirectory now find the initialized root, and `visp init` refuses to create a second project below it. Absolute input paths and edit hooks also accept symlinked spellings of files inside the root.
- Claude's edit hook now leaves normal host permission prompts in place for allowed and non-project files, while refusing in-project symlink escapes, protected VISP state and control files, and blocked paths at any depth regardless of case. Hook startup failures exit as blocking errors.
- `visp guard`, MCP `visp_guard`, `visp done` and pre-commit now agree on active scope policy, overrides and protected paths. Authorization freezes blocked-path settings and hashes ignored `.env*` files so later config tampering and secret-file changes are refused.
- The Claude shell hook checks destructive command operands rather than unrelated words in a compound command; doctor labels Claude's edit-tool boundary and warns that Codex scope checks occur at commit time.
- MCP browser capture no longer accepts an agent-selected executable; documentation explains that MCP-run checks execute outside the coding host's sandbox.

**Runtime pinning and Windows**

- Installed hooks and MCP registrations launch the recorded VISP CLI, so a different `visp` on PATH cannot change enforcement; switching builds now requires `visp install --replace-runtime` and a host restart.
- `visp doctor` names both runtimes on a mismatch, avoids misleading asset repairs and readiness advice, and shows when the shell's `visp` differs from the installed CLI.
- Native Windows can launch npm, pnpm and Codex `.cmd`/`.bat` shims for checks and independent review, while installation and Claude hooks run the pinned CLI through Node.
- Generated hook scripts are local checkout assets; ordinary Claude edits remain available when VISP cannot answer and no task is authorized.
- Runtime build IDs ignore editor debris and CRLF differences, and the MCP SDK minimum includes the APIs VISP imports at startup.

**Installation and doctor**

- Installer merges JSONC MCP configuration without discarding models, permissions or other servers; malformed files remain untouched even with `--force`.
- Cursor and Copilot receive MCP registrations in their host-specific project files, and Cursor installation removes an exact legacy root VISP entry. Codex registration can be added to an existing project TOML without replacing other settings.
- Installer preserves an existing untracked Git pre-commit hook as `pre-commit.local` when `--force` is used, while refusing to replace a tracked hook.
- Claude Code installs through an in-project `CLAUDE.md` symlink, and doctor detects missing prompt, Stop, Bash and MCP registrations, Codex trust and sign-in gaps, and unavailable browsers required by active checks.
- Generic-host activation and non-host-hook enforcement limits are reported accurately; Codex-exec independent tests are skipped with an explanation when the critic host is not Codex.
- Generated CI quotes pull-request branch names safely and uses read-only repository permissions. Installation documentation keeps local hooks when adding CI, and suite-specific test scripts rebuild `dist/` first.

**Evidence identity and snapshots**

- Product evidence stays current across terminal settings, sandbox routing variables and new Claude or Codex sessions. Freshness uses runtime environment variables and optional check `environmentVariables`; the full inherited environment is hashed separately for execution comparisons. The docs now state that checks inherit operator credentials and record their output.
- Mid-slice merges, pulls and rebases no longer count incoming committed files that still match `HEAD` against the slice scope or changed-file limit. Verification reports those paths separately and recovery guidance preserves committed content.
- Repository file, directory, dangling and external symlinks are snapshotted as links. Candidate capture and recoverable restore preserve their target text without following it; symlinked parent directories and managed-state links remain refused.
- Large repositories no longer exhaust source and candidate budgets solely because of unrelated tracked files. VISP uses Git identities outside declared inputs, captures candidates for the selected slice, and skips reviewer handoff construction until a current execution has passed.
- `work`, `next` and verification name untracked files outside all declared scopes and check inputs, so generated logs can be ignored before they invalidate evidence.
- Declared Node verifiers recognize test options with separate values, including `--test-timeout 5000`; ambiguous entries explain the `--flag=value` workaround. Checks without declared verifier inputs no longer hash their executable.
- Python bytecode defaults to a private per-user cache with verified ownership and permissions, refusing unsafe or symlinked cache directories instead of using a shared writable `/tmp` location.
- `doctor --check-command` describes its separate smoke-check environment accurately, and test-result parsing recognizes Node’s spec reporter as well as TAP.

**Locks, cancellation and processes**

- Restrictive umasks no longer strand file transactions. Recovery tolerates mode-only differences, guard waits briefly for live writers, and product reads retry brief/state pairs observed during a concurrent update.
- State locks record Linux process identity to detect reused PIDs and avoid guessing across PID namespaces. `doctor --fix --recover-lock <owner-token>` recovers a confirmed stopped ambiguous owner; busy errors include owner details and MCP-specific recovery.
- Command checks retain bounded head and tail output without failing at 8 MB. POSIX subprocess groups are terminated on exit, cancellation and timeout; checks accept `timeoutMs`, and timeouts are recorded separately from product failures.
- `verify`, `done`, `accept` and browser captures release the worktree lock while executing. MCP cancellation reaches subprocesses, completed checks are persisted individually, interrupted runs resume current passing checks, and CLI/MCP report progress.
- Review waits use the remaining whole-call budget (100 seconds on CLI, 50 over MCP); pending reviews point to `visp next`, and acceptance no longer runs the same checks twice around a review. Installed instructions request the host's maximum shell timeout.
- Feature rule extraction and memory model calls run before taking the lock that allocates and saves the feature.
- Browser connection failures name the app URL to restart; journey timeouts point to check authoring, and missing shared libraries are no longer classified as permissions. Startup probes use the journey's 10-second budget and cache only deterministic missing-browser failures.
- Sandbox diagnostics recognize process-spawn denials and outside-workspace filesystem denials, while uncertain permission errors retain their failure status with contextual advice.

**Secrets, branches and sessions**

- Check and independent-test diagnostics mask environment values, credential patterns and local paths before entering the committed feature trail; raw command output stays under ignored session state. Preserved requests and project rules mask credentials, and feature replies disclose request redaction.
- Candidate checkpoints keep only hashes for ignored, secret-named and blocked inputs, and refuse to restore their omitted contents. Candidates no longer duplicate the brief, full product state or image bytes.
- Switching branches or stashing a temporary slice no longer traps `next`, `status`, `work` or commit hooks behind stale local selections. Missing explicit task IDs list the valid slices.
- Feature ordinals are allocated across Git refs and atomically reserved across linked worktrees; new project rules use content-derived IDs, ambiguous legacy rule removal is refused, and fresh checkouts select features by creation time.
- Concurrent host sessions no longer stamp anonymous work grants with another session's identity. Bare `work` respects new-session request routing, question-only new sessions avoid Stop reminders, and reminder budgets are scoped to each session and feature.
- CI scope checks use all features carried by a pull request or matching its branch, including renamed and detached branches. Authorization updates the feature's recorded branch, and CI refusals give CI-specific recovery guidance.
- Migration archives exclude private session and derived graph state. Preview reports invalid artifacts by feature and path while continuing through unaffected features; apply names the failure and explains how to migrate other features individually.
- Captures and candidates are ignored by default, diagnostic history has rolling retention targets that preserve referenced evidence, and `visp trail prune` removes unreferenced local artifacts. Doctor respects a deliberate choice to keep the whole trail local.

**Agent guidance and replies**

- Resident guidance starts a one-slice feature with `visp work --check`, keeps critic review material out of the default command guide, and shows a quoted-heredoc form for verbatim requests.
- Brief revisions preserve an authorized slice's original file baseline, report revoked edit authority and reopened slices, and keep unlinked advisory decisions from reopening completed work.
- `visp next` handles existing outcomes, incomplete briefs, and outcome-less slices without sending agents through dead-end work commands.
- MCP replies provide structured next actions, avoid duplicating full results in text, and keep index refreshes to counts and short samples unless detail is requested; doctor identifies a different `visp` build on PATH.
- CLI status, handoff, capture, control, and observations return focused summaries with recovery commands and relevant image paths; `--full` retains complete status and handoff JSON.
- Browser checks summarize failures first and reuse matching completed captures during `done`; capture replies avoid duplicate image metadata and cumulative step histories.
- Usage errors return the JSON error envelope and exit code 2; quoted check arguments remain literal; usage import errors and docs explain how to copy external rollouts into the project.

**Independent tester and memory**

- Independent acceptance tests no longer pin when their interpreter cannot start, when the launch-time source snapshot cannot be captured consistently, or when the suite explicitly admits it checks only file structure. Later worker edits are isolated by the launch-time baseline copy.
- New-project testers run in an empty temporary directory; candidate and pinned test processes receive a limited environment, and Node acceptance files avoid automatic `node --test` discovery.
- Tester recording and pinning wait through state-lock contention, retain a validated candidate on a busy pin, and allow failed attempts to be retried with `visp work --feature <id> --retry-tests`.
- Live testers remain `running` beyond ten minutes, missing Codex installations do not launch doomed background testers, tester logs stay with their feature, and later tester starts remove abandoned temporary auth copies.
- Visp Memory records successful request chunks as they complete, so a failed chunk no longer causes earlier decisions to be submitted again.
- Configuration and doctor settings now explain `memory.recall`, `memory.service.*`, and the narrower effect of `telemetry.enabled`.
- The library API identifies `loadWorkspace()` as the source of a loaded workspace for product and observation services; the unused artifact-store reader is removed.

**Repository graph**

- Graph queries now resolve exact symbols without a search limit, report ambiguous names with candidate IDs, show the selected IDs, accept both ends of `tracePath`, and expose snapshot identity and freshness in replies.
- Incremental indexing keeps calls through unchanged barrels and newly added Python modules, reparses only direct importers and affected re-export chains, and avoids small-snapshot VACUUM work.
- Python src-layout and module-qualified imports, Vite root-absolute script links, and package-based tsconfig inheritance now produce the expected graph edges or actionable unknowns.
- The graph walker indexes nested source directories while excluding agent worktrees and non-source assets; parser cancellation no longer contaminates the next file.
- Read-only graph queries no longer wait for the state writer lock; concurrent graph writers receive a retryable GRAPH_BUSY error, and repeated MCP queries reuse a bounded snapshot cache.
- Graph query documentation now uses a symbol for `callers` and shows the two-endpoint `tracePath` command; missing-index recovery points to `visp index`.

**visp-runner and browser testing**

- Resumed Codex turns now reapply the pinned sandbox, approval policy and isolated configuration, while transient reconnecting errors no longer fail successful turns.
- Claude runner attempts accept separately recorded auxiliary-model usage, require explicit tool permissions for writable runs, and load only a pinned `.mcp.json` instead of ambient MCP servers.
- Study allocation is reserved only after worktree, resume and harness preflight succeeds; host executables are resolved to a pinned real path and verified before each turn.
- Required command observations recognize bash, zsh and sh wrappers by absolute-path basename, including `/usr/bin/bash`.
- Evaluator reports up to 16 MiB can arrive as a single JSON line, preserving blank lines without hitting the host event-line limit.
- Runner host processes inherit proxy and CA settings while retaining the credential allowlist; Claude auto-updates are disabled during attempts.
- `visp-runner inspect` prints a compact run summary by default; `--full` prints the complete verified manifest and snapshots.
- Local browser journeys serve missing confined assets as 404 responses and report invalid CSS selectors as indexed behavior failures with captures.
- Runner documentation now states that Codex's dollar estimate can be enforced only after a turn reports usage.

## 0.5.0-beta.2 - 2026-09-27

### Added
- Bundled skill `edge-cases-first` (`visp skill seed edge-cases-first --by <name>`, then `visp skill admit`): pin current behavior and the request's edge cases as tests before changing code. In three-run Haiku comparisons it passed 420 of 435 hidden checks against 416 without it, at 20% more wall time, so it is not seeded by default.
- `bench/setup_arm.py --skill <id>` seeds and admits a bundled skill, so two arms on one build differ only by that skill.

### Fixed
- Admitted skills reach the worker: an over-budget pack now drops graph rows and source excerpts before skills (it dropped skills first, while keeping excerpts the compact reply never shows), and compact `work` replies show each skill's steps as plain text, headed by its file path, instead of an escaped JSON string.
- The benchmark runners start each worker in its own session: one worker's `kill %1` on its test server ended every run in the batch.

## 0.5.0-beta.1 - 2026-09-26

### Added
- **Independent review launched by VISP.** `critic.launch: codex-exec` (written by `visp init --harness codex`) runs a read-only, ephemeral `codex exec` reviewer once a slice's checks pass and returns its findings as the next repair step; `visp accept` has it assess the assembled product first. Weak workers never ran the host delegation protocol, so their work was never reviewed. `launch: host` keeps host-orchestrated delegation.
- **Independent acceptance tests.** With `codex-exec`, `visp feature` starts a separate tester that writes one standard-library test file from the original request alone. VISP keeps it only if it has assertions and fails on the unimplemented project (after one repair round with the failure output), saves it under `acceptance/<feature>/` and pins it as protected intent (provenance `visp-tester`). `done` on the last open slice and `accept` run it, `done` on earlier slices reports it without blocking, and `work` does not wait for it. It runs for new projects only (fewer than three tracked source files): on existing codebases its suites assumed behavior the code does not have, and workers changed correct code to satisfy them.
- **`critic.existingCodeTests: true`** (experimental, opt-in) runs the tester on existing codebases in execution mode: in a disposable copy with network it runs the existing program, and its tests of existing behavior, using every assertion helper its new tests use, must pass on the real code before anything is pinned. The copy leaves out VISP state, `workflow.blockedPaths` and common secret files, the session's commands get only core environment variables, and every command is logged to `.visp/features/<id>/tester-activity.jsonl` and listed by `visp pr`. In trials 11 of 14 pinned suites were correct against a reference implementation.
- **`critic.webSearch: true`** (written by `visp init --harness codex`) lets the reviewer search the web for public documentation. It is monitored: each call's searches and commands are logged to `.visp/features/<id>/reviewer-activity.jsonl`, `visp pr` lists every query, and the reviewer is told never to put project code or secrets in a query.
- **Request capture.** `visp feature` takes the request from the user's recorded prompt: the Claude Code prompt hook (`.visp/session/user-prompts.jsonl`, git-ignored) or, inside Codex, the session file named by `CODEX_THREAD_ID`. A worker's `--source-brief` is kept only when it quotes a recorded prompt verbatim; without a recorded prompt, `codex-exec` requires the complete request as `--source-brief` (`-` reads stdin). Workers passed 187–238-character summaries of a 2,700-character contract, so tester and reviewer judged against the wrong request.
- **Light path.** `visp work --check "<test command>"` on a feature without slices works the whole request as one slice (scope `**`, the command as its check); on a slice without checks it declares that check. `visp feature` and `visp next` point to it first. Weak workers spent about six minutes planning small changes that bare coding finished in two to three.
- **Host hooks.** Claude Code: a Stop hook sends the worker back to an unfinished, recently active feature (at most three times, once for a handoff); agent edits under `.visp/` are refused except drafts; shell commands that would delete or stash VISP state or pinned tests are refused. Codex: `visp install --harness codex` writes the prompt, shell and Stop hooks to `.codex/hooks.json`, which Codex runs after the user trusts them once with `/hooks`; edit scope stays with the Git hook and `visp done`, because Codex edits through `apply_patch`.
- **`visp pr`** prints a reviewer document built from recorded state: the verbatim request, outcomes with their checks and statuses, decisions, slice scope and uncommitted changes, each check's latest executed result (pinned checks included), the independent tests with the request text each relies on, intent changes, review attribution with open findings, the reviewer's web searches, the tester's networked commands and the next step.
- `visp work` refuses a slice with a functional outcome that no check exercises and shows a one-patch fix: without a runnable check, `done` had nothing to execute and the reviewer no evidence.

### Changed
- The license is now Apache-2.0 (was MIT), which adds an explicit patent grant and states the terms contributions are made under.
- The loop always ends: in acceptance, or, once the review budget is spent with findings open, in a handoff (`visp next` returns `completion: handoff` and routes to `visp pr`).
- Review packets list open findings by ID, and a fresh reviewer may close a functional finding by re-checking it against current passing executions when no failing reproduction was recorded. Findings are required only for departures from the stated request, including a regression of behavior the repository documents. After a clean review, middle slices skip review until the slice that completes the feature.
- The default critic budget is 3 reviews per feature (was 6; `maxCalls` allows up to 6): in weak-worker runs the first three found every contract gap the hidden tests checked. `visp init --harness codex` sets the reviewer's `reasoningEffort: medium`, which matched `high` on hidden tests and cut runs from 14.2 to 12.0 minutes on average.
- `visp done` waits for the review it started (up to 120 seconds on the CLI, 50 over MCP), and `visp next` waits likewise and returns `action: wait` while it runs. Over MCP and on hosts other than Codex the review runs in a detached process that records its own result, because hosts killed a review running inside the worker's turn; from a Codex worker's CLI the reviewer and tester run inside the command, because Codex's sandbox ends background processes.
- Compact output: CLI text for `work`, `done`, `verify`, `accept`, `next`, `feature`, `capture`, `control` and brief updates is compact like MCP text, and `--json` or `detail: true` returns the complete result. Tool definitions shrank from 44k to 21k characters and closed-slice replies from 14k to 1k; repeated resident instructions, approval history and repair context were cut.
- Brief updates normalize common authoring shapes (`description`, `then`, string `given`, list `when`, `decision`/`reason`, slice IDs like `S1`, check objects inside `slices[].checks`, acceptance criteria placed in `acceptanceBaseline`, a reworded `originalRequest`) and report each rewrite in `normalized`; ambiguous input is still refused with its field paths. `--from` also reads drafts in the system temporary directory and suggests stdin for other paths outside the project. Scope errors name the out-of-scope files.

### Fixed
- Windows: every check was recorded as an environment failure ("Unsafe check receipt directory") because the receipt checks compared POSIX permission bits, which Windows does not report; they are compared on POSIX only. Checkouts now use LF line endings (`.gitattributes`), since CRLF broke byte-exact fixtures.
- macOS: the recursion guard for checks now resolves inherited project roots, so a project reached through a symlink (macOS temporary directories sit under `/var`) is still recognized; review-calibration inputs are refused only when the file itself is a symlink, not when a parent directory is.
- The package smoke test passes the verbatim request, matches the Codex template's medium reviewer effort, and puts a failing `codex` stub on PATH so it never launches a model.
- A check whose sockets the host sandbox denied is recorded as an environment failure with the instruction to rerun with sandbox escalation, not as a product failure.
- The Codex reviewer checks that it can reach its model before a call is reserved, and runs with a private writable copy of the Codex sign-in; inside a host sandbox the operator's Codex home is read-only.
- File transactions treat a write of identical bytes as a no-op; critic reservation rewrote every tracked file and failed under Codex's read-only `.agents/`.
- Supervised checks redirect Python bytecode with `PYTHONPYCACHEPREFIX`, so a check no longer changes the product it checks.
- A tester whose process the host ended is reported as failed instead of staying `running`, and the tester's baseline runs end their whole process group, so a suite that starts a server no longer leaves it running.
- Reviewer activity logging no longer raises an unhandled rejection for a packet without a selection, and the log is written before the command exits.
- Brief validation names invalid field paths without repeating schema internals; native critic schemas offer exact outcome IDs and select citations from supplied evidence IDs; a known finding with insufficient repair evidence stays unresolved without discarding the rest of the review; rejected reviews give a nonzero CLI exit and an MCP error result without automatic retry.
- Critic packets summarize obsolete capture notices while keeping current image failures; repair handoffs link findings to cited runner observations and the replay command; the visual checkpoint recognizes current independent outcome assessments; graph entries return to context when oversized excerpts are dropped.

### Removed
- Unused source: the historical observation writer (`recordObservation`, about 550 lines), the unused half of the legacy `ArtifactStore` (attempt, trail, pull-request, project and acceptance readers and writers), `evidence-persistence.ts`, and a dozen functions and constants nothing called. Tests that arrange historical records use equivalents in `tests/unit/support`.
- The stage workflow (`research`, `spec`, `plan`, `tasks`), `context`, `gate` and other commands, tools, library exports and configuration keys replaced by the product loop. See [migration](docs/migration.md) for replacements and `visp-migrate` for upgrading saved history.

## 0.4.0-beta.3 - 2026-09-15

### Fixed
- Browser journeys can change viewport within the same session, preserving the
  running product so rotation and resize regressions can be observed. Pointer
  state and action validation have focused unit and real-browser coverage.
- Revised declared assertions can be diagnosed after the same check passes,
  preserving original input, mandatory outcomes and raw failure history.
- Runner-owned execution summaries avoid repeatedly delivering capture payloads.
  Review images retain intermediate operation context and source freshness.
- UI critic guidance preserves call capacity until rendered evidence is available.
  Explicit source-only advice remains separate from product review; critic
  limitations remain visible to the worker.
- Narrowed generated-input exclusions and improved source-context and image
  handling, with regression fixtures confined to tests.

### Evaluation limitations
- Live pilots have verified working browser input and actual native critic
  invocation, but do not establish better generated products than baseline
  `243121a`. In the latest missile pilot the critic returned no findings and an
  invented evidence reference; its review was rejected. Successful submission
  command handling must not be interpreted as an accepted review.
- This prerelease does not claim to fix critic judgment quality. Continued
  evaluation will measure gameplay, usability, missed defects and administrative
  effort separately. Observation-preview remains opt-in.

## 0.4.0-beta.2 - 2026-09-15

### Changed
- Replaced authored stage documents with a versioned feature brief and a shared
  CLI/MCP product loop: understand, work on a usable slice, observe, and correct.
  Research and graph context answer relevant questions instead of imposing stages.
- Added configurable automatic and manual critic feedback, independent review
  packets, explicit native handoffs, and advisory recovery when a critic cannot run.
  Configured models, call budgets, and deadlines remain explicit; VISP does not
  impose critic character or token ceilings.
- Preserved scope enforcement, transactional state, graph queries, execution
  records, and historical evidence. Removed superseded workflow machinery and
  consolidated shared CLI/MCP behavior.

### Fixed
- Prepared review sessions now derive supporting image links from recorded
  execution. Valid citations no longer require the worker to reconstruct envelope
  fields or duplicate capture bookkeeping. Stale, unselected, failed, or unrelated
  evidence cannot become passing product evidence through these links.
- Browser journeys can be replayed from recorded operations. Feedback distinguishes
  possible behavior regressions, environment gaps, and corrected expectations;
  changing input methods does not erase an unresolved original failure.
- Review image selection balances representative states across viewports within
  the existing image budget. Critic summaries and limitations remain visible.
- Attached critic adapters distinguish cancellation, deadline expiry, and returned
  responses, record observed timing, and prevent duplicate invocation. These
  records do not claim to measure hidden provider startup or billing.
- Improved browser executable/environment identity, capture recovery, check input
  guidance, graph freshness, task resolution, TypeScript configuration parsing,
  observation identities, telemetry handling, and submodule diagnostics.

### Compatibility and limitations
- Legacy features require explicit migration; preview with `visp migrate --dry-run`.
  Historical artifact and evidence bytes are retained. Legacy authoring commands
  return `WORKFLOW_REPLACED`; read-only status does not migrate implicitly.
- Critic transport still depends on host capabilities and authorization. A native
  Codex/Sol review timeout remains under investigation; passing engineering tests
  does not establish that a model will return useful criticism in every host.
- The baseline commit `243121a` remains the comparison reference. Local regression
  coverage establishes workflow behavior and bookkeeping fixes, not a general
  improvement in generated product quality. Repeated model comparisons are still
  required. Game prompts and evaluator expectations live only in test fixtures.

## 0.4.0-beta.1 - 2026-09-04

### Security
- All CLI and MCP enum/artifact identifiers are parsed before workspace paths are
  resolved or state is changed. Managed storage now rejects traversal, portable
  absolute paths, and symlink components beneath the canonical project root.
- Init, harness installation, task closure, and evidence compaction use recoverable
  file transactions. Journals retain bytes and modes so an interrupted mutation can
  be rolled back by the next mutating command or `visp doctor --fix`.
- Generated enforcement is versioned and inspected live. A malformed or unavailable
  guard blocks commits while a VISP authorization exists; ordinary commits with no
  active VISP task remain allowed with a warning. CI remains the authoritative guard.

### Changed
- Harness assets and project-instruction activation are checked separately. Codex and
  OpenCode installs add an idempotent managed reference to `AGENTS.md`; conflicting
  edited blocks are preserved unless `--force` is explicit. Cross-harness cleanup is
  opt-in and removes only fingerprint-matched VISP assets.
- Closing the final task transactionally refreshes `pr.json`, moves the existing stage
  to `pr`, and returns terminal completion. Repeating `done` reconciles interrupted
  closure without rerunning evidence; `done --base` refuses a mixed committed/dirty
  basis that would omit relevant changes.
- Probe receipts remain visible but caller-supplied identities are explicitly
  unverified. They cannot establish independence or gate review. Repeated identical
  failures now escalate from context feedback to changed-hypothesis steering and then
  stop recommending an unchanged retry.
- Observation freshness is based on stable criterion/context/capture content rather
  than timestamps or delivery metadata. Legacy hashes and attachment paths remain
  readable; new attachments are content-addressed per feature.
- Low-risk features may opt into `--workflow compact`, which skips mandatory research
  while retaining specification, planning, task scope, context, authorization,
  verification, review, and closure. Full remains the default. Evidence compaction is
  dry-run by default and quarantines removals when explicitly applied. Explicit
  attempt retention now keeps a validated rollup of counts, time range, and failure
  fingerprints for later status and PR generation.

### Fixed
- The `tested_by` edge was read backwards by both consumers, so `test-of-allowed-file`
  pack entries were modules and the `evidence.test-signal` review check never fired
  when an index existed. Repos with an index will start seeing this finding — that is
  the fix working.
- A changed file no test imports is no longer silently exempt from the covering-tests
  check; it falls back to the presence question.
- The MCP verify/review tools now route failures through `visp context`, matching the
  CLI; the `visp://context` resource serves the slim reading plan instead of the raw
  pack; the PR renders flip/attempt/delta evidence.
- Packed-file staleness no longer charges one task for a sibling's authorized work,
  and no longer runs on every `next`/`status` call. `visp done`'s own status flip no
  longer marks every pack stale.
- The flip check reports a scratch worktree it could not remove, stops copying visp's
  own dirty artifacts into the scratch tree, and its `auto` mode considers only the
  task's own changed files.
- `strictness: locked` now means something: strict with overrides refused. It was
  byte-identical to `strict`.
- The MCP handshake reports the built version instead of a hand-pinned constant.

### Added
- **Failure→context loop**: a failed verify or review routes the next command back
  through `visp context`; the rebuilt pack carries the failing output, unresolved
  findings, and the files the failure named.
- **Flip check** (`workflow.flipCheck: auto`): after a green verify, the task's own
  validation commands re-run in a detached scratch worktree with the task's change
  reverted. Validation that passes either way is named counter-evidence.
- **Reading-plan packs**: entity-level line ranges from the graph replace regex
  windows; the slim MCP view drops hashes and snippet text (`include: "snippets"`
  opts back in); honest token estimates; budget skips record what was omitted.
- **Install profiles**: `visp install --profile minimal` ships a ~250-token guide and
  six MCP tools for small models; profile switches prune only visp-owned files.
- **Evidence rigor at standard strictness**: a review whose every criterion went
  unchecked fails; declared expected files that did not change fail; a requirement no
  task claims refuses `tasks --validate`. Criterion `verification` must be a runnable
  command, `computed: <how>`, or `inspection: <what to look for>`.
- **Graph**: HTML pages contribute their script chain (`page_entrypoint` + import
  edges), calls into runtime globals and bound external modules stop polluting
  unknowns, barrels are chased one re-export hop for calls and test coverage,
  incremental refresh re-parses importers of changed files, and pruning VACUUMs.
- **Consumed pipelines**: `visp checkpoint` reads what `visp save` writes;
  traceability feeds the gate, the PR's per-requirement evidence trail, and the
  requirement-untasked refusal; failure-pattern proposals map the finding codes that
  actually occur.
- Delta diagnostics and an attempt counter on verify; a `repeated-failure` finding
  when the same failure survives three attempts; the session trail records
  verify/review/context/gate/index/query with refusal codes.

## 0.1.0

Initial release: the feature → spec → plan → tasks → context → implement → verify →
review → pr loop, scope enforcement via editor and pre-commit hooks, the tree-sitter
repository index, context packs, learned-skill accreditation, memory, and the MCP
server.
