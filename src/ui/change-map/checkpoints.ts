import { candidatePath } from "../../workflow/product/candidate.js";
import { baselineObjects } from "../../workflow/product/review/review-diff.js";
import type { ProductRecord } from "../../workflow/product/store.js";
import type { WorkspaceState } from "../../workflow/state.js";
import type { MapBase, MapEnd } from "./diff.js";

/** Per changed file: slices whose checkpoint saw it change, and whether it changed after them. */
export interface FileHistory {
  readonly slices: readonly string[];
  readonly afterCheckpoints: boolean;
}

interface CapturedFile {
  readonly path: string;
  readonly content: string | null;
  readonly omitted?: boolean;
}

const MAX_CANDIDATE_BYTES = 32 * 1024 * 1024;

/**
 * Walks the slice checkpoints in order and compares each captured file with the content before
 * it (the base first). Per file, not per line; a checkpoint that did not capture a file says
 * nothing about it.
 */
export async function checkpointHistory(
  state: WorkspaceState,
  record: ProductRecord,
  paths: readonly string[],
  base: MapBase,
  end: MapEnd,
): Promise<{
  files: ReadonlyMap<string, FileHistory>;
  checkpointed: ReadonlySet<string>;
  notes: string[];
}> {
  const checkpoints = record.state.checkpoints ?? [];
  const files = new Map<string, FileHistory>();
  const notes: string[] = [];
  if (!checkpoints.length || !paths.length) return { files, checkpointed: new Set(), notes };
  const root = state.paths.root;
  const before = await baselineObjects(
    root,
    paths.map((path) => (base.how === "empty-tree" ? undefined : `${base.commit}:${path}`)),
  );
  const after =
    end.how === "feature-end" && end.commit
      ? await baselineObjects(
          root,
          paths.map((path) => `${end.commit}:${path}`),
        )
      : await Promise.all(paths.map((path) => workingBytes(state, path)));
  const captured = new Map<string, ReadonlyMap<string, CapturedFile>>();
  for (const checkpoint of checkpoints) {
    const read = await readCaptured(state, record.brief.feature, checkpoint.candidate);
    if (read) captured.set(checkpoint.candidate, read);
    else notes.push(`The checkpoint of ${checkpoint.task} could not be read.`);
  }
  for (const [position, path] of paths.entries())
    files.set(path, fileHistory(path, before[position], after[position], checkpoints, captured));
  return { files, checkpointed: new Set(checkpoints.map((entry) => entry.task)), notes };
}

type Checkpoint = NonNullable<ProductRecord["state"]["checkpoints"]>[number];

function fileHistory(
  path: string,
  before: Buffer | undefined,
  after: Buffer | undefined,
  checkpoints: readonly Checkpoint[],
  captured: ReadonlyMap<string, ReadonlyMap<string, CapturedFile>>,
): FileHistory {
  let previous = before;
  let seen = false;
  const slices = new Set<string>();
  for (const checkpoint of checkpoints) {
    const file = captured.get(checkpoint.candidate)?.get(path);
    if (!file || file.omitted) continue;
    const content = file.content === null ? undefined : Buffer.from(file.content, "base64");
    if (!sameBytes(previous, content)) slices.add(checkpoint.task);
    previous = content;
    seen = true;
  }
  return { slices: [...slices], afterCheckpoints: seen && !sameBytes(previous, after) };
}

async function workingBytes(state: WorkspaceState, path: string): Promise<Buffer | undefined> {
  const read = await state.files.readBytesIfExists(path);
  return read.ok && read.value ? Buffer.from(read.value) : undefined;
}

const sameBytes = (a: Buffer | undefined, b: Buffer | undefined) =>
  a === undefined || b === undefined ? a === b : a.equals(b);

/** Only the captured files; a candidate that cannot be read is reported, never guessed. */
async function readCaptured(
  state: WorkspaceState,
  feature: string,
  id: string,
): Promise<ReadonlyMap<string, CapturedFile> | undefined> {
  if (!/^CAN-[a-f0-9]{32}$/.test(id)) return undefined;
  const path = candidatePath(state, feature, id);
  const metadata = await state.files.readMetadata(path);
  if (!metadata.ok || !metadata.value || metadata.value.size > MAX_CANDIDATE_BYTES)
    return undefined;
  const text = await state.files.readText(path);
  if (!text.ok) return undefined;
  try {
    const parsed = JSON.parse(text.value) as { id?: unknown; files?: unknown };
    if (parsed.id !== id || !Array.isArray(parsed.files)) return undefined;
    const files = new Map<string, CapturedFile>();
    for (const file of parsed.files as CapturedFile[])
      if (
        typeof file?.path === "string" &&
        (typeof file.content === "string" || file.content === null)
      )
        files.set(file.path, file);
    return files;
  } catch {
    return undefined;
  }
}
