// One heavy run (builds, test suites) at a time across all worktrees: a directory created
// atomically under .sdlc/run/. A lock older than `staleMs` is taken over.

import { mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

export function withLock(dir, fn, { waitMs = 20 * 60_000, staleMs = 30 * 60_000 } = {}) {
  mkdirSync(dirname(dir), { recursive: true });
  const start = Date.now();
  while (!tryLock(dir, staleMs)) {
    if (Date.now() - start > waitMs) throw new Error(`another heavy run still holds ${dir}`);
    sleep(2000);
  }
  try {
    return fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function tryLock(dir, staleMs) {
  try {
    mkdirSync(dir);
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (Date.now() - statSync(dir).mtimeMs > staleMs) rmSync(dir, { recursive: true, force: true });
    return false;
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
