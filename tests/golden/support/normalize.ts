import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { BUILD_ID, VERSION } from "../../../src/core/version.js";

/**
 * Makes agent-visible text comparable across runs and machines, and nothing more. Only values
 * that differ between two runs of the same scenario are replaced: paths that hold the run's
 * temporary directories or this machine's tools, clock values, random identifiers, hashes of
 * those, and the build identity. Every replacement keeps its kind in the token (`<TIME>`,
 * `<UUID-2>`), and repeated values keep one number per snapshot, so a change that makes two
 * references diverge, or one value move, still shows in the snapshot.
 */
export interface NormalizeContext {
  /** Absolute paths to replace, most specific first, with the token that names them. */
  readonly paths?: readonly (readonly [string, string])[];
}

const REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");

export function normalize(text: string, context: NormalizeContext = {}): string {
  let result = text;
  for (const [path, token] of pathReplacements(context)) result = replacePath(result, path, token);
  result = result
    .replaceAll(BUILD_ID, "<BUILD-ID>")
    .replace(versionPattern(), "<VERSION>")
    // Temporary directories made per call: a prefix and the six random characters of mkdtemp.
    .replace(/(<TMP>\/[a-z]+(?:-[a-z]+)*-)[A-Za-z0-9]{6}(?![A-Za-z0-9])/g, "$1<RAND>")
    .replace(
      /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})\b/g,
      "<TIME>",
    )
    // Check run times: an execution's and its flip check's (structured content and --json),
    // and the flip check's extra time as a field and in the reviewer's evidence excerpt.
    .replace(
      /("(?:durationMs|flipDurationMs|flipExtraMs|elapsedMs|checkTimeMs|regressionGateMs)"\s*:\s*)\d+/g,
      "$1<N>",
    )
    // The evidence record's time line in visp pr, as text and inside the --json markdown.
    .replace(/- Time: (?:(?!\\n)[^\n])*/g, (line) =>
      line.replace(/\d+(?:\.\d+)? (?:ms|s|min|h)(?: \d+ (?:s|min))?/g, "<DURATION>"),
    )
    .replace(/(Flip check extra time: )\d+( ms)/g, "$1<N>$2")
    // A prepared critic attempt's deadline, and the size of a packet that embeds clock values.
    .replace(/("expiresAt"\s*:\s*)\d{12,}/g, "$1<EPOCH-MS>")
    .replace(/("packetBytes"\s*:\s*)\d+/g, "$1<N>");
  result = commitIds(result);
  result = numbered(result, /\bCAN-[a-f0-9]{32}\b/g, "CAN");
  result = numbered(
    result,
    /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/g,
    "UUID",
  );
  result = numbered(result, /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/g, "SHA256");
  // Hash-derived IDs (`FB-…`, `CODE-DIFF-…`) whatever their digits; elsewhere a hex run must
  // hold a letter, so long decimal numbers are left alone. Boundaries are "not hex" rather than
  // \b, so a value right after an escaped newline (`\nd0b0…`) is still found.
  result = numbered(
    result,
    /(?<=\b[A-Z]+(?:-[A-Z]+)*-)[0-9a-f]{12,39}(?![0-9a-f])|(?<![0-9a-f])(?=[0-9]*[a-f])[0-9a-f]{12,39}(?![0-9a-f])/g,
    "HEX",
  );
  return result;
}

/**
 * Abbreviated commit IDs, only where VISP lists later commits as "<id> <subject>": after
 * "(newest first):" as "- " lines, after "LATER CHANGES:" as plain lines (in text or inside
 * a JSON string), and in the laterChanges JSON arrays. An ID can be all digits.
 */
function commitIds(text: string): string {
  const seen = new Map<string, number>();
  const id = (value: string) => token(seen, value, "COMMIT");
  const NEWLINE = String.raw`(?:\n|\\n)`;
  const list = (header: string, item: string) =>
    new RegExp(`(${header})((?:${NEWLINE}${item}[0-9a-f]{7,12} (?:(?!${NEWLINE})[^"])*)+)`, "g");
  const entries = (item: string) => new RegExp(`(${NEWLINE}${item})([0-9a-f]{7,12})(?= )`, "g");
  return text
    .replace(
      list(String.raw`\(newest first\):`, "- "),
      (_, header, items: string) =>
        header + items.replace(entries("- "), (_m, lead, value) => lead + id(value)),
    )
    .replace(
      list("LATER CHANGES:", ""),
      (_, header, items: string) =>
        header + items.replace(entries(""), (_m, lead, value) => lead + id(value)),
    )
    .replace(
      /("(?:projectMemoryLaterChanges|laterChanges)"\s*:\s*\[)([^\]]*)/g,
      (_, key, items) =>
        key +
        items.replace(
          /(")([0-9a-f]{7,12})(?= )/g,
          (_m: string, quote: string, value: string) => quote + id(value),
        ),
    );
}

function pathReplacements(context: NormalizeContext): (readonly [string, string])[] {
  const machine: [string, string][] = [
    [REPOSITORY, "<REPO>"],
    [process.execPath, "<NODE>"],
    [realpathSync(process.execPath), "<NODE>"],
    [tmpdir(), "<TMP>"],
    [realpathSync(tmpdir()), "<TMP>"],
    [homedir(), "<HOME>"],
  ];
  const all = [...(context.paths ?? []), ...machine];
  // Longer paths first, so a workspace inside the temporary directory keeps its own token.
  return [...new Map(all.filter(([path]) => path.length > 1)).entries()].sort(
    ([left], [right]) => right.length - left.length,
  );
}

/** Replaces a path both as written and as escaped inside JSON text. */
function replacePath(text: string, path: string, token: string): string {
  const escaped = JSON.stringify(path).slice(1, -1);
  return text.replaceAll(path, token).replaceAll(escaped, token);
}

function versionPattern(): RegExp {
  const escaped = VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w.-])${escaped}(?![\\w-])`, "g");
}

/** The same value keeps one number within one snapshot, in order of first appearance. */
function numbered(text: string, pattern: RegExp, kind: string): string {
  const seen = new Map<string, number>();
  return text.replace(pattern, (value) => token(seen, value, kind));
}

function token(seen: Map<string, number>, value: string, kind: string): string {
  let index = seen.get(value);
  if (index === undefined) {
    index = seen.size + 1;
    seen.set(value, index);
  }
  return `<${kind}-${index}>`;
}
