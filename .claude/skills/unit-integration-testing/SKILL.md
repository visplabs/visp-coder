---
name: unit-integration-testing
description: 'How coders in visp-coder write unit and integration tests: test-first, every branch of the changed code, fast targeted runs, and linking tests to acceptance criteria. Rule ids UT-01... Use when adding or changing code and its tests.'
---

# Unit and integration testing

## Rules

- **UT-01 Test first.** For a bug, write the failing test that reproduces it and watch it fail
  before the fix. For a feature, write the test for each criterion first.
- **UT-02 Every branch.** Each `if`, `switch` case, early return, `catch` and loop edge (zero,
  one, many) of the code you change has a test that takes it. Error paths count.
- **UT-03 Unit or integration.** Unit tests call pure functions directly. Integration tests run
  the real thing across a boundary: the built CLI, a child process, the file system in a
  temporary directory, a hook fed JSON on stdin.
- **UT-04 Isolated and repeatable.** Use `mkdtempSync(join(tmpdir(), ...))` and remove it after;
  never write into the repository, `~`, or a shared path. No network, no sleeps for timing, no
  dependence on test order.
- **UT-05 Names state behaviour**: `it("refuses a coder whose transcript names no task")`, not
  `it("works")`. One behaviour per test; several asserts are fine when they describe it.
- **UT-06 Assert outcomes, not internals.** Check what a caller can see (return value, exit
  code, written file, output), not private calls.
- **UT-07 Golden snapshots** (`tests/golden/`) change only for agent-facing work, and the commit
  says "Kind (b)". Never run `vitest -u` to make a failure go away.

## Where tests go

`src/core/X.ts` → `tests/unit/core/X.test.ts`; `src/workflow/product/X.ts` →
`tests/unit/workflow/evidence/product-X.test.ts`; `scripts/sdlc/...` → `tests/unit/sdlc/`.
Fixtures live in `tests/fixtures/`.

## The loop

```sh
pnpm build:fast                    # after any change to src/, package.json or configs
pnpm exec vitest run $(node scripts/direct-tests.mjs src/x.ts) --bail=1 -t "<name>"
```

Never `vitest related` or `--changed`: they select hundreds of files. Leave the full suite to CI.

## Linking to criteria

In your handoff, link each criterion to a test as `<path> > <describe titles> > <test title>`,
exactly as vitest names it, so `pnpm sdlc trace` can find its result.
