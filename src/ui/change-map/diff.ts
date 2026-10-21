import { isUtf8 } from "node:buffer";
import { vispError } from "../../core/errors.js";
import { run } from "../../core/exec.js";
import { ProjectFileSystem } from "../../core/fs.js";
import { sha256 } from "../../core/hash.js";
import { privatePath } from "../../core/redaction.js";
import { err, ok, type Result } from "../../core/result.js";
import type { UiChangeMap, UiMapFile, UiMapHunk } from "../contract.js";

/** Read-only git: no pager, optional locks, hooks or fsmonitor, as the other git reads do. */
const GIT_ENV = { GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" };
const GIT_CONFIG = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
const MAX_FILES = 200;
export const MAX_HUNK_LINES = 120;
const MAX_UNTRACKED_BYTES = 1024 * 1024;
const REF = /^(?!-)[A-Za-z0-9._/@^~{}:-]{1,200}$/;
const INSTRUCTION_FILES = /(^|\/)(?:AGENTS\.md|CLAUDE\.md|visp\.ya?ml)$/i;

export type MapBase = UiChangeMap["base"];
export type MapEnd = UiChangeMap["end"];

/** A hunk as parsed, before the page's line limit, with what the map needs from all of it. */
export interface ParsedHunk extends UiMapHunk {
  /** New-side line numbers of every added line, including ones past the shown limit. Blank lines only when nothing else changed. */
  readonly addedAt: readonly number[];
  /** For each removed line, the new-side line it sat before. */
  readonly removedAt: readonly number[];
  /** Digest of the whole hunk text. */
  readonly digest: string;
}

export interface ParsedFile extends Omit<UiMapFile, "hunks"> {
  readonly hunks: readonly ParsedHunk[];
}

export interface FeatureDiff {
  readonly files: ParsedFile[];
  /** Changed files beyond the file limit. */
  readonly omittedFiles: number;
  /** Changed files left out as secrets, blocked paths or instruction files; `.visp/` is never counted. */
  readonly hiddenFiles: number;
  readonly notes: string[];
}

async function git(root: string, args: readonly string[]): Promise<Result<string>> {
  const result = await run("git", [...GIT_CONFIG, ...args], {
    cwd: root,
    env: GIT_ENV,
    timeoutMs: 30_000,
  });
  if (!result.ok) return result;
  // `git diff` exits 1 only with --exit-code, which is never passed.
  if (result.value.exitCode !== 0)
    return err(
      vispError("COMMAND_FAILED", `git ${args[0]} failed: ${result.value.stderr.trim()}`.trim()),
    );
  return ok(result.value.stdout);
}

/** The start of the diff: an explicit ref, the feature's first recorded commit's parent, or HEAD. */
export async function resolveBase(
  root: string,
  briefPath: string,
  explicit: string | undefined,
): Promise<Result<MapBase>> {
  if (explicit !== undefined) {
    if (!REF.test(explicit))
      return err(vispError("ARTIFACT_INVALID", `Not a git revision: ${explicit}`));
    const commit = await git(root, ["rev-parse", "--verify", "--quiet", `${explicit}^{commit}`]);
    if (!commit.ok)
      return err(
        vispError("ARTIFACT_MISSING", `git does not know the revision ${explicit}`, {
          recovery: `git rev-parse --verify ${explicit}`,
        }),
      );
    return ok({ ref: explicit, commit: commit.value.trim(), how: "explicit" });
  }
  const added = await git(root, [
    "log",
    "--diff-filter=A",
    "--format=%H",
    "--reverse",
    "--",
    briefPath,
  ]);
  const first = added.ok ? added.value.split("\n")[0]?.trim() : undefined;
  if (!first) {
    const head = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    return head.ok
      ? ok({ ref: "HEAD", commit: head.value.trim(), how: "head" })
      : emptyTree(root, "HEAD");
  }
  const parent = await git(root, ["rev-parse", "--verify", "--quiet", `${first}^`]);
  if (!parent.ok) return emptyTree(root, `${first.slice(0, 12)}^`);
  return ok({ ref: `${first.slice(0, 12)}^`, commit: parent.value.trim(), how: "feature-start" });
}

async function emptyTree(root: string, ref: string): Promise<Result<MapBase>> {
  // Hashing without -w names the empty tree in this repository's object format and writes nothing.
  const tree = await git(root, ["hash-object", "-t", "tree", "/dev/null"]);
  if (!tree.ok) return tree;
  return ok({ ref, commit: tree.value.trim(), how: "empty-tree" });
}

/** The working tree for the active feature; otherwise the last commit that recorded the feature. */
export async function resolveEnd(
  root: string,
  featureDir: string,
  active: boolean,
): Promise<Result<MapEnd>> {
  if (active) return ok({ how: "working-tree" });
  const last = await git(root, ["log", "-1", "--format=%H", "--", `${featureDir}/`]);
  const commit = last.ok ? last.value.trim() : "";
  return ok(commit ? { how: "feature-end", commit } : { how: "working-tree" });
}

export async function featureDiff(
  root: string,
  base: MapBase,
  end: MapEnd,
  blockedPaths: readonly string[],
): Promise<Result<FeatureDiff>> {
  const commit = base.commit ?? base.ref;
  const range = end.how === "feature-end" && end.commit ? [commit, end.commit] : [commit];
  const patch = await git(root, [
    "-c",
    "core.quotePath=false",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "-U3",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    ...range,
    "--",
  ]);
  if (!patch.ok) return patch;
  const notes: string[] = [];
  if (/^\[VISP: output truncated\]$/m.test(patch.value))
    notes.push("The diff exceeded 8 MiB; files past the cut are missing.");
  const parsed = parseUnifiedDiff(patch.value);
  if (end.how === "working-tree") {
    const untracked = await untrackedFiles(root);
    if (untracked.ok) parsed.push(...untracked.value);
    else notes.push(`Untracked files could not be listed: ${untracked.error.message}`);
  }
  const shown = (path: string) =>
    !path.startsWith(".visp/") &&
    !INSTRUCTION_FILES.test(path) &&
    !privatePath(path) &&
    !privatePath(path, blockedPaths);
  const visible = parsed.filter((file) => shown(file.path));
  visible.sort((a, b) => a.path.localeCompare(b.path));
  return ok({
    files: visible.slice(0, MAX_FILES),
    omittedFiles: Math.max(0, visible.length - MAX_FILES),
    hiddenFiles: parsed.filter((file) => !file.path.startsWith(".visp/")).length - visible.length,
    notes,
  });
}

async function untrackedFiles(root: string): Promise<Result<ParsedFile[]>> {
  const listed = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (!listed.ok) return listed;
  const files = new ProjectFileSystem(root);
  const paths = listed.value
    .split("\0")
    .filter(Boolean)
    .slice(0, MAX_FILES + 1);
  return ok(await Promise.all(paths.map((path) => untrackedFile(files, path))));
}

/** A new file as one added hunk; binary or over 1 MiB, it is listed without lines. */
async function untrackedFile(files: ProjectFileSystem, path: string): Promise<ParsedFile> {
  const metadata = await files.readMetadata(path);
  const size = metadata.ok && metadata.value?.type === "file" ? metadata.value.size : undefined;
  const bytes =
    size !== undefined && size <= MAX_UNTRACKED_BYTES
      ? await files.readBytesIfExists(path)
      : undefined;
  const content = bytes?.ok ? bytes.value : undefined;
  if (!content || !isUtf8(content) || content.includes(0))
    return { path, status: "added", added: 0, removed: 0, binary: true, hunks: [] };
  const text = Buffer.from(content).toString("utf8");
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const header = `@@ -0,0 +1,${lines.length} @@`;
  return {
    path,
    status: "added",
    added: lines.length,
    removed: 0,
    binary: false,
    hunks: lines.length
      ? [
          boundedHunk({
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: lines.length,
            header,
            lines: lines.map((line) => `+${line}`),
          }),
        ]
      : [],
  };
}

/** Parses `git diff` patch text into files and hunks. Pure, so it is tested without git. */
export function parseUnifiedDiff(text: string): ParsedFile[] {
  return text
    .split(/^(?=diff --git )/m)
    .filter((block) => block.startsWith("diff --git "))
    .map((block) => parseFileBlock(block.replace(/\n$/, "").split("\n")))
    .filter((file): file is ParsedFile => file !== undefined);
}

type RawHunk = Omit<UiMapHunk, "omittedLines">;
const HUNK_RANGE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseFileBlock(lines: readonly string[]): ParsedFile | undefined {
  const firstHunk = lines.findIndex((line) => HUNK_RANGE.test(line));
  const header = firstHunk < 0 ? lines : lines.slice(0, firstHunk);
  const oldPath = pathAfter(header, "--- ", "a/");
  const newPath = pathAfter(header, "+++ ", "b/");
  const path = newPath ?? oldPath ?? headerPath(lines[0] ?? "");
  if (!path) return undefined;
  const hunks = firstHunk < 0 ? [] : parseHunks(lines.slice(firstHunk));
  const counted = (sign: string) =>
    hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith(sign)).length, 0);
  const deleted = header.some((line) => line.startsWith("deleted file mode"));
  const created = header.some((line) => line.startsWith("new file mode"));
  return {
    path,
    status: deleted ? "deleted" : created ? "added" : "modified",
    added: counted("+"),
    removed: counted("-"),
    binary: header.some((line) => line.startsWith("Binary files ")),
    hunks: hunks.map(boundedHunk),
  };
}

function pathAfter(header: readonly string[], marker: string, prefix: string) {
  const line = header.find((entry) => entry.startsWith(marker));
  return line === undefined ? undefined : diffPath(line.slice(marker.length), prefix);
}

function parseHunks(lines: readonly string[]): RawHunk[] {
  const hunks: RawHunk[] = [];
  for (const line of lines) {
    const range = HUNK_RANGE.exec(line);
    if (range)
      hunks.push({
        oldStart: Number(range[1]),
        oldLines: range[2] === undefined ? 1 : Number(range[2]),
        newStart: Number(range[3]),
        newLines: range[4] === undefined ? 1 : Number(range[4]),
        header: line,
        lines: [],
      });
    else if (/^[ +\\-]/.test(line)) (hunks.at(-1)?.lines as string[] | undefined)?.push(line);
  }
  return hunks;
}

function boundedHunk(hunk: RawHunk): ParsedHunk {
  return {
    ...hunk,
    lines: hunk.lines.slice(0, MAX_HUNK_LINES),
    omittedLines: Math.max(0, hunk.lines.length - MAX_HUNK_LINES),
    ...changedLines(hunk),
    digest: sha256(`${hunk.header}\n${hunk.lines.join("\n")}`).slice(0, 16),
  };
}

/** Blank lines count only in a hunk that changes nothing else, so spacing never seeds a node. */
function changedLines(hunk: RawHunk) {
  const lines = { added: [] as number[], removed: [] as number[] };
  const blank = { added: [] as number[], removed: [] as number[] };
  let line = hunk.newStart;
  for (const text of hunk.lines) {
    const into = text.slice(1).trim() === "" ? blank : lines;
    if (text.startsWith("+")) into.added.push(line++);
    else if (text.startsWith("-")) into.removed.push(Math.max(1, line));
    else if (text.startsWith(" ")) line += 1;
  }
  const chosen = lines.added.length + lines.removed.length > 0 ? lines : blank;
  return { addedAt: chosen.added, removedAt: chosen.removed };
}

/** The page's shape of a parsed file. */
export function uiFile(file: ParsedFile): UiMapFile {
  return {
    ...file,
    hunks: file.hunks.map(
      ({ addedAt: _added, removedAt: _removed, digest: _digest, ...hunk }) => hunk,
    ),
  };
}

/** `a/x`, `"a/x y"` or `/dev/null` (undefined). */
function diffPath(raw: string, prefix: string): string | undefined {
  const value = unquote(raw.replace(/\t$/, ""));
  if (value === "/dev/null") return undefined;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/** The new path from `diff --git a/x b/x`, for entries with no `---`/`+++` lines (binary, mode). */
function headerPath(line: string): string | undefined {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const end = closingQuote(rest);
    const second = rest.slice(end + 2);
    return diffPath(second, "b/");
  }
  const half = (rest.length - 1) / 2;
  const candidate = rest.slice(half + 1);
  return Number.isInteger(half) && rest.slice(0, half).slice(2) === candidate.slice(2)
    ? candidate.slice(2)
    : undefined;
}

function closingQuote(text: string): number {
  for (let index = 1; index < text.length; index += 1) {
    if (text[index] === "\\") index += 1;
    else if (text[index] === '"') return index;
  }
  return text.length - 1;
}

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", '"': '"', "\\": "\\" };

/** Git's C-style quoting, for the characters core.quotePath=false still escapes. */
function unquote(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  return value
    .slice(1, -1)
    .replace(/\\([0-7]{3}|.)/g, (_, code: string) =>
      code.length === 3 ? String.fromCharCode(Number.parseInt(code, 8)) : (ESCAPES[code] ?? code),
    );
}
