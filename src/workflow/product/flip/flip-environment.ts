import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { run } from "../../../core/exec.js";
import { removeTreeBestEffort, sweepStaleTempDirectories } from "../../../core/stale-temp.js";

const ENVIRONMENTS = ["node_modules", ".venv", "venv", "vendor"];
// VISP's own state is never an input a check reads, so it is not copied.
const PRIVATE_STATE = ".visp";
const GIT_ENV = { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
// Caches a run regenerates: a comparison may rebuild them, so they are not local state.
const REGENERABLE_DIRECTORIES = new Set([
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
  "htmlcov",
  ".cache",
  ".parcel-cache",
  "coverage",
  "dist",
  "build",
]);
const REGENERABLE_FILE = /^(?:\.coverage(?:\..+)?|\.DS_Store)$|\.pyc$/;
/**
 * Python bytecode caches name their source by absolute path in bytes that cannot be rebased.
 * The comparison's interpreter rebuilds them from the tree's own sources, so they are neither
 * copied nor counted as state the comparison lacks.
 */
const BYTECODE_CACHE = /(?:^|\/)__pycache__$|\.py[co]$/;
// Flip temporary trees a crashed run left behind: the same names and age bound as reviewer runs.
const FLIP_TEMPORARY = [
  /^visp-product-flip-[A-Za-z0-9]{6}$/,
  /^visp-flip-environment-[A-Za-z0-9]{6}$/,
];
const STALE_FLIP_MS = 60 * 60_000;
// Bound both the pre-run snapshot and its private comparison copy. Reflinks are optional;
// these bounds also keep ordinary-copy disk usage and advisory latency manageable.
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const MAX_MS = 15_000;
export interface FlipEnvironment {
  directory?: string;
  origins?: Record<string, string>;
  /** Regenerable git-ignored entries captured with the environment roots, project-relative. */
  entries?: string[];
  durationMs?: number;
  reason?: string;
}

/** Removes flip temporary trees that a crashed run left, before another one is created. */
export function sweepStaleFlipTemporary() {
  return sweepStaleTempDirectories(FLIP_TEMPORARY, STALE_FLIP_MS);
}

const LOCAL_STATE = "the project has git-ignored local state the comparison cannot reproduce";

function localStateReason(paths: string[]) {
  return `${LOCAL_STATE}: ${paths.slice(0, 3).join(", ")}`;
}

/**
 * Git-ignored entries outside VISP's state and the top-level environment roots, as git lists them
 * (a directory wholly ignored is listed once, collapsed).
 */
async function ignoredEntries(root: string): Promise<string[]> {
  const listed = await run(
    "git",
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
    { cwd: root, env: GIT_ENV, timeoutMs: 30000 },
  );
  if (!listed.ok || listed.value.exitCode !== 0 || listed.value.timedOut)
    throw new Error("git-ignored local state could not be listed");
  const names = new Set(
    listed.value.stdout
      .split("\0")
      .filter(Boolean)
      .map((entry) => entry.replace(/\/$/, "")),
  );
  return [...names]
    .filter((name) => {
      const top = name.split("/")[0] ?? "";
      return top !== PRIVATE_STATE && !ENVIRONMENTS.includes(top) && !BYTECODE_CACHE.test(name);
    })
    .sort();
}

/**
 * A regenerable cache or build output, matched by whole path segments of the entry as git lists
 * it. Such an entry is copied into the comparison, so the check finds what it finds in the project.
 */
function regenerable(name: string) {
  const segments = name.split("/");
  if (REGENERABLE_FILE.test(segments[segments.length - 1] ?? "")) return true;
  return segments.some(
    (segment, index) =>
      REGENERABLE_DIRECTORIES.has(segment) ||
      segment.endsWith(".egg-info") ||
      (segment === ".next" && segments[index + 1] === "cache"),
  );
}

/**
 * Why a comparison cannot start from the user's starting state, or undefined when it can. With no
 * pre-run snapshot, any git-ignored entry is state the comparison would not reproduce.
 */
export async function unsnapshottedFlipState(root: string): Promise<string | undefined> {
  for (const name of ENVIRONMENTS)
    if (await environmentStat(join(root, name)))
      return `environment ${name} has no isolated pre-run snapshot; original starting state unavailable`;
  const ignored = await ignoredEntries(root);
  return ignored.length ? localStateReason(ignored) : undefined;
}

/**
 * Captures the pre-run starting state: environment roots and regenerable ignored entries, within
 * the byte, entry and time bounds. Any other git-ignored entry blocks the comparison. Never throws:
 * a failed capture, or state a comparison cannot reproduce, is a reason.
 */
export async function captureFlipEnvironment(root: string): Promise<FlipEnvironment> {
  const started = Date.now();
  let directory: string | undefined;
  try {
    await sweepStaleFlipTemporary();
    const ignored = await ignoredEntries(root);
    const blocking = ignored.filter((name) => !regenerable(name));
    if (blocking.length)
      return { reason: localStateReason(blocking), durationMs: Date.now() - started };
    directory = await mkdtemp(join(tmpdir(), "visp-flip-environment-"));
    const origins: Record<string, string> = {};
    await copyEnvironments(root, directory, root, root, origins, [...ENVIRONMENTS, ...ignored]);
    return { directory, origins, entries: ignored, durationMs: Date.now() - started };
  } catch (cause) {
    if (directory) await removeTreeBestEffort(directory);
    return {
      reason: cause instanceof Error ? cause.message : String(cause),
      durationMs: Date.now() - started,
    };
  }
}

export async function disposeFlipEnvironment(environment: FlipEnvironment | undefined) {
  if (environment?.directory) await removeTreeBestEffort(environment.directory);
}

export async function provideFlipEnvironment(
  root: string,
  tree: string,
  environment?: FlipEnvironment,
) {
  if (environment?.reason) throw new Error(environment.reason);
  if (!environment?.directory) {
    const missing = await unsnapshottedFlipState(root);
    if (missing) throw new Error(missing);
    return;
  }
  // The original run may have created ignored state the snapshot never held; a comparison
  // would not have it, so it cannot stand in for the user's tree.
  const held = new Set(environment.entries ?? []);
  const appeared = (await ignoredEntries(root)).filter((name) => !held.has(name));
  if (appeared.length) throw new Error(localStateReason(appeared));
  await copyEnvironments(environment.directory, tree, root, tree, environment.origins ?? {}, [
    ...ENVIRONMENTS,
    ...(environment.entries ?? []),
  ]);
}

async function environmentStat(path: string) {
  try {
    return await lstat(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

type Budget = { bytes: number; entries: number; started: number };
interface PathMapping {
  source: string;
  logical: string;
}
interface CopyContext {
  project: string;
  rebound: string;
  budget: Budget;
  mappings: readonly PathMapping[];
  ancestors: ReadonlySet<string>;
  /** Every spelling of the project root, as bytes: rebased in copied text, refused in UTF-16. */
  needles: RootNeedles;
}

async function copyEnvironments(
  source: string,
  destination: string,
  project: string,
  rebound: string,
  origins: Record<string, string>,
  names: readonly string[],
) {
  const budget = { bytes: 0, entries: 0, started: Date.now() };
  const needles = await projectNeedles(project);
  for (const name of [...new Set(names)])
    await copyEnvironmentRoot(name, {
      source,
      destination,
      project,
      rebound,
      origins,
      budget,
      needles,
    });
}

async function copyEnvironmentRoot(
  name: string,
  options: {
    source: string;
    destination: string;
    project: string;
    rebound: string;
    origins: Record<string, string>;
    budget: Budget;
    needles: RootNeedles;
  },
) {
  const { source, destination, project, rebound, origins, budget, needles } = options;
  const input = join(source, name);
  const stat = await environmentStat(input);
  if (!stat) return;
  const logical = join(project, name);
  const actual = stat.isSymbolicLink() ? await realpath(input) : input;
  const original = source === project ? actual : (origins[name] ?? logical);
  const canonical =
    source === project && contained(project, actual) ? actual : (origins[name] ?? logical);
  if (canonical === project || relative(project, canonical).split(/[\\/]/).includes(".git"))
    throw new Error(`environment ${name} aliases project control data and cannot be isolated`);
  if (source === project) origins[name] = canonical;
  const target =
    source === project ? join(destination, name) : join(destination, relative(project, canonical));
  const context: CopyContext = {
    project,
    rebound,
    budget,
    ancestors: new Set(),
    mappings: source === project ? [{ source: actual, logical: canonical }] : [],
    needles,
  };
  // Keep a project-internal root alias at its canonical private path, so baseline
  // overlays of tracked packages also update the bytes loaded through the environment.
  await rm(target, { recursive: true, force: true });
  await copyEntry(actual, target, original, context);
  if (source !== project && canonical !== logical) {
    const alias = join(destination, name);
    await rm(alias, { recursive: true, force: true });
    await symlink(relative(dirname(alias), target), alias);
  }
}

function checkBudget(budget: Budget) {
  if (
    budget.bytes > MAX_BYTES ||
    budget.entries > MAX_ENTRIES ||
    Date.now() - budget.started > MAX_MS
  )
    throw new Error("environment isolation exceeds 512 MiB, 100000 entries or 15 seconds per copy");
}

function contained(root: string, path: string) {
  const local = relative(root, path);
  return (
    local !== ".." &&
    !local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(local)
  );
}
function logicalPath(path: string, mappings: readonly PathMapping[]) {
  for (let index = mappings.length - 1; index >= 0; index--) {
    const mapping = mappings[index] as PathMapping;
    if (contained(mapping.source, path))
      return join(mapping.logical, relative(mapping.source, path));
  }
  return path;
}

async function copyEntry(source: string, target: string, original: string, context: CopyContext) {
  const { budget } = context;
  budget.entries++;
  checkBudget(budget);
  // An ignored file can sit in a directory the tree tracks, which the copy has not created yet.
  await mkdir(dirname(target), { recursive: true });
  const stat = await lstat(source);
  if (stat.isSymbolicLink()) {
    await copyEnvironmentLink(source, target, original, context);
  } else if (stat.isDirectory()) {
    await mkdir(target, { recursive: true });
    for (const name of await readdir(source))
      await copyEntry(join(source, name), join(target, name), join(original, name), context);
    await chmod(target, stat.mode & 0o777);
  } else if (stat.isFile()) {
    budget.bytes += stat.size;
    checkBudget(budget);
    await copyRelocatedFile(source, target, original, stat.mode, context);
    await rewriteEmbeddedPaths(target, source, stat.size, context);
  } else throw new Error(`environment isolation cannot copy special file ${original}`);
  checkBudget(budget);
}

async function copyEnvironmentLink(
  source: string,
  target: string,
  original: string,
  context: CopyContext,
) {
  const link = await readlink(source);
  const resolved = resolve(dirname(original), link);
  const logical = logicalPath(resolved, context.mappings);
  if (contained(context.project, logical)) {
    const rebound = join(context.rebound, relative(context.project, logical));
    const value = isAbsolute(link)
      ? rebound
      : relative(dirname(logicalPath(original, context.mappings)), logical);
    await symlink(value, target);
    return;
  }
  // External targets are copied too; no writable link may escape the comparison tree.
  const external = await realpath(source);
  if (context.ancestors.has(external))
    throw new Error(`environment isolation cannot reproduce cyclic link ${original}`);
  await copyEntry(external, target, external, {
    ...context,
    ancestors: new Set([...context.ancestors, external]),
    mappings: [
      ...context.mappings,
      { source: external, logical: logicalPath(original, context.mappings) },
    ],
  });
}

async function boundedEnvironmentText(path: string, size: number, metadata: boolean) {
  if (size <= 1024 * 1024) {
    const bytes = await readFile(path);
    return bytes.includes(0) ? undefined : bytes.toString("utf8");
  }
  // Large interpreters are binary. Large editable-install metadata or text launchers
  // cannot be rebound with bounded memory, so decline rather than keep original paths.
  if (!metadata) {
    const file = await open(path, "r");
    try {
      const header = Buffer.alloc(4096);
      const read = await file.read(header, 0, header.length, 0);
      if (header.subarray(0, read.bytesRead).includes(0)) return undefined;
    } finally {
      await file.close();
    }
  }
  throw new Error(`environment isolation exceeds 1 MiB text metadata limit: ${path}`);
}

async function rewriteEmbeddedPaths(
  target: string,
  source: string,
  size: number,
  context: CopyContext,
) {
  // Project roots are rebased for every copied text file (copyRelocatedFile); only moved external
  // link targets need the metadata rewrite here.
  const moved = context.mappings.filter((mapping) => mapping.source !== mapping.logical);
  if (moved.length === 0) return;
  const metadata = /\.(?:pth|egg-link|py|cfg)$/.test(source);
  if (!metadata && !/[/\\](?:\.bin|bin)[/\\]/.test(source)) return;
  const text = await boundedEnvironmentText(target, size, metadata);
  if (text === undefined) return;
  let rebound = text;
  for (const mapping of [...moved].reverse())
    rebound = rebound.replaceAll(mapping.source, mapping.logical);
  if (rebound !== text) await writeFile(target, rebound);
}

/** Bytes per step of a scan or rebase. A spelling of the root can straddle a step, so each keeps its tail. */
const REBASE_STEP_BYTES = 1024 * 1024;
const NAME_BYTE = /[A-Za-z0-9_.-]/;

/** Every spelling of the project root by which a file can name the project: as given, and as the OS resolves it. */
export async function projectRootForms(root: string): Promise<string[]> {
  const real = await realpath(root).catch(() => root);
  return [...new Set([root, real])];
}

/**
 * The bytes by which a file can name the project root. UTF-8 spellings are rewritten to the
 * comparison; UTF-16 spellings (either byte order) are never rewritten, so a file holding one makes
 * the comparison unchecked.
 */
export interface RootNeedles {
  utf8: Buffer[];
  wide: Buffer[];
}

export async function projectNeedles(root: string): Promise<RootNeedles> {
  const forms = await projectRootForms(root);
  return {
    utf8: forms.map((form) => Buffer.from(form)),
    wide: forms.flatMap((form) => {
      const little = Buffer.from(form, "utf16le");
      return [little, Buffer.from(little).swap16()];
    }),
  };
}

interface Window {
  output: Buffer;
  consumed: number;
  reference: boolean;
}

/** A name character, when the byte exists: a root beside one is part of a longer path. */
function isName(byte: number | undefined) {
  return byte !== undefined && NAME_BYTE.test(String.fromCharCode(byte));
}

/**
 * One step over `data`: every spelling of the root that starts before `cut` and stands at a path
 * boundary on both sides (neither neighbouring byte is a name character; `prior` is the byte before
 * `data`). With a replacement the output rewrites each one; `consumed` is how much of `data` the
 * output covers, and the rest waits for the next step.
 */
function rebaseWindow(
  data: Buffer,
  cut: number,
  needles: readonly Buffer[],
  replacement?: Buffer,
  prior?: number,
): Window {
  const pieces: Buffer[] = [];
  let copied = 0;
  let search = 0;
  let reference = false;
  for (
    let next = nextSpelling(data, search, cut, needles);
    next;
    next = nextSpelling(data, search, cut, needles)
  ) {
    const { at, length } = next;
    if (isName(at > 0 ? data[at - 1] : prior) || isName(data[at + length])) {
      search = at + 1;
      continue;
    }
    reference = true;
    if (replacement) pieces.push(data.subarray(copied, at), replacement);
    copied = search = at + length;
  }
  const consumed = Math.max(copied, cut);
  if (replacement) pieces.push(data.subarray(copied, consumed));
  return { output: Buffer.concat(pieces), consumed, reference };
}

/** The earliest spelling of the root at or after `from` that starts before `cut`. */
function nextSpelling(
  data: Buffer,
  from: number,
  cut: number,
  needles: readonly Buffer[],
): { at: number; length: number } | undefined {
  let best: { at: number; length: number } | undefined;
  for (const needle of needles) {
    const found = data.indexOf(needle, from);
    if (found >= 0 && found < cut && (!best || found < best.at))
      best = { at: found, length: needle.length };
  }
  return best;
}

function containsAny(data: Buffer, needles: readonly Buffer[]) {
  return needles.some((needle) => data.indexOf(needle) >= 0);
}

export interface RebaseScan {
  bytes: number;
  binary: boolean;
  /** A UTF-8 spelling of the root at a path boundary. */
  reference: boolean;
  /** A UTF-16 spelling of the root anywhere in the file. */
  wide: boolean;
}

/**
 * Reads a file once, in steps, through every spelling of the project root. With a replacement and
 * a sink, text (no NUL byte) is streamed out with each UTF-8 root rewritten; a binary file is only
 * searched. Any size works: a match that straddles a step is found because each step keeps its tail.
 */
async function scanAndRebase(
  source: string,
  needles: RootNeedles,
  replacement?: Buffer,
  sink?: (bytes: Buffer) => Promise<void>,
): Promise<RebaseScan> {
  const longest = Math.max(...needles.utf8.map((needle) => needle.length));
  const probeWide = wideProbe(needles);
  const scan: RebaseScan = { bytes: 0, binary: false, reference: false, wide: false };
  const state: { carry: Buffer; prior?: number } = { carry: Buffer.alloc(0) };
  const file = await open(source, "r");
  try {
    for (;;) {
      const step = Buffer.alloc(REBASE_STEP_BYTES);
      const { bytesRead } = await file.read(step, 0, REBASE_STEP_BYTES, null);
      const raw = step.subarray(0, bytesRead);
      scan.bytes += bytesRead;
      scan.binary ||= raw.includes(0);
      scan.wide ||= probeWide(raw);
      const data = Buffer.concat([state.carry, raw]);
      const window = rebaseWindow(
        data,
        stepCut(data.length, bytesRead === 0, longest),
        needles.utf8,
        replacement,
        state.prior,
      );
      scan.reference ||= window.reference;
      if (replacement && sink && !scan.binary && window.output.length) await sink(window.output);
      state.prior = window.consumed > 0 ? data[window.consumed - 1] : state.prior;
      state.carry = data.subarray(window.consumed);
      if (bytesRead === 0) return scan;
    }
  } finally {
    await file.close();
  }
}

/**
 * Where a step's decisions end: a match that starts before the cut ends, and its neighbouring bytes
 * are read, within the data. At the end of the file everything is decided.
 */
function stepCut(length: number, eof: boolean, longest: number) {
  return eof ? length : Math.max(0, length - (longest + 1));
}

/**
 * Finds a UTF-16 spelling of the root in each step's raw bytes. The bytes of the previous step that
 * a spelling can straddle are kept, so a spelling across a step boundary is found.
 */
function wideProbe(needles: RootNeedles) {
  const keep = Math.max(0, Math.max(0, ...needles.wide.map((needle) => needle.length)) - 1);
  let tail = Buffer.alloc(0);
  return (raw: Buffer): boolean => {
    const probe = Buffer.concat([tail, raw]);
    tail = probe.subarray(Math.max(0, probe.length - keep));
    return containsAny(probe, needles.wide);
  };
}

/** Searches a project file for any spelling of the root, in steps: the snapshot's scan. */
export function scanProjectFile(source: string, needles: RootNeedles): Promise<RebaseScan> {
  return scanAndRebase(source, needles);
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, bytes: Buffer) {
  for (let written = 0; written < bytes.length; ) {
    const { bytesWritten } = await handle.write(bytes, written, bytes.length - written);
    written += bytesWritten;
  }
}

/** Rebases one file into `target` as it is read, so the text is read once. */
async function rebaseTo(
  source: string,
  target: string,
  needles: RootNeedles,
  replacement: Buffer,
): Promise<RebaseScan> {
  const out = await open(target, "w");
  try {
    return await scanAndRebase(source, needles, replacement, (bytes) => writeAll(out, bytes));
  } finally {
    await out.close();
  }
}

function namesProject(path: string) {
  return new Error(
    `${path} refers to the project by absolute path; the comparison could change the project`,
  );
}

/**
 * Copies one regular file into the comparison tree. Text has every UTF-8 spelling of the project
 * root rewritten to the tree's root, at any size, so the copy names the comparison rather than the
 * user's project. A UTF-16 spelling, or a binary file holding a UTF-8 one, cannot be rewritten and
 * makes the comparison unchecked. Other binary bytes are copied as they are.
 */
async function copyRelocatedFile(
  source: string,
  target: string,
  original: string,
  mode: number,
  context: CopyContext,
) {
  if (context.rebound === context.project) {
    await copyFile(source, target, constants.COPYFILE_FICLONE);
    return;
  }
  const scan = await rebaseTo(source, target, context.needles, Buffer.from(context.rebound));
  if (scan.wide || (scan.binary && scan.reference))
    throw namesProject(relative(context.project, original));
  if (scan.binary) await copyFile(source, target);
  await chmod(target, mode & 0o777);
}

/**
 * The bytes an overlay writes into the comparison tree. They are relocated like a copied file: text
 * is rebased, binary bytes without a UTF-8 reference are kept, and bytes that cannot be rebased (a
 * UTF-16 spelling, or binary with a UTF-8 reference) throw the reason the comparison reports.
 */
export function relocatedBytes(
  path: string,
  bytes: Uint8Array,
  needles: RootNeedles,
  replacement: Buffer,
): Buffer {
  const data = Buffer.from(bytes);
  if (containsAny(data, needles.wide)) throw namesProject(path);
  const window = rebaseWindow(data, data.length, needles.utf8, replacement);
  if (!data.includes(0)) return window.output;
  if (window.reference) throw namesProject(path);
  return data;
}

export function reboundFlipEnvironment(
  environment: Record<string, string> | undefined,
  root: string,
  tree: string,
) {
  return (
    environment &&
    Object.fromEntries(
      Object.entries(environment).map(([name, value]) => [name, value.replaceAll(root, tree)]),
    )
  );
}
