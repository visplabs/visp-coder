# Dashboard

`visp ui` opens a live, read-only view of the repository's VISP work in your browser: what the agent is doing now, every check it ran and its output, the independent reviewer's findings, and anything waiting on you. It runs on your machine, reads the same records as `visp status` and `visp pr`, and changes nothing.

```sh
visp ui
```

The command prints a link and opens it. Keep the link private: it signs you in. Run `visp ui` again in the same repository to reopen the running dashboard instead of starting a second one. Press Ctrl+C to stop it.

| Option | Effect |
| --- | --- |
| `--port <n>` | Listen on this port instead of a free one |
| `--no-open` | Print the link without opening a browser |
| `--json` | Print one envelope (`url`, `port`, `pid`, `reused`, `buildId`) and keep running, for editor integrations |

## What you see

A bar across the top names the repository, switches between features, and shows whether updates are live. Each feature has six tabs; `Needs you` is always one click away at the right.

- **Now.** What the agent is doing in plain words ("Fixing what failed", "Independent review running", "Ready for acceptance"), the objective VISP gave it, the command it runs next, and where the feature stands from request to handoff. Below it:
  - **What is proven**: each outcome with every independent source of evidence for it: the agent's checks (counted by their latest run, with out-of-date runs counted apart, never as passes), the independent reviewer's judgment, and a verdict. The independent tester's pinned suite covers the whole request, so it stands above the rows.
  - **The thread**: every check run and review, one row per slice, oldest on the left. A dot passed, a square failed, an open square timed out, a ring could not start, a diamond is a review. Faded marks are out of date. Select any mark to open it.
  - Each slice with its checks and its authorized scope, then the brief's decisions and open questions.
  - At the side: what on this feature needs you, the review's open findings, and health.
- **Review.** Open findings (must-fix first) beside the selected one in full: the check that would show it fixed, and the runs it cites. Then the latest review's judgments, earlier reviews, and captured screens.
- **Runs.** Every run, newest first, filtered to problems or to the independent tests if you like. Selecting a run opens its output: command, exit code, duration, who ran it, whether its assertions were written by the agent, observed by VISP's runner or written by the independent tester, and the full output with failure lines highlighted. Beside it are this check's other runs and the findings and outcomes it is linked to.
- **Activity.** Everything recorded, newest first, marking what is new since you last looked.
- **Handoff.** The document `visp pr` prints.
- **Map.** Where the agent changed code, and why. The feature's diff, from the commit before its brief was first committed to the working tree, drawn as the changed functions and classes with what calls them, what they call and their tests (at most 40 boxes; directories stay collapsed until you open one). Solid lines are relations VISP's index resolved; dashed lines are unresolved calls that only match a changed name. Beside it, a reading order: the changed declarations grouped by the slice that explains them. Selecting one shows its hunk, the slice and outcome whose scope names the file, the checks that cover it with their latest run (out-of-date runs say so), open findings whose text names it, and what the map cannot see: changed but untested, possible callers the index could not resolve, run-time imports, an index older than the file. Tick a declaration once you have reviewed it; ticks stay in this browser and clear when its code changes. The map needs the graph index (`visp index`); without one it lists the changed files only.
- **Needs you.** Questions your agent asked (`visp critic feedback --ask`), work ready for acceptance, review budgets spent with findings open, and checks the environment blocked, filtered by kind. The browser tab title shows the count, and you can turn on browser notifications.

The dashboard follows your system's light or dark setting; the button beside `Needs you` switches between system, light and dark.

## How it stays honest

- **Nothing is decided in the page.** Statuses, staleness and the next action come from the same services as `visp status`; the page only formats them. Missing, unreadable or busy state is shown as such, never as an empty success.
- **Out of date means out of date.** A run recorded against an earlier version of the product, slice or check is marked out of date and doesn't count, exactly as in `visp status`.
- **It doesn't act.** The dashboard runs no commands and records no decisions. Commands are shown for you to copy. To answer a question, reply in your agent's chat, or type your answer and paste the command the page builds; the answer is single-quoted so nothing in it expands in your shell.

Keyboard: `1`–`6` switch tabs, `n` opens Needs you, `r` refreshes, `Esc` goes back from a run to the list, `?` lists shortcuts.

## Live updates

The server watches `.visp/` and tells the page which feature changed, so checks, reviews and questions appear within a moment of being recorded. The sidebar shows "Live", "Connecting…" or "Updates paused".

The event stream sees only `.visp/`, and your product's own files can change without VISP writing anything, which makes recorded checks out of date. So while the page is visible it also re-reads the open feature every 30 seconds and once, a second after each change event, and whenever you return to the tab.

If the connection drops, the page re-reads the open feature every ten seconds instead and tries to reconnect, waiting 1 s, then 2 s, doubling up to 30 s between tries. When the connection comes back, the page refreshes once and goes back to the slower re-read. It stops reconnecting if the dashboard no longer accepts the page's link, for example after a restart; paste the new link.

## Security

- The server listens on `127.0.0.1` only; there is no option to expose it.
- The link carries a random token in its `#fragment`, which browsers never send to a server or put in a `Referer`. The page exchanges it once for an `HttpOnly`, `SameSite=Strict` cookie named for the port, then removes it from the address bar. A dashboard that restarts gets a new token; paste the new link into the open tab.
- Requests must name `127.0.0.1` or `localhost` on the dashboard's port as their host, which stops DNS-rebinding pages. Sign-in must come from the dashboard's own origin.
- The page loads nothing from the network and runs under a strict content security policy. Recorded text, including check output and the agent's words, is only ever inserted as text.
- Screenshots are served only from the feature's `captures/` folder, refusing `..`, absolute paths and symbolic links.
- The running dashboard's token is recorded, readable only by your account, in `$XDG_RUNTIME_DIR/visp-ui-<uid>/` (or the system temporary directory), never in the repository.

These controls keep other websites and other accounts out. They don't separate you from processes running as your own account, including your coding agent, which can read the same files `visp ui` reads.

## Limitations

- One repository per dashboard.
- Nothing can be approved from the dashboard yet. Signed human decisions are planned; see [the specification](specs/visp-ui.md).
- The dashboard serves the page it was built with; after upgrading VISP, restart it.
