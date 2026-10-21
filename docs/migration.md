# Migration

Upgrading VISP never rewrites saved history implicitly. Projects with records from an older release are upgraded explicitly with the standalone `visp-migrate` executable, which takes a backup in the same transaction as the upgrade.

## Upgrading a project

1. Stop every running VISP CLI and MCP process for the project.
2. Preserve a copy of `visp.yml` and remove any [retired configuration keys](#removed-configuration-keys). A configuration that still contains them fails to load with `CONFIG_INVALID` naming each key.
3. Preview, export and apply:

```sh
visp-migrate --project . preview
visp-migrate --project . export --name before-upgrade
visp-migrate --project . apply
```

4. Reinstall host assets with `visp install` and restart the MCP server with the new executable. Installing a package does not replace a server that is already running.

`preview` changes nothing and does not recover interrupted transactions. `--feature <id>` limits `preview` or `apply` to one feature.

`export` writes `.visp/exports/<name>.json` with the exact bytes, permissions and SHA-256 hashes of `visp.yml`, `.gitignore` and the non-derived parts of `.visp/`, plus a manifest digest. Backups and exports exclude ignored session prompts, installation state, graph databases and their WAL files, caches, captures and candidates. It does not need a valid configuration or parseable records, refuses to overwrite an existing export, and refuses symlinks and special files rather than producing an incomplete copy. Limits: 10,000 entries, 64 directory levels, 32 MiB per file and 256 MiB in total. There is no automated restore; the export is for preservation and inspection.

`apply` recovers interrupted VISP transactions, plans the upgrade, then writes a raw backup to `.visp/migrations/backups/<digest>.json` and the upgraded records in one transaction. If it is interrupted, run it again to recover and retry. Repeating it is harmless. It refuses while a critic review is pending.

What `apply` does:

- **Legacy stage-workflow features** (spec, plan and tasks files) become product briefs. IDs and requirements carry over; old artifacts and evidence stay as history. A slice's `taskClass` is kept only if the original task recorded one.
- **Product state version 2** is upgraded to version 3. Version-2 projects cannot run ordinary product commands until migrated. Briefs and evidence receipts keep their versions.
- **Finding identities.** Old findings with the same ID in different slices become distinct scoped findings. The mapping is saved as `finding-identity-migration.json`. If a recovered required finding is still open, affected closed slices return to pending and an accepted feature loses its current acceptance; the previous acceptance stays in the backup and the report.
- **Critic spending.** Historical critic attempts are adopted into a per-feature ledger, `critic-budget.json`. Every recorded attempt counts, including uncertain ones, and each reserves its full timeout.

Historical completion is not relabeled as current verification. Features that were in progress need a fresh `visp work` and current evidence; features marked `historical-complete` stay historical, so start a new feature for fresh work. Do not edit the state version, remove the upgrade marker or copy old state over an upgraded project; that can roll back evidence and spending.

`visp migrate [--feature <id>] [--dry-run]` remains in the main CLI for converting a legacy feature. It refuses history upgrades that need a backup and points to `visp-migrate`.

Preview reports invalid artifacts per feature with their paths and recovery hints, while continuing to inspect unaffected features. Apply remains atomic and refuses invalid selected history; use `apply --feature <id>` to migrate unaffected features individually.

## Removed in 0.5

### Commands and tools

| Removed | Use instead |
| --- | --- |
| CLI `research`, `spec`, `plan`, `tasks` and their MCP tools | `visp brief` |
| CLI `context` and MCP `visp_context` | `visp work` (`--inspect` for read-only context) |
| CLI `gate` and MCP `visp_gate` | `visp work`, `visp next`, `visp accept` |
| CLI `observe`, `save`, `checkpoint` | Declared checks and `visp capture` |
| CLI `probe` | Browser-journey checks |
| CLI `evidence compact`, `evidence archive`, `evidence restore` | None; existing files are left in place |
| MCP `visp_pr`, `visp_handoff`, `visp_migrate`, `visp_control` | CLI `visp pr`, `visp handoff`, `visp migrate`, `visp control` |
| MCP resources for spec, plan, tasks and context | `visp://feature/{id}/brief` |
| `visp critic --disable` (per task) | `visp critic --off` for the whole feature |

### Library exports

| Removed | Replacement |
| --- | --- |
| `authorizeImplement(state, feature, taskId)` | `runProductWork(state, {feature, task})` |
| `buildContextPack(state, {feature, taskId})` | `runProductContext` to inspect, `runProductWork` to authorize |
| `runProductAcceptance(state, feature)` | `runProductAccept(state, {feature})` |
| `buildGateContext`, `evaluateGate` | `runProductContext`, `runProductNext`, `runProductStatus` |
| `renderGateResult` | `runProductReport` |
| `proposeFailureSkills` | None: project skills were removed after 0.5.0-beta.4 |

Obtain state with `loadWorkspace(root)` before calling these services. A historical gate decision cannot be re-evaluated under current rules; keep an old installation if you need to reproduce one.

### Removed configuration keys

Remove these from `visp.yml` (and the critic keys from `~/.config/visp/critic-defaults.json`) before upgrading. None of them had an effect on the product loop:

| Key | Note |
| --- | --- |
| `critic.maxOutputTokens`, `critic.maxInputCharacters` | Never enforced; the host owns token limits |
| `context.ranking`, `context.snippetCap`, `context.maxSnippetLines`, `context.includeSnippets`, `context.maxRegionsPerFile` | Keep `tokenBudget` and `maxSnippets` |
| `graph.queryDepth`, `graph.queryResults` | Use `visp query --depth` / `--results` per request |
| `workflow.maxSourceFileLines`, `workflow.maxSourceLineChars` | Keep `maxChangedFiles` |
| `workflow.requireTests` | Declare checks in the brief; the check gate requires them for functional outcomes |

Historical records that contain the critic keys stay readable.

## What stays readable

Old review submissions (the template envelope with `subjectDigest`, `selection`, `feedback`, `coverage` and `reviewer`) are still accepted and parsed. Accepted features keep their recorded review policy while unchanged; reopened work needs current assessments. Historical schemas, observation readers and `visp observations --criterion <id>` remain available for inspecting preserved evidence, and read-only reports never rewrite historical bytes.

## Upgrade qualification scripts

For maintainers, these scripts exercise upgrades from published releases in disposable directories. They never touch the global installation.

```sh
pnpm build
node scripts/upgrade-smoke.mjs <path-to-installed-0.4.0-beta.1-visp>
node scripts/verify-published-predecessor.mjs 0.4.0-beta.3 <path-to-visp-coder-0.4.0-beta.3.tgz>
node scripts/upgrade-published-spending.mjs <path-to-visp-coder-0.4.0-beta.3.tgz>
```

`upgrade-smoke.mjs` migrates a project created by the old executable, checks that history, configuration and evidence bytes are preserved, that the old MCP process refuses the new state, and that an apply killed mid-transaction recovers. `verify-published-predecessor.mjs` checks a release archive against its recorded digest. `upgrade-published-spending.mjs` checks that critic spending recorded by the old release is carried into the new ledger. These scripts qualify the pinned releases only.
