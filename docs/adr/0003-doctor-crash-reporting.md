# 0003 Doctor's crash-reporting facts

Status: Accepted
Date: 2026-11-08

## Context

VISP-5 asks `visp doctor` and `visp doctor --json` to say whether crash reporting is on, whether
`VISP_SENTRY_DSN` is set (never its value), which environment reports go to, whether
`VISP_CRASH_LOG` is set and whether its folder is writable, and, when nothing is set, that crash
reports stay on this machine and how to turn reporting on. VISP-7 builds this. Its scope is
`src/telemetry/error-reporting.ts`, a new `src/doctor/crash-reporting.ts` and
`src/cli/commands/doctor.ts`, not `src/doctor/checks.ts`.

What the code does today:

- `src/telemetry/error-reporting.ts` holds the rules. `errorReportingDsn(env)` is exported, but
  the environment default (`VISP_SENTRY_ENVIRONMENT?.trim() || "production"`) is inline in
  `startErrorReporting`, and the crash-log rule (`VISP_CRASH_LOG?.trim()`, blank means no log,
  relative paths resolve from the process's working directory) is inline in `recordCrash`. If
  doctor copies them, the two can drift, and AC-03, AC-08 and AC-10 require them to agree.
- `runChecks` (`src/doctor/checks.ts`, 691 lines, already exempt from the file-size rule) feeds
  three surfaces: `visp doctor`, MCP `visp_doctor` (`src/mcp/tools/diagnose.ts`) and the
  `visp ui` health view (`src/ui/views.ts` `healthView`).
- `withValidationSmoke` (`src/doctor/validation.ts`) already appends one CLI-only row to the
  report after `runChecks` and lifts the verdict. That is the precedent for a row only the CLI
  shows.
- The facts depend on the environment of the process that reads them. The MCP server and the
  UI server run with the host's environment, not the shell where the user runs `visp doctor`.
- No golden snapshot runs doctor. The MCP tool list snapshot holds `visp_doctor`'s description
  only.

Options:

1. **Facts module plus a CLI-only row (chosen).** `src/doctor/crash-reporting.ts` reads the
   facts through rules exported from `error-reporting.ts`. `doctor.ts` puts them in the data and
   appends one `crash reporting` row after the re-check. MCP and UI do not change.
2. **Facts in the data only, no row.** Smaller, and the verdict never changes. But an unwritable
   crash-log folder could not degrade the verdict, and the text would need its own section in
   the doctor action, which is already over the function-size limit.
3. **A check inside `runChecks`.** All three surfaces show it. `checks.ts` grows further and is
   outside the task's scope. It changes the MCP reply agents read (a quality-contract (b) change
   that needs a paired bench batch). An agent told to call `visp_doctor` on a broken install
   would see `degraded` over a crash-log folder. And MCP and UI would report their own server's
   environment, which can differ from the user's shell.

## Decision

**Shared rules.** `src/telemetry/error-reporting.ts` exports two more functions next to
`errorReportingDsn`, and the reporter uses them itself:

- `errorReportingEnvironment(env)`: the trimmed `VISP_SENTRY_ENVIRONMENT` when it is not blank,
  otherwise `"production"`. `startErrorReporting` passes it to `Sentry.init`.
- `crashLogPath(env)`: the trimmed `VISP_CRASH_LOG`, or `undefined` when it is unset or blank.
  `recordCrash` appends to it.

Doctor never reads these variables directly, so doctor and the reporter cannot disagree.

**Facts module.** `src/doctor/crash-reporting.ts` exports:

- `readCrashReporting(env = process.env, cwd = process.cwd()): Promise<CrashReporting>`. The
  folder is the `dirname` of the path `appendFileSync` is given: `crashLogPath(env)` as it is when
  absolute, otherwise `cwd`, a separator and that path. The path is never normalised, because
  `path.resolve` or `path.join` would collapse `missing/..` before the file system is asked, and
  doctor would call writable a folder the writer cannot reach. The OS walks `..` through real
  folders, as it does for the writer. The folder is writable when `stat` says it is a directory
  and `access(folder, W_OK)` succeeds. Any error means not writable. It writes nothing and never
  touches Sentry.
- `withCrashReporting(report, facts): DoctorReport`. This appends the row and lifts a `healthy`
  verdict to `degraded` when the row warns. It never lowers the verdict.

**JSON.** The doctor envelope's `data` gets a `crashReporting` field:

```ts
interface CrashReporting {
  readonly on: boolean;                      // same as dsnSet today
  readonly dsnSet: boolean;                  // errorReportingDsn(env) !== undefined
  readonly environment?: string;             // only when dsnSet
  readonly crashLogSet: boolean;             // crashLogPath(env) !== undefined
  readonly crashLogFolderWritable?: boolean; // only when crashLogSet
  readonly guidance?: string;                // only when !on
}
```

A key is left out when it does not apply, as `recovery` is on a check. When reporting is off,
`guidance` is "Crash reports stay on this machine; set VISP_SENTRY_DSN to send them to your
Sentry project." This also holds when only the crash log is set, because that log is local too.
The type has no field for the DSN, so the JSON and the text cannot print any part of it.

**Row.** `checks` gets one row named `crash reporting`. Its detail is built from the same
`CrashReporting` value:

- `status: "ok"` when reporting is off, and when reporting is on with no crash log or a writable
  folder. Reporting off is not a fault, so there is no `recovery`, and nothing is listed under
  "To fix:".
- `status: "warn"` when `VISP_CRASH_LOG` is set and its folder is not writable. The row has a
  `recovery` that tells the user to point `VISP_CRASH_LOG` at a file in an existing folder they
  can write to, and that relative paths resolve from the folder `visp` runs in. The verdict is
  `degraded` and the exit code stays 0.

`doctor.ts` reads the facts once, after the `--fix` re-check, so `applyFixes` never sees the row
and `--fix` never creates folders. It applies `withCrashReporting` before `withValidationSmoke`
and adds `crashReporting` to the data. The `--runtime-identity` path and error exits do not
change.

**Surfaces.** `runChecks`, MCP `visp_doctor` and the UI health view do not carry it.

## Consequences

- Doctor and the reporter share one rule each for the DSN, the environment and the crash-log
  path. A change to a rule changes both.
- `visp doctor` and MCP `visp_doctor` can now give different verdicts: the CLI says `degraded`
  while MCP says `healthy` when the crash-log folder is not writable. `--check-command` already
  makes them differ in the same way.
- `on` means that `visp`, `visp serve` and `visp-runner` in this environment are set up to send
  reports. It does not describe doctor's own process: after VISP-6, doctor itself sends nothing.
  Doctor does not check that the DSN is well formed or that Sentry can be reached.
- It checks only the folder. A read-only existing log file, or a `VISP_CRASH_LOG` that names a
  directory, still shows as writable. Adding a check for the file later would only add a key.
- Agents see the change only through `visp doctor` output (one more row). The golden suite
  should stay byte-identical. The commit should still say that the CLI text changed.
- VISP-6 also edits `error-reporting.ts`. Whichever task merges second rebases onto the first.
- If MCP or the UI ever need these facts, move the row into `runChecks` with a new record,
  because that changes what agents read.
