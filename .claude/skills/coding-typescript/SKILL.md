---
name: coding-typescript
description: 'TypeScript and JavaScript rules for visp-coder: strict types, small single-purpose modules and functions, explicit errors, and the repository''s idioms. Each rule has an id (TS-01...) that reviews cite. Use when writing or reviewing code in src/, scripts/ or tests/.'
---

# Coding rules (TypeScript and JavaScript)

Each rule has an id. A reviewer's blocking finding may cite it with a command that shows the
breach; Biome or `tsc` enforce the rules marked (tool).

## Types and safety

- **TS-01 Strict always.** `tsconfig.json` is `strict` with `noUncheckedIndexedAccess`; never
  loosen it, never add `// @ts-ignore` or `@ts-expect-error` without a one-line reason. (tool)
- **TS-02 No `any`, no non-null `!`.** Use `unknown` and narrow it, or a precise type. (tool)
- **TS-03 Validate at the boundary.** Data from files, processes, the network or users is
  parsed with a zod schema where it enters; inside, trust the types.
- **TS-04 Explicit errors.** Throw or return `VispError` (`src/core/errors.ts`) with a code and,
  where one exists, the exact recovery command. Never swallow an error; a `catch` either handles
  the case it names or rethrows.
- **TS-05 Node built-ins** are imported as `node:fs`, `node:path`, ... (tool)

## Structure

- **TS-10 Small files.** A file in `src/` or `scripts/sdlc/` stays under 400 lines; split by
  responsibility before it grows. (tool, Biome `noExcessiveLinesPerFile`)
- **TS-11 Small functions.** Under 80 lines and cognitive complexity 15; extract named helpers
  instead of nesting. (tool)
- **TS-12 One responsibility per module.** A module's top comment says what it is for in one or
  two sentences; if it needs "and", it is two modules.
- **TS-13 Thin adapters.** CLI (`src/cli/`) and MCP (`src/mcp/`) only translate; decisions and
  data shapes live in `src/workflow/product/`. A behaviour change goes there, with tests for both
  surfaces.
- **TS-14 No dead code, no cycles.** Delete what nothing uses instead of ignoring it in knip; add
  no import cycles. (tool, `pnpm knip`)
- **TS-15 No new dependency** without the owner's decision.

## Readability

- **TS-20 Match the surrounding code**: naming, comment density, idiom. Comments say why, not
  what; prose is plain and short.
- **TS-21 Names say what a thing is**, not how it is built: `changedFiles`, not `getList2`.
- **TS-22 Pure core, effects at the edge.** Keep parsing and decisions in pure functions that
  tests can call; keep file, process and network calls in a thin outer layer.
- **TS-23 Algorithms.** Choose data structures for the real sizes (a `Set` for membership, not
  `Array.includes` in a loop over large inputs); say the cost in a comment when it is not obvious.

## Before you report

`pnpm build:fast`, the covering tests (`node scripts/direct-tests.mjs <file>`), `pnpm lint`,
`pnpm typecheck`, and `pnpm knip` when you removed or moved exports.
