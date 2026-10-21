# Security policy

## Reporting a vulnerability

Report vulnerabilities privately. Do not open a public issue or pull request for one.

Use GitHub's private vulnerability reporting: open the [Security tab](https://github.com/visplabs/visp-coder/security) of this repository and choose **Report a vulnerability**. The report and the discussion that follows stay private until a fix is published.

Include the VISP version (`visp --version`), your operating system and Node.js version, the host you use (Claude Code, Codex or another), and the steps to reproduce. A minimal repository or the output of `visp doctor --json` helps. Remove secrets from anything you send.

What to expect:

- An acknowledgement within 5 working days.
- A first assessment (accepted, needs more information, or not a vulnerability) within 14 days.
- A fix or a mitigation, and a changelog entry that credits you if you want it, once the report is confirmed. Timing depends on severity and effort; the report will say so if it will take longer than 90 days.

Please give us time to ship a fix before you disclose the issue publicly.

## Supported versions

Only the latest 0.5 beta release of `@visporg/visp-coder` receives security fixes. Upgrade before reporting if you are on an older one.

## Scope

In scope: the `visp` command line, the MCP server it runs, the hooks and generated workflow it installs, `visp ui`, and `visp-runner` when run as documented.

Out of scope:

- Weaknesses in a host (Claude Code, Codex, an editor) or in a model's behaviour that VISP does not control.
- Anything that needs an attacker who already runs code as your account, or who can edit your repository or `.visp/` directory. See the limits below.
- Check commands, browser journeys or product code that a person authorized and that behave as written.
- Findings that apply only to a modified or unreleased build.

## What VISP's trust model promises

VISP coordinates cooperating local processes and checks an agent's work against recorded evidence. The details are in [docs/internals.md](docs/internals.md).

It does promise:

- **One writer at a time.** Every VISP writer in a checkout takes one exclusive lock, and file changes go through recoverable transactions, so an interrupted write is rolled back instead of leaving half-written state.
- **Scope refusals mean the same thing everywhere.** The edit hook, the Git `pre-commit` hook and the CI job all call `visp guard`. When the guard cannot run, the edit hook denies the write and CI fails.
- **Evidence is tied to what it was run against.** A check result records the source, slice contract, environment and VISP build it ran under, and one recorded against an earlier version does not count.
- **The dashboard stays local.** `visp ui` listens on `127.0.0.1` only, signs you in with a per-launch token, checks the request host and origin, and never runs commands.
- **Telemetry stays on your machine.**

It does not promise:

- **Protection from your own account.** The state lock does not stop an editor, a shell command or a hostile process running as you from changing files. Local hashes identify content; they do not authenticate who produced it. That includes your coding agent, which can read and write the same files VISP does.
- **Enforcement the host does not allow.** MCP registration exposes tools; it does not intercept writes. Codex edits through `apply_patch`, which its hooks do not intercept, so for Codex the `pre-commit` hook and `visp done` enforce scope.
- **A hook that cannot be bypassed.** The local hook can be skipped with `git commit --no-verify`. CI is the authoritative check.
- **A sandbox around checks.** MCP tool calls and the checks they launch run in the VISP server process, outside a host's command sandbox and approval flow. Read a check's command before you authorize a slice, especially a new executable or argument vector.
- **Isolation of reviewer sessions from files you can read.** Codex's sandboxes restrict writes, not reads, so a reviewer or tester session can read what your account can read.
- **Recovery from power loss.** Transaction journals are not fsynced; they recover process interruption only.
- **Secrecy of the dashboard link.** Anyone with the link can read the dashboard while it runs. Keep it private.
